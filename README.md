# dsh-multiagent-guard

> 多 agent 协作的硬约束层：只读角色工具级白名单、上下文预算标记、子 agent 超时真中断、协作度量。

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，把「多智能体协作规范」里**宿主层能真正落地**的四项做成运行期硬约束。

它不造团队、不派任务 —— 它管的是**团队不越界、不空转、不超支、可度量**。

---

## 为什么需要它

DSH 的 preset 层已经能给 `scout` / `reviewer` 这类只读角色摘掉 `bash`、关掉 `tool-fs` 的 write/edit。但这只是**声明式的**：

- 谁把 `applyPatch` 打开，隔离立刻失效；
- 经 `run_code` / `ops_bash` 间接写文件，预设层看不见；
- 子 agent 超时后"停手"只是主 agent 放弃等待，子 agent 还在烧 token；
- 一次协作花了多少、哪个子 agent 最慢、有没有被中断 —— 没有统一口径。

这个插件在**工具调度层**补上这四件事，是预设层的兜底，而不是替代。

---

## 四项能力

### S3 只读角色工具级白名单

用 `ctx.tools.guard()` 在工具执行前拦截：若调用者是 `scout` / `reviewer` 这类只读 preset，且目标工具在拒绝名单里，直接返回拒绝理由，工具体不执行。

```js
// lib/index.js:100
return ctx.tools.guard((exec) => {
  if (exec.agent === undefined) return undefined
  if (!denied.has(exec.name)) return undefined
  const preset = presetOf(exec.agent)
  if (preset === undefined || !readOnly.has(preset)) return undefined
  return 'agent preset "' + preset + '" 是只读角色，不能调用 "' + exec.name + '"。' +
    '只读角色只负责读和判断：结论写进回复，改动交回主 agent。'
})
```

- guard 是**同步、单调、不可翻案**的：注册后无法被后续代码撤销。
- 拦截发生在执行前，`run_code` 里间接调用的写操作同样被拦（因为走的是同一个工具调度）。
- 默认拒绝：`write`、`edit`、`apply_patch`、`bash`、`ops_bash`、`pwsh`、`run_code`、`subagent`、`subagent_fork`、`spawn_teammate`。

### C5 上下文预算标记

挂在 `tools/post-execute`，在工具结果超过预算时，**不截断数据**，而是通过 `additionalContexts` 通道往下一条消息里塞一句指令：只保留三条结论、原文回读。

```js
// lib/index.js:148
return ctx.on('tools/post-execute', async (exec, result, next) => {
  ...
  additionalContexts: [...(decision.additionalContexts ?? []), budgetNotice(chars, budget, isChild)]
})
```

为什么不截断：截断会让模型拿着半截证据下结论。标记则让它知道自己看到的是摘要，需要时回去读原文。

- 子 agent 阈值默认 8000 字符，主 agent 16000。

### C4 超时真中断

监听 `subagent/start` / `subagent/end`，为每个子 agent 起看门狗。超过 `stallTimeoutMs`（默认 10 分钟）就调：

```js
ctx.subagents.interrupt(childId, { kind: 'ancestor', agent: parentAgent })
```

这是**真停止**，不是"主 agent 不等了"。区别在于：放弃等待后子 agent 仍在跑、仍在烧 token；`interrupt` 会真的把它的执行链掐断。

### O1 每轮度量

`collab_stats` 工具：派了几次子 agent、各自耗时、怎么结束的、有没有被看门狗中断。`detail: 'full'` 给逐条明细。

```
总耗时 182s，平均 61s，最慢 94s（reviewer → 3f9a2c）
结束原因：completed 2 / watchdog-interrupt 1
```

收尾时取一次，用来回答「这轮协作花了多少」。

---

## 安装

包未发布到 npm registry，从 GitHub Release 的 tarball 或仓库直接装配。

### 方式一：Release tarball（推荐，公开只读）

```bash
# 在 profile 目录执行（Desktop 首次启动后生成；目录名按你的实际 profile）
cd ~/.dsh/profiles/desktop

# pnpm 直接吃 https tarball，无需登录
pnpm add https://github.com/kaokxoas/dsh-multiagent-guard/releases/download/v0.1.0/dsh-multiagent-guard-0.1.0.tgz
```

然后把包名加进 `dsh.profile.bundles`：

```jsonc
// ~/.dsh/profiles/desktop/package.json
"dsh": { "profile": { "bundles": [ /* ... 已有项 ..., */ "dsh-multiagent-guard" ] } }
```

重启 DSH 后 `cordis.patch.yml` 里的 insert 生效。

### 方式二：从仓库 clone

```bash
git clone https://github.com/kaokxoas/dsh-multiagent-guard.git
cd dsh-multiagent-guard
```

再按方式一的两步装配（`pnpm add <本地绝对路径>` 代替 tarball URL）。

### 方式三：本地开发态

```bash
# 需装 dsh-super-injector；在会话里执行（不写 profile）：
dev_inject_plugin <本目录绝对路径>
```

开发态走运行时注入，不进 `dsh.profile.bundles`，插件管理页看不到它。

装配后 `cordis.patch.yml` 里的 insert 进入 loader：

```yaml
- insert:
    - id: dsh-multiagent-guard
      name: "dsh-multiagent-guard"
      config: {}
```


## 配置

注入器固定传 `config: {}`，所以默认值写死在代码里，可用环境变量覆盖：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_GUARD_READONLY_PRESETS` | `scout,reviewer` | 只读角色的 preset id，逗号分隔 |
| `DSH_GUARD_READONLY_DENY` | `write,edit,apply_patch,bash,ops_bash,pwsh,run_code,subagent,subagent_fork,spawn_teammate` | 只读角色被拒的工具名 |
| `DSH_GUARD_CHILD_BUDGET` | `8000` | 子 agent 结果字符预算 |
| `DSH_GUARD_LEAD_BUDGET` | `16000` | 主 agent 结果字符预算 |
| `DSH_GUARD_STALL_MS` | `600000` | 子 agent 停滞判定阈值（毫秒） |
| `DSH_GUARD_WATCHDOG_MS` | `20000` | 看门狗轮询间隔（毫秒） |
| `DSH_GUARD_INTERRUPT` | `on` | 设 `off` 则只记录不中断 |
| `DSH_GUARD_STATS_CAPACITY` | `200` | 度量条数上限（LRU 淘汰已完成的） |

也可以走 `apply(ctx, userConfig)` 传入，会覆盖默认值。

---

## 兼容性

- 依赖 `ctx.tools`（必需）、`ctx.subagents` / `agentPresets` / `ctx.on`（按需软取，缺了自动降级）。
- `inject = ['tools']` —— 只有 `tools` 是硬依赖，其余服务不存在时对应能力静默跳过，不会让插件启动失败。
- 在 DSH `0.2.2-rc.2` 上验证通过（桌面版 + profile `desktop`）。

---

## 与 `@nanmicoder/dsh-agent-teams` 的关系

两者是**互补**，不是竞争：

| | 本插件 | agent-teams |
|---|---|---|
| 职责 | 约束层（守） | 组织层（建） |
| 做什么 | 拒越界工具、掐超时、标预算、记度量 | 建团、成员、任务 DAG、质量环、邮箱 |
| 工具数 | 1（`collab_stats`） | 14（`agent_teams_*`） |
| 是否需要对方 | 不需要 | 不需要 |

组合使用即「组织 + 约束」双层。注意：当 agent-teams 的 member 以 `scout` / `reviewer` preset 运行时，本插件的 S3 守卫会正常拦截其写操作 —— 这是预期行为。

---

## 已知边界

- 度量数据存在内存（`Map`），进程重启即丢。要做长周期统计需要外接落盘。
- 只读守卫依赖 `agentPresets.presetForSession()` 能解析出 preset id；解析不到时放行（宁可少拦，不可错拦主 agent）。
- 上下文预算标记依赖宿主 `tools/post-execute` 支持 `additionalContexts` 通道。不支持的宿主版本上该能力静默失效。

---

## License

MIT

---

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
