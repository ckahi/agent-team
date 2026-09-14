# Agent Team for DeepSeek Harness

English | [简体中文](./README_CN.md)

![Agent Team — Independent Agents, Shared Workspace](./demo/github-banner.png)

[![npm version](https://img.shields.io/npm/v/@limuyang2/dsh-agent-team.svg)](https://www.npmjs.com/package/@limuyang2/dsh-agent-team)
[![license](https://img.shields.io/npm/l/@limuyang2/dsh-agent-team.svg)](https://www.npmjs.com/package/@limuyang2/dsh-agent-team)

Current release: `0.1.4`

Build teams of independent AI agents inside DeepSeek Harness. Mix models and providers, assign one Leader, and let every member work in its own conversation while sharing the same Workspace.

Agent Team does **not** turn members into subagents. Every member is an independent root agent with its own model, session, context, permissions, reasoning mode, and tool activity. Team tasks, messages, and the shared Workspace provide the collaboration layer.

![Agent Team workbench](./demo/4.png)

## Why Independent Agents Instead of One Overloaded Agent?

Agent Team is designed around a simple idea: **give specialized work to a specialized agent**.

A common parent/subagent workflow reuses or inherits much of the parent runtime configuration. That is convenient, but it can make every task carry the same expensive model, broad tool catalog, and growing context. A small commit-message task, for example, may still run through the same high-capability model used for architecture and implementation.

Agent Team lets every member have an explicit, focused configuration:

| Concern | Common parent/subagent setup | Agent Team |
| --- | --- | --- |
| Model | Often reuses the parent model or one shared model policy | Choose a different provider and model for every member |
| Skills and MCP | A broad catalog may be inherited or exposed everywhere | Give each role only the Skills and MCP Servers it needs |
| Context | Planning, execution, tool output, and results accumulate together | Every member has an isolated Session and context window |
| Cost | Simple work may still consume an expensive general model | Route routine work to smaller or specialized models |
| Permissions | One broad permission policy can spread across the workflow | Set least-privilege defaults and runtime permissions per member |

This separation keeps the Leader focused on planning and verification, keeps specialists focused on execution, reduces irrelevant tool choices, and prevents one agent's context from growing with every detail produced by the whole team. Members send tasks, progress, and results explicitly instead of sharing an ever-expanding conversation.

> Subagent behavior varies by framework. The comparison above describes the common parent-inherited pattern; Agent Team's advantage is that model, tools, permissions, and context isolation are explicit product-level choices for every member.

### Example: Use the Right Model for Each Job

Consider a software development team with three specialized members:

| Role | Model | Focused configuration |
| --- | --- | --- |
| Architecture Leader | GPT | Understand the requirement, design the solution, split work, coordinate members, and verify results |
| Coding Agent | GLM | Load coding Skills and development MCP tools, modify the Workspace, and run tests |
| Commit Assistant | DeepSeek Flash | Read Git status and diffs, then generate a Conventional Commit message with read-only permission |

The GPT Leader spends its context on decisions and verification instead of every implementation detail. GLM receives the codebase context and tools required for execution. DeepSeek Flash handles the narrow commit task quickly without paying for the Leader's higher-capability model or loading the coding agent's large tool catalog.

The collaboration flow is explicit:

```text
User goal → GPT Leader plans and assigns work
          → GLM Coding Agent implements and reports test results
          → GPT Leader verifies the result
          → DeepSeek Flash Commit Assistant summarizes the Git diff
```

## What You Can Do

- Create reusable assistants for planning, coding, testing, review, documentation, or any other role.
- Mix providers and models in one team—for example, a Codex Leader with GLM coding members.
- Create assistants manually or describe a role to the built-in **Team Agent Assistant**.
- Add the same assistant more than once; every selection becomes an independent team member.
- Watch all members side by side with streaming output, Markdown, Think blocks, and tool calls.
- Let the Leader create tasks, assign members, track progress, and collect results.
- Send messages directly to the Leader or, when enabled, to regular members.
- Change a member's permission preset and reasoning mode for the current session.
- Inspect loaded Skills, context usage, token statistics, and cache hit rate.
- Browse shared Workspace files and preview Git changes and diffs.
- Add or remove members, change the Leader, reset all contexts, or dissolve a team.

## Screenshots

### Create an Assistant by Conversation

Describe the role you need. The built-in assistant collects missing settings, prepares the long-term instructions, and creates the assistant only after your confirmation.

![Create an assistant by conversation](./demo/1.png)

### Reusable Assistant Library

Manage assistants under **Settings → Agent Team**. Each assistant can use a different provider, model, preset, default permission, reasoning mode, Skills, MCP Servers, and role instructions.

> **Skills and MCP scope:** Agent Team uses Skills and MCP Servers exposed through the standard DeepSeek Harness interfaces. This plugin does not provide installation, updates, or lifecycle management for Skills or MCP Servers. Install the appropriate Harness plugins to manage those resources first; Agent Team only lets an assistant select and use the resources already available in the active Profile.

![Assistant library](./demo/2.png)

### Build a Team

Select members, assign exactly one Leader, choose a Workspace, and decide whether direct communication with regular members is allowed.

![Build a team](./demo/3.png)

### Floating Team Launcher

A compact floating button opens the full-screen Team workbench without competing with sidebar extensions from other Harness clients. Hover over it or drag it to reveal the label. Drop it at either screen edge to collapse it toward that edge; the last position is remembered locally. Create teams and switch between them from the workbench navigator.

![Floating Team launcher](./demo/5.png)

## Requirements

- Node.js `22.19.0+` or `24.0.0+`
- DeepSeek Harness `0.1.1-rc.2`
- `pnpm` available on `PATH` (Harness uses it to manage Profile plugins)

Install pnpm if necessary:

```bash
npm install -g pnpm
```

## Installation

### DeepSeek Harness Web

Install Agent Team into the Harness `web` Profile:

```bash
npx @deepseek-ai/dsh plugin --profile web add @limuyang2/dsh-agent-team
```

Start Harness:

```bash
npx @deepseek-ai/dsh web
```

Open the URL printed by Harness, normally <http://127.0.0.1:3080/>. Restart Harness after installing or replacing the plugin.

### DeepSeek Harness Desktop

Install the exact Agent Team release into the Profile managed by DeepSeek Harness Desktop:

```bash
dsh plugin add --save-exact @limuyang2/dsh-agent-team@0.1.4
```

Quit and reopen DeepSeek Harness Desktop after the command completes. `--save-exact` keeps the Desktop Profile pinned to the tested plugin version instead of automatically moving to a newer release.

## Uninstallation

Stop Harness with `Ctrl+C`, then remove Agent Team from the `web` Profile:

```bash
npx @deepseek-ai/dsh plugin --profile web remove @limuyang2/dsh-agent-team
```

Restart Harness after the command completes. Removing the plugin does not modify DeepSeek Harness source code or delete files from your team Workspaces.

## Quick Start

### 1. Configure Models in Harness

Configure the providers, models, and credentials you want to use in Harness first. Agent Team reads the model catalog from the active Profile and never stores provider API keys.

> **Tip: enable Thinking Mode for GLM-5.3**
>
> Add the following configuration to `~/.dsh/settings.yaml`. It exposes the available reasoning levels for GLM-5.3 and sets `high` as the Provider default:
>
> ```yaml
> llm-pi-ai:
>   providers:
>     zai-coding-cn:
>       reasoning: high
>       modelOverrides:
>         glm-5.3:
>           reasoningEfforts:
>             off:
>             minimal: minimal
>             low: low
>             medium: medium
>             high: high
>             xhigh: xhigh
>             max: max
>           compat:
>             thinkingFormat: zai
>             supportsReasoningEffort: true
> ```
>
> Merge this block into an existing `llm-pi-ai` section instead of adding a second one. If your ZAI Provider uses a different ID, replace `zai-coding-cn`. Restart Harness, then select the desired **Thinking Mode** from the assistant conversation toolbar; that runtime selection overrides the Provider default for the conversation.

### 2. Create Assistants

Open **Settings → Agent Team** and choose one of the following:

- **Start Conversation** to design an assistant through chat.
- **Create Manually** to configure all fields directly.

A practical first team usually contains:

- A **Leader** that understands goals, plans work, delegates tasks, and verifies results.
- One or more **members** focused on implementation, testing, review, or documentation.

### 3. Create a Team

Click the floating **Team** button, then click `+` in the workbench navigator:

1. Add assistants from the list. You may add the same assistant multiple times.
2. Select exactly one member as the Leader.
3. Enter a team name and choose a Workspace.
4. Choose whether users may chat directly with regular members.
5. Click **Create and Start**.

The team starts automatically and opens in the full-screen workbench.

### 4. Give the Leader a Goal

Send the complete objective to the Leader. The Leader can split it into tasks, assign members, receive progress updates, and verify the final output. You can also talk to an individual member directly when the team policy allows it.

## Workbench Guide

Each visible column is a real, independent Harness session.

- **Member tabs:** show or hide conversations. Hover a non-Leader tab to remove that member.
- **Conversation header:** shows role, provider, model, reasoning mode, and live status. Double-click it to enlarge the conversation.
- **Composer:** send messages; type `/` to invoke an allowed Skill; type `@` to search and mention Workspace files; attach local files, stop generation, and change runtime settings.
- **Permission:** applies to the selected member's current session. The assistant template only supplies the initial default.
- **Reasoning mode:** applies from the next turn and only shows options supported by the selected model.
- **Info:** displays the Skills loaded for the member.
- **Context ring:** displays context usage, input/output tokens, and cache hit rate.
- **Workspace:** browse files, refresh manually, watch file changes, and preview Git diffs.

## Team Collaboration

The Leader and members communicate through explicit team tools and messages:

- The Leader creates tasks and assigns them to member instances.
- Assigned members receive the task in their own session.
- Members report running, completed, or failed status with a result.
- Status and result updates automatically reach the Leader.
- Members can send direct team messages when clarification is needed.
- Membership changes are delivered to the Leader with stable member IDs.

Members share a Workspace, but they do not share conversation history. This keeps roles and model contexts isolated while allowing them to work on the same files.

## Team Management

- **Add member:** starts a new independent member from an assistant snapshot and notifies the Leader.
- **Remove member:** stops and archives that member's session, removes it from the team, and notifies the Leader.
- **Change Leader:** changes the role without replacing the member's current session.
- **Clear tasks and context:** stops all members, clears team tasks and queued messages, and gives every remaining member a new session. Team settings and Workspace files stay unchanged.
- **Dissolve team:** permanently removes the team, its tasks, and team messages. Assistant templates and Workspace files are not deleted.

Assistant settings are snapshotted when a member joins a team. Editing an assistant later does not hot-update existing members; remove and add the member again to apply the new configuration.

## Important Behavior

- The assistant's permission setting is only the member's initial default.
- Reasoning options come from Harness model capabilities; unsupported options are not invented by the plugin.
- MCP credentials remain in the Harness Profile. Assistant templates only store allowed server names.
- Files selected from outside the Workspace are copied to `.agent-team/uploads/` so agents can access them reliably.
- The **Changes** view requires a Git Workspace. Normal folders still support file browsing.
- Harness currently has no public API for physically deleting one session log. Reset or dissolved sessions are no longer restored or used by Agent Team, but old logs may remain in Harness storage.
- **Interaction cards (questions and approvals) belong to the team.** When a team member calls `ask_user_question` or requests a permission elevation, the interactive card appears in that member's conversation column in the Agent Team workbench — not in the main Harness conversation view. The main view remains the fallback only for sessions Agent Team does not own.
- **Derived sub-agents inherit the member's interaction channel.** When a member spawns a sub-agent (subagent/workflow tool) that triggers a permission elevation, the approval card is shown in the spawning member's column and is answered from the workbench. A sub-agent calling `ask_user_question` directly, however, fails with Harness's `DELEGATED_CALLER` error by design — questions must be asked by the member agent itself; have the sub-agent return its open question as part of its result so the member can ask it on the next turn.

## Troubleshooting

### `pnpm not found on PATH`

Run `npm install -g pnpm`, verify `pnpm --version`, and install the plugin again.

### Port `3080` is already in use

Another Harness process is already running. Stop the old process with `Ctrl+C`, then run `npx @deepseek-ai/dsh web` again.

### A model or reasoning option is missing

Refresh the assistant catalog and verify the model configuration in Harness. Reasoning modes only appear when the provider reports that capability.

### An assistant cannot be deleted

The assistant is still referenced by a team member. Remove those members or dissolve the related teams first.

### No Git changes are displayed

Confirm that the selected Workspace itself is a Git repository. A repository nested inside a non-Git Workspace is not treated as the Workspace repository.

## User Documentation

The detailed user guide is available in Chinese:

- [Documentation index](./docs/README.md)
- [Installation and startup](./docs/installation.md)
- [Assistant library](./docs/assistants.md)
- [Creating teams](./docs/creating-teams.md)
- [Workbench and collaboration](./docs/workbench.md)
- [Workspace and Git changes](./docs/workspace.md)
- [Team management](./docs/team-management.md)
- [Troubleshooting](./docs/troubleshooting.md)

## Links

- [npm package](https://www.npmjs.com/package/@limuyang2/dsh-agent-team)
- [GitHub repository](https://github.com/limuyang2/agent-team)
- [Issue tracker](https://github.com/limuyang2/agent-team/issues)

## License

MIT
