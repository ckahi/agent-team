# 分析：DSH 主聊天框内置斜杠命令能否用于 agent-team 工作台

本文回答一个具体问题：主聊天框里的内置指令（`/compact`、`/plan`、`/permission`、`/goal` 等）能否在 agent-team 团队工作台的对话输入框里使用。结论先行：**宿主侧完全可行——命令注册表是对所有 agent 开放的服务，插件可以直接调用；目前不可用纯粹是工作台 composer 自己没接这条线。** 以下是基于 dsh-v0.1.5-rc.1 宿主源码的完整分析。

## 1. 官方斜杠命令的完整机制

### 1.1 命令是什么：注册表里的定义，不是聊天文本

宿主有一个专门的命令系统，`packages/interaction/commands`（服务名 `commands`，导出类 `CommandRuntime`）。内置命令是普通宿主插件向它注册的定义：

- `/compact` 来自 `packages/compaction/command-compact`：`apply()` 里 `ctx.commands.register({ name: 'compact', description: 'Compact older conversation history', handler })`（index.ts 100–104 行）。handler 直接调 `ctx.compaction.compactNow(invocation.agent, ...)`，根本不经过模型。
- 宿主当前内置命令全集：`compact`、`echo`、`goal`、`permission`、`plan`（见 `packages/client/connection/tests/fixture-commands.client.spec.ts:27` 的断言）。

关键性质（`commands/src/index.ts` 253–257 行的类注释）：**普通上下文注册的是全局命令；通过 agent 上下文子层注册的命令只对该 agent 生效（scoped shadow）**。`/compact` 是全局注册，所以**每个 agent——包括 agent-team 的成员——都能解析到它**（`find(agent, 'compact')` 按成员 agent 查询即命中）。

### 1.2 执行入口：`commands.execute(agent, line, attachments, signal)`

`CommandRuntime.execute`（index.ts 356 行起，`@Remote` 方法）做完整的一条命令执行：

1. `parseCommand(line)` 解析 `/name args` 语法；解析失败或命令名不存在 → 返回 `undefined`（**不落任何日志**）
2. 命中后先向**成员的会话日志**追加 `command/run`，调 handler，结束再追加 `command/done`——命令执行是会话历史的一部分
3. 返回 `CommandExecution`（含 `result.kind: 'success' | 'error'` + 人类可读 text）

这意味着：**插件在 host 侧拿到成员的 Agent 对象后，一行 `commands.execute(agent, '/compact', [], signal)` 就能替成员执行官方命令**。compact 的"agent 必须空闲"约束由 compaction seam 自己报错（`busy` → `CommandResult error`），不需要调用方预判。

### 1.3 主聊天框的 `/` 菜单是怎么接上的

主界面 composer 的斜杠菜单是 client 侧 `ui-commands` / `ui-input-trigger` 包的能力：composer 检测到 `/` 前缀时调 `commands.list(agent)` 拉描述列表渲染菜单，提交时调 `commands.execute`。这是**官方 composer 的功能**，跟会话本身无关——任何接了这两个包的 composer 都天然获得全部命令。

## 2. 为什么工作台的 `/` 没有反应

agent-team 工作台的 composer 是自绘的（`ConversationColumn.tsx` 451 行起），它只实现了一套私有触发器（`src/client/composer-triggers.ts`）：

- `/` → **Skill 候选**：仅当该成员助手模板的 `skillAllowlist` 里有 `userInvocable` 的技能时才出候选；没有匹配就显示"当前成员没有匹配的已加载 Skill"或干脆无菜单
- `@` → Workspace 文件候选

它**从不查询宿主的 commands 注册表**，提交时走 `team.message.send` → `agent.followup`，把整行文本当普通消息发给模型。所以输入 `/compact` 的下场是：模型收到一条字面为 `/compact` 的消息（成员提示词里没有任何指令语法说明，多半被当成普通文本处理），命令系统全程不知情。

一句话：**不是宿主不开放，是工作台没接。**

## 3. 可行性判定与两条实施路径

### 路径 A（推荐）：工作台 composer 接入官方命令系统

改动分三块，全部在插件内部，不碰宿主：

1. **Host RPC**：transport 层加 `team.command.execute`（payload: teamId, slotId, line）+ `team.command.list`（返回该成员可用的 `CommandDescriptor[]`）。实现里 `ctx.get('commands')` 拿 `CommandRuntime`（需在 inject 列表加 `'commands'`），用 `requireOwned(sessionId).handle.agent` 调 `list` / `execute`，signal 用 RPC 请求的 abort signal。
2. **Client composer**：`/` 触发时先查命令候选（`commands.list` 结果过滤 `query` 前缀），与现有 Skill 候选合并渲染（菜单分两组：命令 / Skills）；提交时若整行匹配 `/<name> ...` 且 name 命中命令表 → 走 `team.command.execute`，把 `CommandExecution.result.text` 作为一条系统 notice 渲染进对话列；否则维持现有发消息路径。
3. **投影补丁**：`conversation-projector.ts` 的 `isVisibleUserSource`（252 行）目前只放行 `user` 和本插件 relay 来源——**compact 产生的摘要消息（source: `{kind:'plugin', plugin:'compact'}`）不会出现在工作台对话里**，上下文占用数字（`projectContextUsage`）会如实下降。建议同时放行 compaction 来源并渲染一条简洁的"已压缩 N 条历史"节点，否则用户看不到命令生效的直观证据。

### 路径 B（最小验证）：只透传 `/compact`

不加菜单，只在 `team.message.send` 的 host 入口截一道：整行匹配已知命令名 → 转发 `commands.execute`。半天工作量，但没有菜单发现性，仅作为快速验证命令链路的临时手段。

### 两个注意边界

- **命令执行的身份是成员本人**：`execute(agent, ...)` 的副作用（`command/run`/`command/done` 日志、compaction）都落在成员会话上。leader 在工作台对成员输入 `/compact` = 替该成员压缩上下文，这个语义要在 UI 上表达清楚（比如菜单项标注"对 {成员名} 执行"）。
- **`/permission`、`/plan`、`/goal` 的 UI 依赖**：这几个命令在主界面有配套的交互面板（权限切换、plan mode 审批等），部分效果依赖官方 composer/会话视图的状态组件。工作台接过来后命令能执行、结果文本能显示，但配套的交互面板不会出现——第一批建议只放行 `compact`（以及无 UI 依赖的 `echo`），其余按需评估。

## 4. 结论

| 问题 | 答案 |
|---|---|
| 内置命令对成员 agent 可用吗 | 可用。命令注册表按 agent 解析，全局命令对所有成员生效 |
| 工作台现在能用吗 | 不能。composer 不查命令注册表，`/` 只触发私有 Skill/文件候选 |
| 插件能自己接上吗 | 能。`commands` 是普通 Cordis 服务，`list`/`execute` 均可直接调用，无需宿主改动 |
| 有哪些坑 | compaction 摘要在工作台投影不可见（需补 isVisibleUserSource）；agent 忙碌时 compact 报 busy；`/permission` 等命令的配套 UI 面板不会出现 |
