/**
 * @dsh-external/dsh-multiagent-guard
 *
 * 把《多Agent协作-完整方案》能力清单里宿主层能落地的四项，做成 DSH 运行期硬约束：
 *
 *  S3 只读角色工具级白名单 —— ctx.tools.guard()（同步、单调、不可翻案）对 scout /
 *     reviewer 这类只读 preset 拒绝任何写/执行类工具。预设层只做到「不注册 bash +
 *     tool-fs 关 write/edit」，一旦谁把 applyPatch 打开、或经 run_code / ops_bash
 *     间接写，隔离立刻失效；guard 是这一层的兜底。
 *
 *  C5 上下文预算标记 —— tools/post-execute 的 additionalContexts 通道，在结果超预算时
 *     往下一步塞一条「只保留三条结论，原文回读」的指令，而不是截断数据（截断会让模型
 *     拿着半截证据下结论）。
 *
 *  C4 超时真中断 —— 子 agent 跑过阈值用 ctx.subagents.interrupt(childId,
 *     { kind: 'ancestor', agent: parentAgent }) 真停掉，替代 skill 里「10 分钟还在
 *     running 就停手」（那是放弃不是停止，子 agent 还在烧 token）。
 *
 *  O1 每轮度量 —— 派了几次、各多久、怎么结束、有没有被中断，落成工具 collab_stats。
 *
 * 注入器固定传 config:{}，所以默认值写死在这里，DSH_GUARD_* 环境变量可覆盖。
 */

export const name = '@dsh-external/dsh-multiagent-guard'

/** 只需要工具服务；预设注册表 / 子 agent / agent 注册表按需软取，缺了自动降级。 */
export const inject = ['tools']

/* ------------------------------------------------------------------ 默认值 */

function envOf(key, fallback) {
  const raw = process.env[key]
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim()
}

function envList(key, fallback) {
  const raw = envOf(key, '')
  if (raw === '') return fallback
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

const config = {
  readOnlyPresets: envList('DSH_GUARD_READONLY_PRESETS', ['scout', 'reviewer']),
  readOnlyDeniedTools: envList('DSH_GUARD_READONLY_DENY', [
    'write',
    'edit',
    'apply_patch',
    'bash',
    'ops_bash',
    'pwsh',
    'run_code',
    'subagent',
    'subagent_fork',
    'spawn_teammate'
  ]),
  childBudgetChars: Number(envOf('DSH_GUARD_CHILD_BUDGET', 8000)) || 8000,
  leadBudgetChars: Number(envOf('DSH_GUARD_LEAD_BUDGET', 16000)) || 16000,
  stallTimeoutMs: Number(envOf('DSH_GUARD_STALL_MS', 600000)) || 600000,
  watchdogIntervalMs: Number(envOf('DSH_GUARD_WATCHDOG_MS', 20000)) || 20000,
  interruptStalled: envOf('DSH_GUARD_INTERRUPT', 'on') !== 'off',
  statsCapacity: Number(envOf('DSH_GUARD_STATS_CAPACITY', 200)) || 200
}

/* -------------------------------------------------------------- 运行时状态 */

const runs = new Map()
let watchdogInterrupts = 0
let watchdogErrors = 0

function remember(entry) {
  runs.set(entry.runId, entry)
  if (runs.size <= config.statsCapacity) return
  const finished = [...runs.values()]
    .filter((r) => r.endedAt !== undefined)
    .sort((a, b) => a.startedAt - b.startedAt)
  for (const stale of finished) {
    if (runs.size <= config.statsCapacity) break
    runs.delete(stale.runId)
  }
}

function presetOf(agent) {
  if (agent === undefined || agent === null) return undefined
  const registry = agent.ctx?.get ? agent.ctx.get('agentPresets') : undefined
  if (registry === undefined) return undefined
  try {
    const id = registry.presetForSession(agent.session)
    return id === null ? undefined : id
  } catch {
    return undefined
  }
}

/* ------------------------------------------------------- S3 只读角色硬隔离 */

function installReadOnlyGuard(ctx) {
  const denied = new Set(config.readOnlyDeniedTools)
  const readOnly = new Set(config.readOnlyPresets)

  return ctx.tools.guard((exec) => {
    if (exec.agent === undefined) return undefined
    if (!denied.has(exec.name)) return undefined
    const preset = presetOf(exec.agent)
    if (preset === undefined || !readOnly.has(preset)) return undefined
    return (
      'agent preset "' + preset + '" 是只读角色，不能调用 "' + exec.name + '"。' +
      '只读角色只负责读和判断：结论写进回复，改动交回主 agent。'
    )
  })
}

/* --------------------------------------------------- C5 上下文预算标记 */

function textLengthOf(content) {
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') total += block.text.length
    else total += 200
  }
  return total
}

// additionalContexts 的每一项会被 dsh-agent-loop 原样写进 agent/inbox/spliced 的 inserted，
// 并成为一份会话持久化消息槽。V4 会话格式要求每个消息槽都带 producer-owned source.kind
// （非空字符串且不等于 "plugin"），裸 content block 会让整份会话在下次加载时报
// "format v4 message requires a producer-owned source kind" 而完全打不开。
// 因此这里必须返回完整消息对象，而不是一个 { type, text } 块。
function budgetNotice(chars, budget, isChild) {
  const who = isChild ? '子 agent 单条摘要' : '主 agent 汇总'
  return {
    content: [
      {
        type: 'text',
        text:
          '[协作预算] 上一条结果 ' + chars + ' 字符，超过' + who + '预算 ' + budget + '。' +
          '不要把这整段再抄一遍：只保留不超过三条结论，其余压成一句「细节见原结果」；' +
          '需要原文时按路径或任务板回读，不要凭记忆复述。'
      }
    ],
    source: { kind: 'collab-budget' },
    role: 'user',
    id: globalThis.crypto.randomUUID()
  }
}

function installBudgetMarker(ctx) {
  return ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (decision.kind !== 'accept') return decision
    if (Object.hasOwn(decision, 'value')) return decision
    const content = decision.content ?? result.content
    const chars = textLengthOf(content)
    const isChild = exec.parent !== undefined
    const budget = isChild ? config.childBudgetChars : config.leadBudgetChars
    if (chars <= budget) return decision
    // 必须原样带上 decision 的其余字段：外层策略（如 spill-policy）可能已经改写了 content，
    // 只返回 kind + additionalContexts 会把那次改写丢掉，让超长结果原封不动回到模型。
    return {
      ...decision,
      kind: 'accept',
      additionalContexts: [...(decision.additionalContexts ?? []), budgetNotice(chars, budget, isChild)]
    }
  })
}

/* --------------------------------------- C4 超时真中断 + O1 派发度量 */

function installDispatchMetrics(ctx) {
  const offStart = ctx.on('subagent/start', (info, parent) => {
    remember({
      runId: info.runId,
      childId: info.id,
      provider: info.provider,
      local: info.local,
      parentId: parent === undefined ? undefined : parent.id,
      parentPreset: presetOf(parent),
      startedAt: Date.now(),
      endedAt: undefined,
      durationMs: undefined,
      stopReason: undefined,
      interrupted: false,
      interruptError: undefined
    })
  })

  const offEnd = ctx.on('subagent/end', (info) => {
    const entry = runs.get(info.runId)
    if (entry === undefined) return
    entry.endedAt = Date.now()
    entry.stopReason = info.stopReason
    entry.durationMs = entry.endedAt - entry.startedAt
  })

  const timer = setInterval(() => {
    const agents = ctx.get('agents')
    const subagents = ctx.get('subagents')
    if (agents === undefined || subagents === undefined) return
    const now = Date.now()
    for (const entry of runs.values()) {
      if (entry.endedAt !== undefined) continue
      if (entry.interrupted) continue
      if (now - entry.startedAt < config.stallTimeoutMs) continue
      if (!config.interruptStalled) continue
      entry.interrupted = true
      const parentAgent = entry.parentId === undefined ? undefined : agents.get(entry.parentId)
      if (parentAgent === undefined) {
        entry.interruptError = 'parent agent is no longer live'
        watchdogErrors += 1
        continue
      }
      try {
        subagents.interrupt(entry.childId, { kind: 'ancestor', agent: parentAgent })
        watchdogInterrupts += 1
      } catch (error) {
        entry.interruptError = String(error && error.message ? error.message : error)
        watchdogErrors += 1
        if (ctx.logger && ctx.logger.warn) {
          ctx.logger.warn('multiagent-guard: interrupt ' + entry.childId + ' failed: ' + entry.interruptError)
        }
      }
    }
  }, config.watchdogIntervalMs)
  if (typeof timer.unref === 'function') timer.unref()

  ctx.effect(
    () => () => {
      if (offStart) offStart()
      if (offEnd) offEnd()
      clearInterval(timer)
    },
    'multiagent-guard: lifecycle listeners'
  )
}

/* ----------------------------------------------------- O1 度量读取工具 */

function shortId(id) {
  return typeof id === 'string' ? id.slice(0, 8) : String(id)
}

function formatReport(verbose) {
  const all = [...runs.values()].sort((a, b) => a.startedAt - b.startedAt)
  const done = all.filter((r) => r.endedAt !== undefined)
  const lines = []
  lines.push(
    '派发 ' + all.length + ' 次（完成 ' + done.length + '，进行中 ' + (all.length - done.length) + '）；' +
      '看门狗中断 ' + watchdogInterrupts + ' 次' +
      (watchdogErrors > 0 ? '，中断失败 ' + watchdogErrors + ' 次' : '')
  )
  if (done.length > 0) {
    const total = done.reduce((sum, r) => sum + (r.durationMs || 0), 0)
    let slowest = done[0]
    for (const r of done) if ((r.durationMs || 0) > (slowest.durationMs || 0)) slowest = r
    lines.push(
      '总耗时 ' + Math.round(total / 1000) + 's，平均 ' + Math.round(total / done.length / 1000) + 's，' +
        '最慢 ' + Math.round((slowest.durationMs || 0) / 1000) + 's（' +
        (slowest.parentPreset || 'main') + ' → ' + shortId(slowest.childId) + '）'
    )
    const byReason = new Map()
    for (const r of done) {
      const key = r.stopReason || 'unknown'
      byReason.set(key, (byReason.get(key) || 0) + 1)
    }
    lines.push('结束原因：' + [...byReason].map((pair) => pair[0] + ' ' + pair[1]).join(' / '))
  }
  if (verbose) {
    lines.push('')
    lines.push('runId | 父 preset | 子会话 | 耗时 | 结束原因')
    for (const r of all) {
      const cost = r.durationMs === undefined ? '进行中' : Math.round(r.durationMs / 1000) + 's'
      const end = r.interrupted ? '看门狗中断(' + (r.interruptError || 'ok') + ')' : (r.stopReason || '进行中')
      lines.push([shortId(r.runId), r.parentPreset || 'main', shortId(r.childId), cost, end].join(' | '))
    }
  }
  return lines.join('\n')
}

function installStatsTool(ctx) {
  const definition = {
    name: 'collab_stats',
    description:
      '查看多 agent 协作度量：派了几次子 agent、各自耗时、怎么结束的、有没有被看门狗中断。' +
      '收尾时取一次，用来回答「这轮协作花了多少」；detail=full 给逐条明细。',
    parameters: {
      type: 'object',
      properties: {
        detail: {
          type: 'string',
          enum: ['summary', 'full'],
          description: 'summary 默认；full 附逐条明细'
        }
      },
      additionalProperties: false
    },
    output: {
      schema: {
        type: 'object',
        properties: { report: { type: 'string' } },
        required: ['report'],
        additionalProperties: false
      },
      render(_args, value) {
        return [{ type: 'text', text: value.report }]
      }
    },
    execute(args) {
      const full = args !== undefined && args !== null && args.detail === 'full'
      return Promise.resolve({ report: formatReport(full) })
    }
  }
  return ctx.tools.register(definition)
}

/* ------------------------------------------------------------------ 入口 */

export function apply(ctx, userConfig) {
  if (userConfig && typeof userConfig === 'object') {
    for (const [key, value] of Object.entries(userConfig)) {
      if (value !== undefined) config[key] = value
    }
  }
  installReadOnlyGuard(ctx)
  installBudgetMarker(ctx)
  installDispatchMetrics(ctx)
  installStatsTool(ctx)
  if (ctx.logger && ctx.logger.info) {
    ctx.logger.info(
      'multiagent-guard ready: readOnly=' + config.readOnlyPresets.join(',') +
        ' stall=' + Math.round(config.stallTimeoutMs / 1000) + 's' +
        ' budget=' + config.childBudgetChars + '/' + config.leadBudgetChars
    )
  }
}
