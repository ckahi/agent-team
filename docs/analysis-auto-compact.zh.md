# Agent 主动压缩上下文与占用感知：可行性分析

> 分析基线：deepseek-harness `dsh-v0.1.5-rc.1`（只读参考），agent-team 0.2.13。
> 本文仅为分析记录，不随插件发布，不提交 git。

## 结论

这件事分两层：

1. **"达到阈值自动压缩"宿主已经原生实现**，对 agent-team 的每个成员同样生效，默认不需要插件做任何事。
2. 真正缺的是**"让 agent 看见自己的占用"**——模型侧拿不到任何上下文用量信息。若要"agent 主动感知并触发"，需要插件补一个工具组合，完全可行，但有一个关键时序坑（见 §3）。

## 1. 宿主已有的自动压缩

桌面版装载的压缩实现是 `compaction-basic`，它在默认配置下（`auto: true`）注册两道自动机制（`packages/compaction/compaction-basic/src/index.ts:130-160`）：

| 机制 | 触发点 | 行为 |
|---|---|---|
| 步间压力压缩 | `agent/pre-step`，每一步之间测量压力 | 超过阈值即自动 compact |
| 溢出恢复 | 模型返回 `CONTEXT_WINDOW_EXCEEDED` | 强制压缩，绕过正常阈值 |

阈值策略（`compaction-basic/src/config.ts`）：

- `thresholdRatio`：压力阈值，默认 **0.8**（上下文窗口的 80%）；
- `retainRatio` / `retainTokens`：压缩后保留的尾部，默认 16%；
- 支持 `modelPolicies` 按具体 provider/model 覆盖；
- 单次压缩失败会重试（默认 1 次重试），仍超阈值才告警。

这套监听是全局的，**成员 agent 与主 agent 一视同仁**。也就是说"上下文到 80% 自动压缩"这个目标本身已经达成，插件侧无感。

可调方式：在 DSH 配置里给 `compaction-basic` 行传 `thresholdRatio`（全局）或 `modelPolicies`（按模型）。

## 2. Agent 能否拿到上下文长度和当前占用？

| 侧 | 能拿什么 | 出处 |
|---|---|---|
| Host 侧（插件可读） | 窗口大小：`ctx.llm.resolveModelInfo(provider, model, signal).context.contextWindow` | compaction-basic `src/index.ts:294` 即此用法 |
| Host 侧 | 当前占用：`ctx.tokenMeter.measure(agent.session)` → `totalTokens`（usage 锚点 + 表面增量，压缩后自动回落） | `packages/llm/token-meter/src/index.ts:145` |
| Host 侧 | 会话投影 `contextPressure`：`pressureTokens` / `projectedTokens` / `contextWindow`（UI 侧占用显示用的同一份数据） | `packages/llm/token-meter/src/usage-projection.ts:173` |
| 模型侧 | **什么都拿不到** | `packages/core/system-prompt/src` 中无任何 token/占用注入；模型 prompt 里没有用量信息 |

要点：

- `tokenMeter.measure()` 的 `totalTokens` 是"下一次请求的预计占用"（usage 样本 + 之后的表面增量），压缩发生后会自动下降，适合做阈值判断；
- 窗口大小不是常量：随路由的 provider/model 变化，必须通过 `resolveModelInfo` 现查，不能写死；
- 模型对自己占用的感知为零，"agent 自己发现阈值"无法靠模型自觉成立，必须由插件喂给它。

## 3. 插件能否让 agent 主动触发 compact？——可行，注意时序坑

宿主没有给模型暴露任何 compact 工具，`/compact` 只是人的命令（`command-compact` 仅向 `commands` 注册）。但插件可以自己注册一个工具，链路是通的：

- 工具 execute 收到的 `exec.agent`（`packages/core/tools/src/index.ts:318`）就是调用方 agent；
- `Agent` 实现了 `runMaintenance()`（`packages/core/agent/src/runtime-types.ts:202`）；
- `ctx.compaction.compactNow(agent, signal)` 要求的正是 `ManualCompactAgentContext`（session + options + runMaintenance），真实 agent 全部满足。

**时序坑**：模型是在轮次进行中调工具的，此时 agent 处于 active 状态；`compactNow` 内部通过 `agent.runMaintenance()` 认领 idle 阶段，active 时会**同步抛错**（"already has active work"，即 `busy`）。所以工具不能"当场压缩"，正确做法分两支：

1. agent 空闲 → 直接 `await compactNow(agent, signal)`；
2. agent 忙（轮次中）→ 挂一次性 idle 监听，本轮结束后再执行；工具立即返回"已安排在本轮结束后压缩"。

`busy` 之外的预期失败（`changed` / `summary` / `commit` / `persistence`）参照 `command-compact` 的文案处理即可。

## 4. 若要实施：建议的工具组合

一次交付三个部分，全部落在 team-runtime 的成员 setup 内（沿用 0.2.13 的 agentCtx 作用域经验）：

| 项 | 说明 |
|---|---|
| `team_get_context_usage` | 返回 `{totalTokens, contextWindow, ratio}`，模型可随时自查 |
| `team_compact_context` | 按上文两支逻辑触发压缩；忙时安排延迟执行并明确告知模型 |
| 提示词段（可选） | 告知模型这两个工具的用途与建议用法（预计输出很长、接近长对话尾部时先查再压缩） |

另一个方向是**主动注入**：插件在压力超阈值时往成员会话注入一条提醒，模型自然收敛。两者不互斥，注入可以后做。

## 5. 不建议做的理由清单

- **只做 `team_compact_context` 不做用量工具**：模型不知道占用，触发时机会很随意，工具等于摆设；
- **在工具内直接 `compactNow` 不处理 busy**：轮次中调用必然失败，模型会重试或误判；
- **绕过 `compaction` 服务自己拼摘要**：绕开了持久化锁、表面替换、工具配对校验整套事务语义，不可取。
