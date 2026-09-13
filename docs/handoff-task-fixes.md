# 修复任务转交手册：agent-team 插件

你接手的是 `@limuyang2/dsh-agent-team`（本地路径 `E:\thirdparty\dsh-plugins\agent-team`）的两个缺陷修复。本手册自包含：不需要此前会话的任何上下文，所有结论都来自 0.2.8（commit `04ec009`）的源码核实，文件与行号可直接对照。

## 背景速览（读代码前先看这段）

这是一个 DSH Web 插件，Host（Node 进程）+ Client（React）双端。团队成员是完整的 DSH Agent 会话，团队数据聚合在 `TeamAggregate`（`src/domain/schemas.ts`），持久化在 `storage/`，领域操作门面是 `service/agent-team-service.ts`，Agent 编排在 `runtime/team-runtime.ts`。仓库根目录的 `AGENTS.md` 是工程规范（测试命令、提交格式、架构 guard），`docs/developer-guide.zh.md` 是系统说明书——动手前把这两份读一遍，尤其是说明书的 §3（领域模型）、§6（Runtime）、§12（检查清单）。

**硬性约束**：

- 禁止修改 `E:\thirdparty\deepseek-harness`（官方宿主源码，只读参考）。
- 所有改动在 `dev/workbench-enhancements` 分支上做，不要碰 `main`。
- Conventional Commit（`fix:` / `feat:` / `test:`）。
- 修完必须走完 §"验证与交付" 的完整流程，缺一步都可能把旧代码当新代码验证。

---

## 任务一：任务板状态文案与枚举不匹配（fix）

### 现象

团队卡片"任务板"区块里，状态为 running 或 blocked 的任务直接显示英文 `running` / `blocked`，其余状态显示中文。

### 根因

- 状态枚举（schema 的事实）：`src/domain/schemas.ts` 73 行，`teamTaskSchema.status` = `pending | assigned | running | blocked | completed | failed | cancelled`。
- UI 文案表：`src/client/labels.ts` 1–8 行，`TASK_STATE_LABELS` 写的是 `in_progress: '进行中'`——schema 里根本没有 `in_progress` 这个状态；同时缺 `blocked` 的映射。
- 消费方：`src/client/teams/TeamPanel.tsx` 923 行 `TASK_STATE_LABELS[task.status] ?? task.status`，查不到 key 就回退英文原文。

### 修法

以 schema 枚举为准修文案表：把 `in_progress: '进行中'` 改为 `running: '运行中'`（或与产品语义一致的译名，注意任务状态"运行中"与成员状态"运行中"是两回事，任务建议用"进行中"对应 running），补 `blocked: '受阻'`。全库搜索 `in_progress` 确认没有其他消费方再删旧 key（如果发现模型工具的文档字符串里写了 in_progress，一并改，但工具 schema 的枚举在 `runtime/team-tools.ts` 86 行，它和 schema 一致，不要动）。

### 验收

- 新增或修改 `tests/` 下的 client labels 测试：七个枚举值全部有中文映射，`taskStatusLabel` 对未知值回退原文。
- 全测试通过（命令见"验证与交付"）。

---

## 任务二：团队 `error` 状态是死胡同，添加成员静默失败（fix + feat）

### 现象（用户视角）

创建团队时某个成员上线失败（例如其助手模板绑定了 `minimal` Agent Preset，会触发 `PRESET_PROMPT_INCOMPATIBLE`），团队被落盘为 `state: 'error'`。此后：

1. 在 UI 点"+"添加助手，选了模板后报 `TEAM_NOT_ACTIVE: Cannot add a member while team is 'error'`，弹窗不关、列表不变，用户感知为"点了没反应"。
2. 没有任何 UI 入口能看到失败原因或重试启动。唯一的自动恢复藏在"重启 DSH 后 `recoverTeams()` 重试 error 团队"（`runtime/team-runtime.ts` 614–618 行把 error 列为可恢复），用户不可能知道。

### 根因（两处叠加）

1. **服务端闸门**：`src/service/agent-team-service.ts` 581–583 行，`addMember` 只允许 `draft | active` 状态。`error` 不在其中 → 拒绝。同类闸门还有 `assertTeamMutable`（1005 行，只挡 deleting），但 addMember 的检查在它之外。
2. **前端无出口**：`src/client/teams/TeamPanel.tsx` 里，error 状态的团队卡片没有失败原因展示，也没有"重试启动"按钮。启动团队的 RPC `team.start`（service 627 行）本身**没有状态闸门**，服务端随时可以重试。

### 修法（分三步，前两步必须，第三步可选）

**第一步（服务端，最小修复）**：放开 error 团队的成员管理。在 `addMember`（以及 `changeLeader`、`setMemberPermissionPreset`、`setMemberReasoningEffort`，视检查位置而定）允许 `error` 状态，或者更稳妥：抽一个 `assertTeamManageable`，允许 `draft | active | error`。注意语义：error 团队加成员只是写聚合（587 行 `desiredState` 取 'offline'），不会自动上线，合理。

**第二步（前端）**：

- error 状态的 `TeamCard`（`TeamPanel.tsx` 843 行 header 附近）显示"启动失败"徽标，并提供"重试启动"按钮 → 调 `team.start`（参数 `{ id: team.id }`，带 `team.revision` 作 expectedRevision），成功后走现有 `onChanged()` 刷新。
- `AddTeamMemberDialog` 的错误提示（556 行 `css.inlineError`）确认对 `TEAM_NOT_ACTIVE` 这类域错误可见（ role=alert 已有，验证样式没有把它挤没即可）。
- 重试启动若再次失败，错误要落到卡片可见处（TeamCard 已有 `error` state，复用）。

**第三步（可选，锦上添花）**：error 卡片显示上次失败原因。`TeamAggregate` 没有存 error message 字段——`markTeamError`（`team-runtime.ts` 979 行）只写状态。若做此步，需要给聚合加可选字段（如 `lastError`），注意 §3 的 schema 演进规则（新增可选字段是兼容的），并在 `startTeamUnlocked` 成功路径上清掉它。

### 禁止的修法

- 不要把 `recoverTeams` 的自动重试改成无限循环重试。
- 不要为了让 addMember 通过而删掉 `draft | active` 检查本身——error 放开是有意决策，draft 语义不动。
- 不要动 `PRESET_PROMPT_INCOMPATIBLE` 校验（`team-runtime.ts` 884–889 行）：它是防止成员以"不认识团队"的状态上线的正确防线，问题只在失败后的出口。

### 验收

- 单测：error 团队 addMember 成功；draft/active 行为不回归；error 团队 team.start 可重试且成功后 state='active'。
- 真实宿主手测脚本：建一个绑定 minimal 预设的助手 → 建团队启动（失败，进 error）→ 卡片出现"重试启动" → 修正预设 → 重试成功 → 加成员正常。

---

## 顺手可做（不阻塞验收，有余力再做）

- 工作台（workbench）没有任务板展示：`TeamWorkbenchView`（`transport/contracts.ts` 219 行）不含 tasks，服务端数据现成。加一个只读任务板面板属于低风险 feat。
- `dependencyIds` 与 `FileScopeLease` 是预留字段（全库核实过：永远空值，无消费方），暂不要实现，也不要删——留给文件冲突防护功能。

## 验证与交付（每个任务完成都要走）

1. `npm run guard:architecture`（分层边界）
2. `npm run typecheck`
3. `npx vitest run --pool=threads` —— **必须加 `--pool=threads`**，默认 forks 池在沙箱内会挂死；`tests/workspace-git.spec.ts` 需要真实 git 子进程，沙箱内必挂，需在非沙箱环境单独跑这一个文件（3 个用例）
4. `npm run build`
5. bump version（`npm version` patch +1，**必须**——pnpm 对同名同版本的 file: tgz 不重新解包）→ `npm pack --pack-destination dist`（先确保 dist/ 目录存在）
6. 安装：编辑 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 的 `@limuyang2/dsh-agent-team` spec 指向新 tgz（**用编辑工具，禁止 PowerShell Set-Content 写 JSON，会带 BOM**）→ 在 profile 目录 `pnpm install --network-concurrency 1` → `dsh plugin --profile desktop add -w <tgz 绝对路径>`
7. **重启 DSH** 后真实宿主验证（不重启 = 验证打在旧代码上）
8. 提交：Conventional Commit，一个任务一个提交；交付时报告改了哪些文件、测试结果、宿主验证结果

## 环境备忘

- 工作区：`E:\thirdparty\dsh-plugins`（agent-team 是其中的子目录，独立 git 仓库）。npm 需要时加 `--legacy-peer-deps --cache "$env:TEMP\npm-cache-agentteam"`。
- `dsh plugin` 命令和写 profile 目录需要提权；安装失败常见原因是 profile spec 指向已删除的旧 tgz，先修 spec 再 `pnpm install`。
- 遇到"改了没生效"，按顺序检查：version 是否 bump → profile spec 是否指向新 tgz → DSH 是否重启。
