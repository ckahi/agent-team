# agent-team 插件开发说明书（二次开发向）

本文面向要在 `@limuyang2/dsh-agent-team` 源码上做二次开发的工程师。目标只有一个：让你在动第一行代码之前，知道每个模块管什么、数据怎么流动、哪些地方埋着坑。当前代码基线是 0.2.8（commit `04ec009`）。

## 1. 全景：这是什么样的插件

agent-team 是一个"Host + Client 双端"的 DSH Web 插件。Host 跑在 DSH Node 进程里，负责团队领域逻辑、Agent 会话编排、持久化和 HTTP 传输；Client 跑在浏览器页面里，负责设置页 UI 和团队工作台（一个全屏 overlay，内含成员对话列、任务板、Workspace 面板）。两端通过两条通道通信：

- **JSON-RPC**：Client `fetch(POST)` → Host `webServer.register({ kind: 'exact' })`，方法表见 `src/transport/contracts.ts` 的 `AGENT_TEAM_METHODS`（约 40 个方法，`catalog.*` / `assistant.*` / `team.*` 三组）。
- **SSE 事件流**：Host 在团队/会话/工作区变化时 publish，Client 用 `EventSource`（`src/client/api.ts`，共享连接 + 引用计数）订阅后触发 `load()` 重拉。注意：**推送只当"脏信号"用，真正数据都是重新拉全量**，所以不存在增量同步协议要维护。

一个关键的心智模型：**每个团队成员就是一个完整的 DSH Agent 会话**（`ctx.agents.create` / `resume` 创建，保存在 `TeamRuntime.owned` Map 里）。插件不自己实现 agent 循环，只是这些会话的"宿主 + 调度器 + 投影器"。

## 2. 目录地图与分层规则

```
src/
├── index.ts                  # Host 入口：装配顺序、关闭顺序
├── config.ts                 # Schema 配置（8 个配置项）
├── domain/                   # 领域层：Zod schema + 纯类型 + 领域错误
├── storage/                  # 持久化：DomainAgentTeamStore（JSON 文档）
├── service/                  # AgentTeamService：领域操作门面 + 订阅发布
├── runtime/                  # Agent 编排：TeamRuntime、消息派发、交互桥、工具、投影器
├── transport/                # web.ts（RPC 路由 + SSE）+ contracts.ts（方法表/视图类型）
└── client/                   # React UI（slots 注入、组件树、样式模块）
```

`scripts/check-architecture.mjs` 强制边界：domain 不许 import 上层；client 只能经 transport/contracts 的类型与 api.ts 说话；runtime 不直接碰 transport。改代码前跑一遍 `npm run guard:architecture` 比事后排错便宜。

## 3. 领域模型（改数据结构前必读）

全部实体定义在 `src/domain/schemas.ts`，全部 `.strict()`，持久化时按 `schemaVersion` 校验。

**TeamAggregate（聚合根）**是核心，一个团队一份：

- `members: Record<slotId, TeamMemberSlot>` —— 槽位制。每个槽绑定一个 `assistantId`（助手模板）+ `assistantSnapshot`（创建时的模板快照，模板后续修改不影响已建成员）+ `sessionId`（对应的 DSH 会话）+ `lastRuntimeState`（offline/starting/idle/running/waiting_approval/error）+ `desiredState`。
- `tasks: Record<taskId, TeamTask>` —— 共享任务板。状态机：pending → assigned → running/blocked → completed/failed/cancelled。`fileScopes` 记录任务涉及的文件范围。
- `leases: Record<id, FileScopeLease>` —— 文件范围租约（谁在改哪些文件），防止成员互踩。
- `outbox: Record<messageId, TeamMessage>` —— **待投递消息发件箱**，可靠投递的关键（见 §6.2）。
- `state`：draft / starting / active / ownership_conflict / deleting / delete_blocked / error。
- `revision: int` —— **乐观锁**。所有 mutation 走 `assertRevision`，Client 传 `expectedRevision`，不匹配即拒。

两个聚合外的次级实体：`AssistantTemplate`（助手模板，含 provider/model/agentPresetId/permissionPresetId/skillAllowlist/mcpServers）和 `Operation`（跨会话恢复的长任务游标：dissolve_team / remove_member / sync_member / migrate_records）。

**改 schema 的规则**：实体都带 `schemaVersion: z.literal(1)`。升级结构要么 bump 版本号并写迁移，要么新增可选字段保持向后兼容。持久化层（`storage/domain.ts`）目前 version: 1，没有迁移框架，升级前先想清楚存量 JSON 怎么办。

## 4. Host 装配（src/index.ts）

启动顺序是理解依赖的关键：

```
DomainAgentTeamStore → AgentTeamService → TeamRuntime → AssistantBuilderRuntime
  → service.attachRuntime / attachAssistantBuilderRuntime
  → registerWebTransport（RPC 路由）
  → registerNativeDirectoryPicker（目录选择对话框）
  → runtime.recoverTeams()          ← 从持久化恢复团队
  → runtime.startInteractionBridge() ← 开始抢占 user-questions/approval waterfall
  → service.startWorkspaceTracking()
```

关闭是一个 `ctx.effect` 里的逆序 async 清理（picker → transport → workspace tracking → 两个 runtime → 两个 store）。**加新资源时照这个模式放进出序 effect**，别自己另开生命周期。

Runtime 构造函数里挂了两个全局事件监听，这是状态流动的入口：

- `ctx.on('agent/status')`：Agent 状态变化 → 写 `lastRuntimeState`（经 `updateRuntimeTeam` 落盘）。
- `ctx.on('session/event')`：任何 owned 会话有事件 → 48ms 节流后 `publishOwnedConversation`（推 SSE 脏信号）。48ms 这个数字是防抖，不是精度承诺。

## 5. Service 层（src/service/agent-team-service.ts）

`AgentTeamService extends Service`（Cordis 服务，服务名 `agentTeam`），是所有领域操作的门面。它的几个设计决定直接影响二次开发：

1. **Runtime 后挂**：Service 构造时 runtime 还不存在，靠 `attachRuntime()` 注入。凡是需要 runtime 的方法都走 `requireRuntime()` 抛错保护。这个模式来自 Cordis 插件加载时序——Service 激活可能晚于 apply()，不要在启动期探测结果。
2. **mutate + commit 语义**：领域 mutation 底层走 store 的 mutate。注意 **`mutate` 对 `commit: false` 也返回 `ok: true`**，域错误在 `failures[]` 里，必须外置检查。照抄现有方法的写法（先 `assertTeamMutable` + `assertRevision`，再改，再落盘）。
3. **订阅发布**：`subscribe()` 返回去订阅函数；`publishConversation` / `publishAssistantBuilderConversation` 由 runtime 调用驱动 SSE。
4. **Workspace 方法**（list/search/changes/diff/upload）全部委托给 `workspace-service.ts`，后者经 `workspace-tracker.ts` 持有团队 workspaceId 到 DSH workspace 的映射。Git 状态和 diff 来自 `workspace-diff-renderer.ts`（对 workspacePath 直接跑 git 命令）。

## 6. Runtime 层（二次开发最常碰的地方）

### 6.1 TeamRuntime（src/runtime/team-runtime.ts，约 1000 行，最核心）

- **owned Map**：`sessionId → { teamId, slotId, handle }`。所有"这个会话归我管吗"的判断都查它。团队重启后靠 `recoverTeams()` + `ensureMemberOnline()`（724 行）重建：能 resume 的 resume，session 文件丢了的按 `desiredState` 决定重启或标 offline。
- **发送用户消息**：`sendUserMessage`（570 行）→ 找 owned → `handle.agent.followup(message)`。成员间消息则走 outbox（见下）。
- **成员上线装配**：`ensureMemberOnline` 里做了一整套"把一个普通 agent 变成团队成员"的动作——`installModelSelection`、`agentPresets.mount`、注入身份/名册 prompt 段（`team-prompts.ts` 的 `memberPrompt`/`rosterPrompt`）、`registerTeamTools`（含 `assertToolIdentity` 防止成员冒用 leader 工具）、MCP/skill 白名单（`tools.restrict` + `tools.guard`）、`permissionPresets.set`。**加"每个成员都要有"的能力，加在这里。**
- **恢复运行态**：`recoverTeams` 尾部（921 行附近）会把 `handle.agent.status` 回写 `lastRuntimeState`，防止重启后状态错。

### 6.2 消息投递：outbox 模式（team-message-dispatcher.ts + team-command-handler.ts）

成员间通信不直接 followup，而是：消息先进 `outbox`（deliveryState: queued）→ dispatcher `deliver()` 投递 → 成功后从 outbox 删除并落盘 delivered。投递前有 `sessionHasMessage(agent, messageId)` 幂等检查（按消息 id 查会话里是否已有这条），防止重复注入。`recover()` 在启动时重投所有 outbox 残留 + 补投持久化里 queued 状态的消息。**要改消息格式，同步改 `team-messages.ts` 的构造器和 `messageFromRecord` 的渲染**——后者决定模型看到什么文本（带成员名/槽位的 header）。

### 6.3 交互桥（team-interaction-bridge.ts）

成员会话里模型调 `ask_user_question` 或触发权限审批时，DSH 发 Cordis waterfall 事件（`user-questions/request` / `approval/request`）。桥的逻辑：

1. `acceptsSession(sessionId)`（即 `owned.has`）命中 → **claim，不调 `next()`**，请求不再流向官方 UI。
2. 生成 `PendingInteractionRecord`，`list(sessionId)` 会被会话投影带上，Client 渲染成 `PendingInteractionCard`。
3. 用户在工作台应答 → `team.interaction.respond` RPC → `record.settle(...)` resolve waterfall promise。
4. `request.signal` abort（比如会话被停）→ 取消记录并 reject。

AssistantBuilder 也用同一个桥（`registerScope` 注册自己的会话范围）。**注意后果**：被桥接的交互，官方主界面收不到应答请求（只能看到工具调用记录）。如果你想让主界面也能答，得改 claim 逻辑，这是产品决策不是 bug。

### 6.4 团队工具（team-tools.ts）

四个模型可见工具：`team_get_task_board` / `team_create_task`（leader-only）/ `team_update_task` / `team_send_message`。每个 execute 第一行 `handlers.assertIdentity(exec.agent)`——校验调用者确实是团队成员（`TeamCommandHandler` 提供校验和权限判断）。加新团队工具：在此注册 + handlers 加方法 + 在 ensureMemberOnline 的装配里自然生效（registerTeamTools 是统一入口）。

### 6.5 会话投影（conversation-projector.ts）

`projectConversation(events)` 把 SessionEvent 流投影成 UI 的 `ConversationNode[]`（user / assistant / tool / notice 四种，tool 用 callId 配对 call/result，截尾 240 条）。`projectContextUsage` 从 `assistant/message` 的 usage 记录算上下文占用。**限制要记住**：这是自绘渲染，不走 DSH 官方 conversation 渲染器，所以官方 tool-card 插槽（交互式提问卡、fs diff 卡）在工作台全部不生效。想接官方卡是大工程；小改就直接改 `ConversationColumn.tsx` 的 `ToolCard`。另外 `src/client/task-progress.ts` 的 `summarizeTaskProgress` 目前无人引用（死代码），做任务进度面板可以从它起步。

### 6.6 AssistantBuilderRuntime（assistant-builder-runtime.ts）

"团队 Agent 小助手"是设置页里帮你写助手模板的独立 agent 会话。安全模型是三重锁：`allowedTools` 白名单（get_catalog/prepare/commit/ask_user_question）+ 只读文件工具（read/read_image/glob/grep）+ `tools.restrict({ deny })` 动态 deny 其余工具。提交草稿有 `hasFreshAssistantDraftUserResponse` 门——**必须 prepare 之后有一条真实用户消息**才允许 commit，防止模型自己写自己批。改 builder 行为时这三层要一起看。

### 6.7 共享任务板：产生与状态流转（team-command-handler.ts）

"共享"指所有成员的模型工具读到的是**同一份聚合数据**：任务板存在 `TeamAggregate.tasks`，任何成员调 `team_get_task_board` 都拿当前聚合的全量任务。UI 的任务板（TeamPanel）只是这份聚合的只读投影。

**产生**：唯一入口是 leader 调 `team_create_task`（`createTask` 33 行硬校验 `creatorSlotId !== leaderSlotId` 即拒）。状态由是否指定负责人决定：不指定 → `pending`；指定 → `assigned`。指定 owner 且非 leader 本人时，同一笔 `updateRuntimeTeam` 事务里写任务 + 把 `assignmentContent` 指令消息放进 outbox，随后派发器投给负责人会话（`agent.followup`，文本带标题/描述/fileScopes），返回的 `deliveryState` 告知送达还是排队。

**流转**：成员经 `team_update_task` 推进自己的任务（只能改 `ownerSlotId === 自己` 的）；leader 可改任何任务且是唯一能改派 owner 的人。更新时自动路由通知（113–135 行）：leader 改派 → 给新 owner 发 `reassignmentContent` 指令（附原结果/错误）；成员更新 → 给 leader 发通知，类型按状态映射（completed→result、failed/cancelled→warning、blocked→question、其余→progress）。协作循环即：leader 派 → 成员做并回报 → leader 被通知唤醒再决策。任务每次更新 `revision + 1`，状态写盘与通知入队在**同一事务**完成，通知失败留在 outbox 由 `recover()` 重投，不存在"状态改了通知丢了"的半态。

**两个现状要知道**：① 任务状态枚举以 `src/domain/schemas.ts` 的 `teamTaskSchema.status` 为准，`labels.ts` 的 `TASK_STATE_LABELS` 必须与之对齐（`running` 译「进行中」而非「运行中」，避免与成员状态混淆；`blocked` 译「受阻」），`tests/client-labels.spec.ts` 有文案表 key 与 schema 枚举同步的守护测试——新增/调整任务状态时两处要一起改；② `dependencyIds` 永远是 `[]`、`FileScopeLease`（文件租约）只在建队时初始化为空——两者都是预留未实现，schema 已铺好，做文件级冲突防护缺的只是获取/释放/校验逻辑。

### 6.8 成员上下文（系统提示词）组装

成员"知道自己是谁、团队里有谁、该怎么协作"，完全靠上线装配时注册进系统提示词的段落。组装发生在 `setup` 回调里（`team-runtime.ts` 760 行起），顺序和内容如下：

1. **预设挂载**（761 行）：`agentPresets.mount` 先挂助手模板指定的 Agent Preset（standard/cordis 等），预设自带的工具与提示词先就位。
2. **模型选型**（762 行）：`installModelSelection` 把助手模板的 provider/model/reasoningEffort 钉进上下文。
3. **身份段**（763–775 行，`agent-team:identity:<slotId>`，order 10）：内容来自 `team-prompts.ts` 的 `memberPrompt`——"你是谁、角色是什么（leader/member）、全队在同一个 Workspace、改重叠文件先协调"，末尾拼接助手模板的 `instructions`。
4. **名册段**（776–780 行，`agent-team:roster:<teamId>`，order 11）：`rosterPrompt` 输出实时成员表（displayName + role + **slotId**，slotId 是 `team_send_message`/任务指派的寻址键）+ 协作协议四句话（leader 用 `team_create_task` 派活、成员用 `team_update_task` 回报、沟通走 `team_send_message`）。leader 没有专属段落，它与普通成员的差异只有 `role` 字段。
5. **工具装配**（781 行起）：注册四个团队工具（handlers 绑定该成员的 slotId）；按助手模板的 mcpServers/skillAllowlist 做 restrict + guard 白名单；`permissionPresets.set` 落权限。

**核心机制：段落是取数 thunk，不是静态文本**。两个 section 的 `text` 是函数（768、779 行），每次 DSH 组装提示词时重新执行，从 `service.getTeam()` 取**当前聚合**——所以启动团队之后新加的成员会自动出现在所有已在线成员的名册里，移除的成员自动消失；身份段发现自己的槽位已不在聚合中时会改输出 "This Agent Team membership is no longer active."。**改"成员如何理解团队"，入口就是 `team-prompts.ts` 的这两个纯函数**，不用碰装配逻辑；但要想清楚：名册进的是 system prompt，改结构会改变所有成员每次对话的上下文形状。

**装配校验是上线闸门**（882–889 行）：setup 末尾实际执行一次 `systemPrompt.assemble(assembleContextFor(agent))`，检查身份段与名册段都存活在最终 prompt 里。某些 Preset（如 `minimal`）的提示词组装方式会整体替换段落，导致两段消失——此时抛 `PRESET_PROMPT_INCOMPATIBLE` 拒绝上线。这是有意设计：没有身份段/名册段的成员会以普通单 agent 的方式行事，团队机制静默失效，宁可报错。助手模板绑 Preset 时必须选会保留注入段落的（standard/cordis）。

## 7. 传输层（src/transport/）

`web.ts` 注册三个 exact 路由：RPC 主入口、SSE 事件流（心跳 `sseHeartbeatMs`）、Workspace 文件上传。`contracts.ts` 是两端的**单一事实源**：加方法 = `AGENT_TEAM_METHODS` 加名字 + `AgentTeamRequestMap` 加 payload/result 类型 + web.ts 分发 + client/api.ts 封装。跨端枚举/RPC 参数形态不一致是**无报错静默失败**（空数组单测会掩盖），两边类型都从 contracts 推导，别在 client 里手写结构。

## 8. Client 结构（src/client/）

- **注入点**（index.tsx）：`settings.section`（设置页"Agent 团队"）+ `shell.overlay`（工作台全屏层，附带 `pickWorkspace` 能力，走 `/agent-team/pick-directory` 让 Host 弹原生 WinForms 对话框）。
- **组件树**：`components.tsx`（AgentTeamOverlay/SettingsSection）→ `teams/TeamPanel.tsx`（工作台主体：成员 Tab、TeamCard 瓷贴、任务板、清空/删除流程）→ `workbench/ConversationColumn.tsx`（单成员对话列：投影渲染 + composer + PendingInteractionCard）+ `workspace/WorkspacePanel.tsx`（文件树/git 状态/diff）+ `assistants/AssistantPanel.tsx`（助手模板管理 + builder 会话）。
- **状态**：无 Redux 式框架，`store.ts` 是个 useSyncExternalStore 小 store；数据流 = SSE 脏信号 → `load()` 重拉 RPC → setState。样式是 CSS Modules + `--dsw-*` 语义变量（AGENTS.md 硬性要求，别引第三方色板）。
- **状态文字的三处来源**（历史原因，改状态显示要三处同查）：对话列头部用 `conversation.status`（实时 `agent.status`）+ pendingInteractions 推导；TeamCard 瓷贴用 `lastRuntimeState`（只有 idle/running/starting/offline 会被写入，waiting_approval/error 到不了这里）；Tab 上只有圆点。

## 9. 持久化与恢复

`storage/domain.ts` 打开一个 JSON 文档库（version: 1），`store.ts` 的 `DomainAgentTeamStore` 封装读写 + mutate。团队聚合、消息、活动记录、Operation 游标都在里面。**可靠性设计**：outbox + Operation 游标 + 启动时 `recoverTeams()`，意味着"改一半崩溃"是常态假设。测试里有对应的恢复用例（tests/ 下按模块同名 spec），改持久化/恢复逻辑务必跑全。

## 10. 配置项（config.ts）

`maxRequestBytes`（RPC 体积上限）、`sseHeartbeatMs`、`runtimeConcurrency`（runtime exclusive 队列并发）、`directMemberChatDefault`（成员直聊默认开关）、`assistantBuilder*` 四项（builder 的 provider/model/preset/权限，空 = 跟随默认）。加配置项记得 Schema 默认值 + `Config` 接口同步。

## 11. 二次开发常见切入点速查

| 想做什么 | 动哪里 |
|---|---|
| 给成员加新模型工具 | `runtime/team-tools.ts` 注册 + handlers；涉及权限就同步 ensureMemberOnline 的 restrict/guard |
| 加新的任务板字段/状态 | `domain/schemas.ts` 的 teamTaskSchema（注意 schemaVersion）→ labels.ts 文案 → TeamPanel 任务板渲染 → team-tools 参数 |
| 改成员间消息格式 | `team-messages.ts` 构造 + `messageFromRecord`，跑 team-message 相关 spec |
| 加新 RPC 方法 | contracts.ts 方法表 + web.ts 分发 + client/api.ts，类型从 contracts 推 |
| 加工作台面板 | TeamPanel 布局 + 新 CSS Module 类；数据走新 RPC + SSE 脏信号 |
| 改状态显示 | 三处来源（§8）+ labels.ts + AgentTeam.module.css 的 memberRuntime* 类 |
| 改 prompt（团队协作行为） | `team-prompts.ts`；身份/名册由 ensureMemberOnline 注入 |
| 加配置项 | config.ts + 使用处 |

## 12. 修改后必须过的检查清单

1. `npm run guard:architecture`（分层边界）
2. `npm run typecheck`
3. `npx vitest run --pool=threads`（沙箱内 forks 池会挂死；`workspace-git.spec.ts` 要真实 git 子进程，沙箱内必挂，需非沙箱单跑）
4. `npm run build`
5. bump version（**pnpm 对同名同版本 file: tgz 不重新解包**，不 bump 装的是旧代码）→ `npm pack --pack-destination dist`（先确保 dist/ 存在）
6. 安装到 profile：改 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 的 spec（**用编辑工具，别用 PS5 Set-Content，会写 BOM**）→ `pnpm install --network-concurrency 1` → `dsh plugin --profile desktop add -w <tgz>`
7. **重启 DSH** 再验证——进程跑旧内存模块，不重启的验证全部作废
8. Conventional Commit（`feat:`/`fix:`/…），发布打 `v0.x.y` tag 作回滚锚点
