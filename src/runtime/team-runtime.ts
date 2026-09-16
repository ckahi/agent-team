import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  assembleContextFor,
  installModelSelection,
  type Agent,
  type AgentHandle,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { isModelInvocable, isUserInvocable } from '@deepseek-ai/dsh-skill'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { Config } from '../config.js'
import { AgentTeamError } from '../domain/errors.js'
import { mcpServerFromToolName } from '../domain/mcp.js'
import type {
  TeamAggregate,
  TeamMemberSlot,
  TeamMessage,
} from '../domain/types.js'
import type { AgentTeamService } from '../service/agent-team-service.js'
import type { AgentTeamCommandBridge } from '../transport/contracts.js'
import type {
  CommandCompactAllView,
  CommandDescriptorView,
  CommandExecutionView,
  InteractionResponseInput,
  MemberConversationView,
  TeamWorkbenchView,
} from '../transport/contracts.js'
import { projectContextUsage, projectConversation } from './conversation-projector.js'
import { registerScopedSkillProvider } from './scoped-skills.js'
import { TeamCommandHandler } from './team-command-handler.js'
import { resolveSessionLineageOwner, TeamInteractionBridge } from './team-interaction-bridge.js'
import { TeamMessageDispatcher } from './team-message-dispatcher.js'
import {
  createSystemTeamMessage as systemTeamMessage,
  createTeamMessage as teamMessage,
  requireMessageContent as requireContent,
} from './team-messages.js'
import { memberPrompt, rosterPrompt } from './team-prompts.js'
import { registerTeamTools } from './team-tools.js'

interface OwnedAgent {
  teamId: string
  slotId: string
  handle: AgentHandle
  modelSelection: ModelSelectionRef
}

/**
 * 宿主 `commands` 服务（packages/interaction/commands）的最小结构化投影。
 * 宿主包未在插件依赖中发布类型，这里只声明本插件实际调用的两个 Remote 方法；
 * 结构与宿主 `CommandRuntime` 兼容，运行时由 inject 'commands' 保证可用。
 */
interface HostCommandDescriptor {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string; readonly attachments?: boolean }
}

interface HostCommandExecution {
  readonly commandId: string
  readonly result:
    | { readonly kind: 'success'; readonly text?: string }
    | { readonly kind: 'error'; readonly text: string }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    commands: {
      list(agent: unknown): readonly HostCommandDescriptor[]
      execute(
        agent: unknown,
        line: string,
        attachments: readonly unknown[],
        signal: AbortSignal,
      ): Promise<HostCommandExecution | undefined>
    }
  }
}

export class TeamRuntime {
  private readonly owned = new Map<string, OwnedAgent>()
  private readonly activating = new Map<string, { teamId: string; slotId: string }>()
  private readonly operations = new Map<string, Promise<unknown>>()
  private readonly disposeStatusListener: () => void
  private readonly disposeConversationListener: () => void
  private readonly conversationPublishes = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly messages: TeamMessageDispatcher
  private readonly commands: TeamCommandHandler
  private readonly interactions: TeamInteractionBridge
  private closing = false

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly service: AgentTeamService,
  ) {
    this.messages = new TeamMessageDispatcher(service, {
      resolveAgent: sessionId => this.requireOwned(sessionId).handle.agent,
      warn: (message, error) => { ctx.logger.warn(message, error) },
    })
    this.commands = new TeamCommandHandler(service, {
      deliverMessage: (teamId, messageId) => this.messages.deliver(teamId, messageId),
      followup: (sessionId, message) => { this.requireOwned(sessionId).handle.agent.followup(message) },
    })
    this.interactions = new TeamInteractionBridge(ctx, {
      acceptsSession: sessionId => this.owned.has(sessionId),
      resolveOwnedSession: sessionId => resolveSessionLineageOwner(
        sessionId,
        candidate => {
          const parent = this.ctx.sessions.get(SessionId(candidate))?.header.parentSession
          return parent === undefined ? undefined : String(parent)
        },
        ownedId => this.owned.has(ownedId),
      ),
      onChange: sessionId => { this.publishOwnedConversation(sessionId) },
    })
    this.disposeStatusListener = ctx.on('agent/status', ({ agent, status }) => {
      const owned = this.owned.get(String(agent.id))
      if (owned === undefined) return
      void this.setMemberRuntimeState(owned.teamId, owned.slotId, status)
        .catch(error => this.ctx.logger.warn('agent-team: failed to persist agent status', error))
    })
    this.disposeConversationListener = ctx.on('session/event', (session) => {
      const owned = this.owned.get(String(session.id))
      if (owned === undefined || this.conversationPublishes.has(String(session.id))) return
      const timer = setTimeout(() => {
        this.conversationPublishes.delete(String(session.id))
        try {
          this.publishOwnedConversation(String(session.id))
        } catch (error) {
          this.ctx.logger.warn('agent-team: failed to publish conversation update', error)
        }
      }, 48)
      this.conversationPublishes.set(String(session.id), timer)
    })
  }

  startInteractionBridge(): void {
    this.interactions.start()
  }

  interactionBridge(): TeamInteractionBridge {
    return this.interactions
  }

  async getWorkbench(teamId: string): Promise<TeamWorkbenchView> {
    const team = this.service.getTeam(teamId)
    const conversations = await Promise.all(Object.values(team.members).map(async member => {
      const owned = this.owned.get(member.sessionId)
      const live = owned?.handle.agent.session.snapshotEvents()
      let events: readonly SessionEvent[]
      if (live !== undefined) {
        events = live
      } else {
        try {
          events = await this.readPersistedEvents(SessionId(member.sessionId))
        } catch {
          events = []
        }
      }
      return this.projectMemberConversation(team, member, events)
    }))
    return {
      schemaVersion: 1,
      teamId: team.id,
      revision: team.revision,
      conversations,
    }
  }

  /** 0.1.5 起以只读句柄读取持久化事件（替代已移除的 `inspect`）。 */
  private async readPersistedEvents(sessionId: SessionId): Promise<readonly SessionEvent[]> {
    const handle = await this.ctx.sessionPersistence.open(sessionId, 'read')
    try {
      return (await handle.read()).events
    } finally {
      await handle.close()
    }
  }

  async stopMember(teamId: string, slotId: string): Promise<void> {
    const team = this.service.getTeam(teamId)
    if (team.state !== 'active') throw new AgentTeamError('TEAM_NOT_ACTIVE', `Team '${team.name}' is not active`)
    const member = team.members[slotId]
    if (member === undefined) throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
    const owned = this.requireOwned(member.sessionId)
    owned.handle.agent.cancel({ kind: 'user' })
    await owned.handle.agent.whenIdle()
    await this.setMemberRuntimeState(teamId, slotId, 'idle')
    const current = this.service.getTeam(teamId)
    const currentMember = current.members[slotId]
    if (currentMember !== undefined) {
      this.service.publishConversation(
        teamId,
        current.revision,
        this.projectMemberConversation(current, currentMember, owned.handle.agent.session.snapshotEvents()),
      )
    }
  }

  async respondToInteraction(
    teamId: string,
    slotId: string,
    interactionId: string,
    response: InteractionResponseInput,
  ): Promise<void> {
    const team = this.service.getTeam(teamId)
    const member = team.members[slotId]
    if (member === undefined) throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
    const owned = this.owned.get(member.sessionId)
    if (owned === undefined || owned.teamId !== teamId || owned.slotId !== slotId) {
      throw new AgentTeamError('INTERACTION_NOT_FOUND', '该交互请求不属于指定的团队成员')
    }
    await this.interactions.respond(member.sessionId, interactionId, response)
  }

  /** 列出成员可用的宿主斜杠命令（完整指令集，UI 不做裁剪）。 */
  async listMemberCommands(teamId: string, slotId: string): Promise<CommandDescriptorView[]> {
    const team = this.service.getTeam(teamId)
    const member = team.members[slotId]
    if (member === undefined) throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
    const owned = this.requireOwned(member.sessionId)
    return this.ctx.commands.list(owned.handle.agent).map(descriptor => ({
      name: descriptor.name,
      description: descriptor.description,
      ...(descriptor.input === undefined ? {} : {
        input: {
          hint: descriptor.input.hint,
          ...(descriptor.input.attachments === true ? { attachments: true } : {}),
        },
      }),
    }))
  }

  /** 以成员身份执行一条宿主斜杠命令；signal 来自 RPC 请求的连接生命周期。 */
  async executeMemberCommand(
    teamId: string,
    slotId: string,
    line: string,
    signal: AbortSignal,
  ): Promise<CommandExecutionView> {
    const team = this.service.getTeam(teamId)
    const member = team.members[slotId]
    if (member === undefined) throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
    const owned = this.requireOwned(member.sessionId)
    const execution = await this.ctx.commands.execute(owned.handle.agent, line, [], signal)
    if (execution === undefined) {
      throw new AgentTeamError('INVALID_REQUEST', `未知的斜杠命令：${line}`)
    }
    return { commandId: execution.commandId, result: execution.result }
  }

  /** /team-compact：队长发起，逐个压缩全队成员上下文；busy 成员跳过不中断。 */
  async compactAllMembers(teamId: string, slotId: string): Promise<CommandCompactAllView> {
    const team = this.service.getTeam(teamId)
    assertCompactCaller(team, slotId)
    const members = Object.values(team.members)
    const signal = new AbortController().signal
    return compactTeamMembers(members, async member => {
      const owned = this.owned.get(member.sessionId)
      if (owned === undefined) return { ok: false, reason: '成员未在线' }
      const execution = await this.ctx.commands.execute(owned.handle.agent, '/compact', [], signal)
      if (execution === undefined) return { ok: false, reason: '命令未解析' }
      return execution.result.kind === 'success'
        ? { ok: true }
        : { ok: false, reason: execution.result.text }
    })
  }

  setMemberPermissionPreset(
    teamId: string,
    slotId: string,
    permissionPresetId: string,
  ): Promise<TeamAggregate> {
    return this.exclusive(teamId, async () => {
      const team = this.service.getTeam(teamId)
      if (team.state !== 'active' && team.state !== 'error') {
        throw new AgentTeamError(
          'TEAM_NOT_ACTIVE',
          `Cannot change member permission while team is '${team.state}'`,
        )
      }
      const member = team.members[slotId]
      if (member === undefined) throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
      const owned = this.requireOwned(member.sessionId)
      const previous = member.permissionPresetId
      this.ctx.permissionPresets.set(owned.handle.agent.session, permissionPresetId)
      try {
        return await this.service.updateRuntimeTeam(
          teamId,
          current => ({
            ...current,
            members: mapMembers(current, currentMember => currentMember.id === slotId
              ? { ...currentMember, permissionPresetId }
              : currentMember),
          }),
          'team.member_permission_changed',
          `Member ${member.displayName} permission changed to ${permissionPresetId}`,
        )
      } catch (error) {
        this.ctx.permissionPresets.set(owned.handle.agent.session, previous)
        throw error
      }
    })
  }

  setMemberReasoningEffort(
    teamId: string,
    slotId: string,
    reasoningEffort: string | undefined,
  ): Promise<TeamAggregate> {
    return this.exclusive(teamId, async () => {
      const team = this.service.getTeam(teamId)
      if (team.state !== 'active' && team.state !== 'error') {
        throw new AgentTeamError(
          'TEAM_NOT_ACTIVE',
          `Cannot change member reasoning while team is '${team.state}'`,
        )
      }
      const member = team.members[slotId]
      if (member === undefined) throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
      const owned = this.requireOwned(member.sessionId)
      const previous = owned.modelSelection.current
      owned.modelSelection.current = {
        provider: member.assistantSnapshot.provider,
        model: member.assistantSnapshot.model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) }),
      }
      try {
        return await this.service.updateRuntimeTeam(
          teamId,
          current => ({
            ...current,
            members: mapMembers(current, currentMember => currentMember.id === slotId
              ? withReasoningEffort(currentMember, reasoningEffort)
              : currentMember),
          }),
          'team.member_reasoning_changed',
          `Member ${member.displayName} reasoning changed to ${reasoningEffort ?? 'model default'}`,
        )
      } catch (error) {
        owned.modelSelection.current = previous
        throw error
      }
    })
  }

  private projectMemberConversation(
    team: TeamAggregate,
    member: TeamMemberSlot,
    events: readonly SessionEvent[],
  ): MemberConversationView {
    const owned = this.owned.get(member.sessionId)
    const status: MemberConversationView['status'] = owned?.handle.agent.status ?? member.lastRuntimeState
    const contextUsage = projectContextUsage(events)
    return {
      slotId: member.id,
      sessionId: member.sessionId,
      status,
      pendingInteractions: this.interactions.list(member.sessionId),
      ...projectConversation(events, 240, {
        team,
        messages: this.service.listMessages(team.id).items,
      }),
      ...(contextUsage === undefined ? {} : { contextUsage }),
    }
  }

  startTeam(teamId: string): Promise<TeamAggregate> {
    return this.exclusive(teamId, () => this.startTeamUnlocked(teamId))
  }

  activateMember(teamId: string, slotId: string): Promise<TeamAggregate> {
    return this.exclusive(teamId, async () => {
      const team = this.service.getTeam(teamId)
      const member = team.members[slotId]
      if (member === undefined) throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
      const materialized = new Set((await this.ctx.sessionPersistence.list()).map(snapshot => String(snapshot.header.id)))
      try {
        await this.ensureMemberOnline(team, member, materialized.has(member.sessionId))
        const current = this.service.getTeam(teamId)
        const readyMember = current.members[slotId]
        if (readyMember === undefined) {
          throw new AgentTeamError('MEMBER_NOT_FOUND', `Member '${slotId}' disappeared during activation`)
        }
        const notice = systemTeamMessage({
          team: current,
          recipientSlotId: current.leaderSlotId,
          content: [
            `新成员「${readyMember.displayName}」已加入团队。`,
            `成员 ID：${readyMember.id}`,
            `模型：${readyMember.assistantSnapshot.provider} / ${readyMember.assistantSnapshot.model}`,
            '状态：已就绪，可以分配任务。',
          ].join('\n'),
        })
        await this.service.updateRuntimeTeam(
          teamId,
          latest => ({ ...latest, outbox: { ...latest.outbox, [notice.id]: notice } }),
          'team.member_ready',
          `Member ${readyMember.displayName} is ready`,
        )
        await this.messages.deliver(teamId, notice.id)
        return this.service.getTeam(teamId)
      } catch (error) {
        await this.markTeamError(teamId, error)
        throw error
      }
    })
  }

  removeMember(teamId: string, slotId: string): Promise<TeamAggregate> {
    return this.exclusive(teamId, async () => {
      const team = this.service.getTeam(teamId)
      if (team.state !== 'active' && team.state !== 'error') {
        throw new AgentTeamError('TEAM_NOT_ACTIVE', `Cannot remove a runtime member while team is '${team.state}'`)
      }
      const member = team.members[slotId]
      if (member === undefined) throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
      if (slotId === team.leaderSlotId) {
        throw new AgentTeamError('MEMBER_IS_LEADER', 'Choose a successor before removing the current leader')
      }
      const openTasks = Object.values(team.tasks).filter(task =>
        task.ownerSlotId === slotId && !['completed', 'failed', 'cancelled'].includes(task.status))
      if (openTasks.length > 0) {
        throw new AgentTeamError('MEMBER_BUSY', 'Resolve this member’s open tasks before removal', {
          taskIds: openTasks.map(task => task.id),
        })
      }

      const owned = this.owned.get(member.sessionId)
      const sessionId = SessionId(member.sessionId)
      if (owned === undefined && this.ctx.agents.get(sessionId) !== undefined) {
        throw new AgentTeamError(
          'AGENT_HANDLE_OWNERSHIP_CONFLICT',
          `Session '${member.sessionId}' is live without this plugin's AgentHandle`,
        )
      }
      if (owned !== undefined) {
        owned.handle.agent.cancel({ kind: 'user' }, { keepInbox: false })
        await owned.handle.agent.whenIdle()
        await this.ctx.sessions.flush(owned.handle.agent.session)
        this.owned.delete(member.sessionId)
        this.interactions.forget(member.sessionId)
        await owned.handle.dispose()
      }
      const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(team.workspaceId))
      if (workspace !== undefined) await workspace.detachSession(sessionId)
      const removedAt = new Date().toISOString()
      const notice = systemTeamMessage({
        team,
        recipientSlotId: team.leaderSlotId,
        content: `团队成员「${member.displayName}」（成员 ID：${member.id}）已被移出团队，其 Session 已停止并归档。后续任务请重新分配给其他成员。`,
      })
      await this.service.updateRuntimeTeam(
        teamId,
        current => {
          const members = { ...current.members }
          delete members[slotId]
          return {
            ...current,
            members,
            retiredSessions: {
              ...current.retiredSessions,
              [member.sessionId]: {
                formerSlotId: member.id,
                sessionId: member.sessionId,
                displayName: member.displayName,
                removedAt,
              },
            },
            outbox: { ...current.outbox, [notice.id]: notice },
          }
        },
        'team.member_removed',
        `Member ${member.displayName} removed; Session history retained`,
      )
        await this.messages.deliver(teamId, notice.id)
      return this.service.getTeam(teamId)
    })
  }

  resetTeam(teamId: string): Promise<TeamAggregate> {
    return this.exclusive(teamId, async () => {
      const team = this.service.getTeam(teamId)
      if (!['draft', 'active', 'error'].includes(team.state)) {
        throw new AgentTeamError('TEAM_NOT_ACTIVE', `Cannot reset team in state '${team.state}'`)
      }

      const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(team.workspaceId))
      if (workspace === undefined || await workspace.status() !== 'ok' || workspace.path !== team.workspacePath) {
        throw new AgentTeamError('WORKSPACE_UNAVAILABLE', `Workspace '${team.workspaceId}' is unavailable or changed`)
      }

      const members = Object.values(team.members)
      for (const member of members) {
        const sessionId = SessionId(member.sessionId)
        if (this.owned.get(member.sessionId) === undefined && this.ctx.agents.get(sessionId) !== undefined) {
          throw new AgentTeamError(
            'AGENT_HANDLE_OWNERSHIP_CONFLICT',
            `Session '${member.sessionId}' is live without this plugin's AgentHandle`,
          )
        }
      }

      const owned = members
        .map(member => ({ member, owned: this.owned.get(member.sessionId) }))
        .filter((entry): entry is { member: TeamMemberSlot; owned: OwnedAgent } => entry.owned !== undefined)
      for (const entry of owned) {
        entry.owned.handle.agent.cancel({ kind: 'user' }, { keepInbox: false })
      }
      await Promise.all(owned.map(entry => entry.owned.handle.agent.whenIdle()))

      for (const entry of owned) {
        try {
          await this.ctx.sessions.flush(entry.owned.handle.agent.session)
        } catch (error) {
          this.ctx.logger.warn(`agent-team: old session flush failed during reset for ${entry.member.sessionId}`, error)
        }
        this.owned.delete(entry.member.sessionId)
        this.interactions.forget(entry.member.sessionId)
        await entry.owned.handle.dispose()
      }
      for (const member of members) {
        try {
          await workspace.detachSession(SessionId(member.sessionId))
        } catch (error) {
          this.ctx.logger.warn(`agent-team: old workspace session detach failed during reset for ${member.sessionId}`, error)
        }
      }

      await this.service.retireQueuedMessages(teamId)
      const resetAt = new Date().toISOString()
      const shouldRestart = team.state !== 'draft'
      const next = await this.service.updateRuntimeTeam(
        teamId,
        current => ({
          ...current,
          state: shouldRestart ? 'starting' : 'draft',
          tasks: {},
          leases: {},
          outbox: {},
          retiredSessions: current.state === 'draft'
            ? current.retiredSessions
            : {
              ...current.retiredSessions,
              ...Object.fromEntries(Object.values(current.members).map(member => [
                member.sessionId,
                {
                  formerSlotId: member.id,
                  sessionId: member.sessionId,
                  displayName: member.displayName,
                  removedAt: resetAt,
                },
              ])),
            },
          members: mapMembers(current, member => ({
            ...member,
            sessionId: `agent-team:${randomUUID()}`,
            desiredState: current.state === 'draft' ? 'offline' : 'online',
            lastRuntimeState: shouldRestart ? 'starting' : 'offline',
          })),
        }),
        'team.context_reset',
        `Team ${team.name} task board and member contexts reset`,
      )

      if (!shouldRestart) return next
      try {
        const assembled = await this.service.refreshMemberSnapshots(teamId)
        await this.ensureMembersOnline(assembled)
        return await this.service.updateRuntimeTeam(
          teamId,
          current => ({ ...current, state: 'active', lastError: undefined }),
          'team.context_reset_completed',
          `Team ${team.name} restarted with fresh member contexts`,
        )
      } catch (error) {
        await this.markTeamError(teamId, error)
        throw error
      }
    })
  }

  dissolveTeam(teamId: string): Promise<void> {
    return this.exclusive(teamId, async () => {
      let team = this.service.getTeam(teamId)
      const members = Object.values(team.members)
      for (const member of members) {
        const sessionId = SessionId(member.sessionId)
        if (this.owned.get(member.sessionId) === undefined && this.ctx.agents.get(sessionId) !== undefined) {
          throw new AgentTeamError(
            'AGENT_HANDLE_OWNERSHIP_CONFLICT',
            `Session '${member.sessionId}' is live without this plugin's AgentHandle`,
          )
        }
      }

      if (team.state !== 'deleting') {
        team = await this.service.updateRuntimeTeam(
          teamId,
          current => ({ ...current, state: 'deleting' }),
          'team.deleting',
          `Team ${team.name} dissolution started`,
        )
      }

      try {
        const owned = members
          .map(member => ({ member, owned: this.owned.get(member.sessionId) }))
          .filter((entry): entry is { member: TeamMemberSlot; owned: OwnedAgent } => entry.owned !== undefined)
        for (const entry of owned) {
          entry.owned.handle.agent.cancel({ kind: 'user' }, { keepInbox: false })
        }
        await Promise.all(owned.map(entry => entry.owned.handle.agent.whenIdle()))

        for (const entry of owned) {
          try {
            await this.ctx.sessions.flush(entry.owned.handle.agent.session)
          } catch (error) {
            this.ctx.logger.warn(`agent-team: final session flush failed during dissolution for ${entry.member.sessionId}`, error)
          }
          await entry.owned.handle.dispose()
          this.owned.delete(entry.member.sessionId)
          this.interactions.forget(entry.member.sessionId)
        }

        const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(team.workspaceId))
        if (workspace !== undefined) {
          const sessionIds = new Set([
            ...members.map(member => member.sessionId),
            ...Object.keys(team.retiredSessions),
          ])
          for (const sessionId of sessionIds) {
            await workspace.detachSession(SessionId(sessionId))
          }
        }

        await this.service.deleteTeamRecords(teamId)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        try {
          await this.service.updateRuntimeTeam(
            teamId,
            current => ({ ...current, state: 'delete_blocked' }),
            'team.delete_blocked',
            message,
          )
        } catch (updateError) {
          this.ctx.logger.warn(`agent-team: failed to persist blocked dissolution for ${teamId}`, updateError)
        }
        throw error instanceof AgentTeamError
          ? error
          : new AgentTeamError(
            'TEAM_DELETE_FAILED',
            `团队“${team.name}”解散失败：${message}`,
            { teamId, cause: message },
            { cause: error },
          )
      }
    })
  }

  async sendUserMessage(
    teamId: string,
    rawContent: string,
    targetSlotId?: string,
  ): Promise<TeamMessage> {
    const team = this.service.getTeam(teamId)
    if (team.state !== 'active') {
      throw new AgentTeamError('TEAM_NOT_ACTIVE', `Team '${team.name}' is not active`)
    }
    const slotId = targetSlotId ?? team.leaderSlotId
    const target = team.members[slotId]
    if (target === undefined) throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
    if (slotId !== team.leaderSlotId && !team.directMemberChat) {
      throw new AgentTeamError('INVALID_REQUEST', 'Direct member chat is disabled for this team')
    }
    const content = requireContent(rawContent)
    const owned = this.requireOwned(target.sessionId)
    const message = createUserMessage({
      content: [{ type: 'text', text: content }],
      source: { kind: 'user' },
    })
    const record = teamMessage({
      id: String(message.id),
      teamId,
      sender: { kind: 'user', id: 'local-user' },
      recipient: slotId === team.leaderSlotId
        ? { kind: 'leader', slotId }
        : { kind: 'member', slotId },
      type: 'instruction',
      content,
      idempotencyKey: String(message.id),
    })
    await this.service.putRuntimeMessage(record)
    try {
      owned.handle.agent.followup(message)
      const delivered = { ...record, deliveryState: 'delivered' as const }
      await this.service.putRuntimeMessage(delivered)
      return delivered
    } catch (error) {
      await this.service.putRuntimeMessage({ ...record, deliveryState: 'failed' })
      throw error
    }
  }

  async recoverTeams(): Promise<void> {
    const recoverable = this.service.listTeams().items.filter(team =>
      team.state === 'active'
      || team.state === 'starting'
      || team.state === 'error')
    await mapConcurrent(recoverable, this.config.runtimeConcurrency, async team => {
      try {
        await this.exclusive(team.id, async () => {
          await this.ensureMembersOnline(team)
      await this.messages.recover(this.service.getTeam(team.id))
          await this.service.updateRuntimeTeam(
            team.id,
            current => ({ ...current, state: 'active', lastError: undefined }),
            'team.recovered',
            `Team ${team.name} recovered after plugin startup`,
          )
        })
      } catch (error) {
        this.ctx.logger.warn(`agent-team: failed to recover team ${team.id}`, error)
        await this.markTeamError(team.id, error)
      }
    })
  }

  async dispose(): Promise<void> {
    if (this.closing) return
    this.closing = true
    this.disposeStatusListener()
    this.disposeConversationListener()
    await this.interactions.dispose()
    for (const timer of this.conversationPublishes.values()) clearTimeout(timer)
    this.conversationPublishes.clear()
    await Promise.allSettled([...this.operations.values()])
    const owned = [...this.owned.values()]
    for (const entry of owned) entry.handle.agent.cancel({ kind: 'disposed' }, { keepInbox: true })
    await Promise.allSettled(owned.map(entry => entry.handle.agent.whenIdle()))
    for (const entry of owned) {
      try {
        await this.ctx.sessions.flush(entry.handle.agent.session)
      } catch (error) {
        this.ctx.logger.warn(`agent-team: session flush failed for ${entry.handle.agent.id}`, error)
      }
    }
    await Promise.allSettled(owned.map(entry => entry.handle.dispose()))
    this.owned.clear()
  }

  private publishOwnedConversation(sessionId: string): void {
    try {
      const owned = this.owned.get(sessionId)
      if (owned === undefined) return
      const team = this.service.getTeam(owned.teamId)
      const member = team.members[owned.slotId]
      if (member === undefined) return
      this.service.publishConversation(
        team.id,
        team.revision,
        this.projectMemberConversation(team, member, owned.handle.agent.session.snapshotEvents()),
      )
    } catch (error) {
      this.ctx.logger.warn('agent-team: failed to publish interaction update', error)
    }
  }

  private async startTeamUnlocked(teamId: string): Promise<TeamAggregate> {
    const team = this.service.getTeam(teamId)
    if (team.state !== 'draft' && team.state !== 'error') {
      throw new AgentTeamError('TEAM_NOT_ACTIVE', `Cannot start team in state '${team.state}'`)
    }
    await this.service.updateRuntimeTeam(
      teamId,
      current => ({
        ...current,
        state: 'starting',
        members: mapMembers(current, member => ({
          ...member,
          desiredState: 'online',
          lastRuntimeState: this.owned.has(member.sessionId) ? member.lastRuntimeState : 'starting',
        })),
      }),
      'team.starting',
      `Team ${team.name} is starting`,
    )
    try {
      await this.service.refreshMemberSnapshots(teamId)
      await this.ensureMembersOnline(this.service.getTeam(teamId))
      await this.messages.recover(this.service.getTeam(teamId))
      return await this.service.updateRuntimeTeam(
        teamId,
        current => ({ ...current, state: 'active', lastError: undefined }),
        'team.started',
        `Team ${team.name} started`,
      )
    } catch (error) {
      await this.markTeamError(teamId, error)
      throw error
    }
  }

  private async ensureMembersOnline(team: TeamAggregate): Promise<void> {
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(team.workspaceId))
    if (workspace === undefined || await workspace.status() !== 'ok' || workspace.path !== team.workspacePath) {
      throw new AgentTeamError('WORKSPACE_UNAVAILABLE', `Workspace '${team.workspaceId}' is unavailable or changed`)
    }
    const materialized = new Set((await this.ctx.sessionPersistence.list()).map(snapshot => String(snapshot.header.id)))
    await mapConcurrent(Object.values(team.members), this.config.runtimeConcurrency, async member => {
      if (member.desiredState === 'removing') return
      await this.ensureMemberOnline(team, member, materialized.has(member.sessionId))
    })
  }

  private async ensureMemberOnline(
    team: TeamAggregate,
    member: TeamMemberSlot,
    persisted: boolean,
  ): Promise<void> {
    const prior = this.owned.get(member.sessionId)
    if (prior !== undefined) return
    const sessionId = SessionId(member.sessionId)
    const live = this.ctx.agents.get(sessionId)
    if (live !== undefined) {
      await this.service.updateRuntimeTeam(
        team.id,
        current => ({ ...current, state: 'ownership_conflict' }),
        'team.ownership_conflict',
        `Session ${member.sessionId} is live but not owned by Agent Team`,
      )
      throw new AgentTeamError(
        'AGENT_HANDLE_OWNERSHIP_CONFLICT',
        `Session '${member.sessionId}' is live without this plugin's AgentHandle`,
      )
    }

    try {
      this.activating.set(member.sessionId, { teamId: team.id, slotId: member.id })
      const modelSelection: ModelSelectionRef = {
        current: {
          provider: member.assistantSnapshot.provider,
          model: member.assistantSnapshot.model,
          ...(member.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: ReasoningEffortId(member.reasoningEffort) }),
        },
        assembled: undefined,
      }
      const setup = async (agentCtx: Context, agent: Agent): Promise<void> => {
        await this.ctx.agentPresets.mount(agentCtx, member.assistantSnapshot.agentPresetId)
        installModelSelection(agentCtx, modelSelection)
        const identitySection = `agent-team:identity:${member.id}`
        const rosterSection = `agent-team:roster:${team.id}`
        agentCtx.systemPrompt.section({
          name: identitySection,
          order: 10,
          text: () => {
            const latest = this.service.getTeam(team.id)
            const latestMember = latest.members[member.id]
            return latestMember === undefined
              ? 'This Agent Team membership is no longer active.'
              : memberPrompt(latest, latestMember)
          },
        })
        agentCtx.systemPrompt.section({
          name: rosterSection,
          order: 11,
          text: () => rosterPrompt(this.service.getTeam(team.id)),
        })
        registerTeamTools(agentCtx, {
          assertIdentity: agent => { this.assertToolIdentity(agent, team.id, member.id) },
          getTaskBoard: () => {
            const latest = this.service.getTeam(team.id)
            const tasks = JSON.parse(JSON.stringify(Object.values(latest.tasks))) as Array<Record<string, string | number | string[]>>
            return { teamId: latest.id, revision: latest.revision, tasks }
          },
          createTask: input => this.commands.createTask(team.id, member.id, input),
          updateTask: input => this.commands.updateTask(team.id, member.id, input),
          sendMessage: (recipientSlotId, content, type) => (
            this.commands.sendMemberMessage(team.id, member.id, recipientSlotId, content, type)
          ),
        })
        this.interactions.attachAgentContext(agentCtx)
        const selectedMcpServers = new Set(member.assistantSnapshot.mcpServers)
        const mcpTools = agentCtx.tools.schemas(agent).flatMap(tool => {
          const serverName = mcpServerFromToolName(tool.name)
          return serverName === undefined ? [] : [{ name: tool.name, serverName }]
        })
        const availableMcpServers = new Set(mcpTools.map(tool => tool.serverName))
        const missingMcpServers = [...selectedMcpServers]
          .filter(serverName => !availableMcpServers.has(serverName))
        if (missingMcpServers.length > 0) {
          throw new AgentTeamError(
            'MCP_REFERENCE_INVALID',
            `Member '${member.displayName}' cannot access selected MCP Server(s): ${missingMcpServers.join(', ')}`,
            { memberId: member.id, missing: missingMcpServers },
          )
        }
        const deniedMcpTools = mcpTools
          .filter(tool => !selectedMcpServers.has(tool.serverName))
          .map(tool => tool.name)
        if (deniedMcpTools.length > 0) agentCtx.tools.restrict({ deny: deniedMcpTools })
        agentCtx.tools.guard(execution => {
          const serverName = mcpServerFromToolName(execution.name)
          return serverName === undefined || selectedMcpServers.has(serverName)
            ? undefined
            : 'This MCP Server is not selected for the assistant.'
        })
        const selectedSkills = new Set(member.assistantSnapshot.skillAllowlist)
        const skills = await this.ctx.skills.list({
          cwd: team.workspacePath,
          scope: agent,
        })
        const available = new Set(skills
          .filter(skill => isModelInvocable(skill) || isUserInvocable(skill))
          .map(skill => skill.name))
        const missing = [...selectedSkills].filter(name => !available.has(name))
        if (missing.length > 0) {
          throw new AgentTeamError(
            'SKILL_REFERENCE_INVALID',
            `Member '${member.displayName}' cannot access selected Skill(s): ${missing.join(', ')}`,
            { memberId: member.id, missing },
          )
        }
        if (selectedSkills.size > 0 && agentCtx.tools.get('skill', agent) === undefined) {
          throw new AgentTeamError(
            'SKILL_REFERENCE_INVALID',
            `Member '${member.displayName}' selected Skills, but its Agent Preset does not expose the skill loader`,
            { memberId: member.id },
          )
        }
        const presetScope = await this.ctx.agentPresets.standingKeyFor(
          member.assistantSnapshot.agentPresetId,
        )
        const skillSelectionProvider = `agent-team-selection-${member.id}`
        await registerScopedSkillProvider(agentCtx, () => ({
          name: skillSelectionProvider,
          list: async options => {
            const inherited = await this.ctx.skills.list({
              cwd: options.cwd,
              signal: options.signal,
              scope: presetScope,
            })
            return inherited.filter(skill => !selectedSkills.has(skill.name)).map(skill => ({
              name: skill.name,
              description: skill.description,
              invocation: { modelInvocable: false, userInvocable: false },
              source: 'runtime',
              provider: skillSelectionProvider,
              rank: 0,
              locator: skill.name,
            }))
          },
          get: async candidate => ({
            name: candidate.name,
            description: candidate.description,
            invocation: { modelInvocable: false, userInvocable: false },
            source: 'runtime',
            provider: skillSelectionProvider,
            content: '',
          }),
        }))
        agentCtx.tools.guard(execution => {
          if (execution.name !== 'skill') return undefined
          const name = skillNameFromArguments(execution.arguments)
          return name !== undefined && selectedSkills.has(name)
            ? undefined
            : 'This Skill is not selected for the assistant.'
        })
        this.ctx.permissionPresets.set(
          agent.session,
          member.permissionPresetId,
        )
        const assembly = await agentCtx.systemPrompt.assemble(assembleContextFor(agent))
        const names = new Set(assembly.sections.map(section => section.name))
        if (!names.has(identitySection) || !names.has(rosterSection)) {
          throw new AgentTeamError(
            'PRESET_PROMPT_INCOMPATIBLE',
            `Preset '${member.assistantSnapshot.agentPresetId}' replaced Agent Team prompt sections`,
          )
        }
      }
      const agentOptions = {
        provider: member.assistantSnapshot.provider,
        model: member.assistantSnapshot.model,
      }
      const handle = persisted
        ? await this.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
        : await this.ctx.agents.create({
          sessionId,
          meta: { cwd: team.workspacePath, agentPreset: member.assistantSnapshot.agentPresetId },
          agentOptions,
          setup,
        })
      const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(team.workspaceId))
      if (workspace === undefined) {
        await handle.dispose()
        throw new AgentTeamError('WORKSPACE_UNAVAILABLE', 'Workspace disappeared during start')
      }
      try {
        await workspace.attachSession(sessionId)
      } catch (error) {
        await handle.dispose()
        throw error
      }
      this.owned.set(member.sessionId, {
        teamId: team.id,
        slotId: member.id,
        handle,
        modelSelection,
      })
      this.activating.delete(member.sessionId)
      await this.setMemberRuntimeState(team.id, member.id, handle.agent.status)
    } catch (error) {
      this.activating.delete(member.sessionId)
      const causeMessage = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(
        `agent-team: member '${member.displayName}' activation failed: ${causeMessage}`,
        error,
      )
      throw error instanceof AgentTeamError
        ? error
        : new AgentTeamError(
          'SESSION_CREATE_FAILED',
          `成员“${member.displayName}”启动失败：${causeMessage}`,
          { memberId: member.id, cause: causeMessage },
          { cause: error },
        )
    }
  }



  private assertToolIdentity(agent: Agent | undefined, teamId: string, slotId: string): void {
    if (agent === undefined) throw new AgentTeamError('INVALID_REQUEST', 'Team tool requires an Agent caller')
    const owned = this.owned.get(String(agent.id))
    const identity = owned ?? this.activating.get(String(agent.id))
    if (identity === undefined || identity.teamId !== teamId || identity.slotId !== slotId) {
      throw new AgentTeamError('INVALID_REQUEST', 'Team tool caller identity does not match its scoped member')
    }
  }

  private requireOwned(sessionId: string): OwnedAgent {
    const owned = this.owned.get(sessionId)
    if (owned === undefined) {
      throw new AgentTeamError('TEAM_NOT_ACTIVE', `Team member session '${sessionId}' is not online`)
    }
    return owned
  }

  private async setMemberRuntimeState(
    teamId: string,
    slotId: string,
    state: 'idle' | 'running',
  ): Promise<void> {
    const current = this.service.getTeam(teamId)
    if (current.members[slotId]?.lastRuntimeState === state) return
    await this.service.updateRuntimeTeam(
      teamId,
      team => ({
        ...team,
        members: mapMembers(team, member => member.id === slotId
          ? { ...member, desiredState: 'online', lastRuntimeState: state }
          : member),
      }),
      'team.member_status',
      `Member ${slotId} entered ${state}`,
    )
  }

  private async markTeamError(teamId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error)
    await this.service.updateRuntimeTeam(
      teamId,
      team => ({
        ...team,
        state: team.state === 'ownership_conflict' ? team.state : 'error',
        lastError: {
          ...(error instanceof AgentTeamError ? { code: error.code } : {}),
          message,
          failedAt: new Date().toISOString(),
        },
      }),
      'team.runtime_error',
      message,
    )
  }


  private exclusive<T>(teamId: string, operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('Agent Team runtime is closing'))
    const prior = this.operations.get(teamId) ?? Promise.resolve()
    const current = prior.catch(() => undefined).then(operation)
    this.operations.set(teamId, current)
    void current.finally(() => {
      if (this.operations.get(teamId) === current) this.operations.delete(teamId)
    }).catch(() => undefined)
    return current
  }
}

function mapMembers(
  team: TeamAggregate,
  map: (member: TeamMemberSlot) => TeamMemberSlot,
): TeamAggregate['members'] {
  return Object.fromEntries(Object.entries(team.members).map(([id, member]) => [id, map(member)]))
}

/** /team-compact 仅队长可发起；slotId 必须等于团队 leaderSlotId。 */
export function assertCompactCaller(
  team: Pick<TeamAggregate, 'leaderSlotId' | 'name'>,
  slotId: string,
): void {
  if (slotId !== team.leaderSlotId) {
    throw new AgentTeamError(
      'INVALID_REQUEST',
      `「/team-compact」仅队长（Leader）可执行，团队 '${team.name}' 的 Leader 是 '${team.leaderSlotId}'`,
    )
  }
}

/** 单个成员的压缩执行结果。 */
export interface CompactMemberOutcome {
  ok: boolean
  reason?: string
}

/**
 * 逐个压缩全队成员：单个成员失败/忙碌不中断整体，跳过并记录原因。
 * executeOne 的异常同样折叠为 skipped（防御宿主命令抛错）。
 */
export async function compactTeamMembers(
  members: readonly TeamMemberSlot[],
  executeOne: (member: TeamMemberSlot) => Promise<CompactMemberOutcome>,
): Promise<CommandCompactAllView> {
  const compacted: CommandCompactAllView['compacted'] = []
  const skipped: CommandCompactAllView['skipped'] = []
  for (const member of members) {
    let outcome: CompactMemberOutcome
    try {
      outcome = await executeOne(member)
    } catch (error) {
      outcome = { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
    if (outcome.ok) {
      compacted.push({ slotId: member.id, displayName: member.displayName })
    } else {
      skipped.push({ slotId: member.id, displayName: member.displayName, reason: outcome.reason ?? '未知原因' })
    }
  }
  return { compacted, skipped }
}

function withReasoningEffort(
  member: TeamMemberSlot,
  reasoningEffort: string | undefined,
): TeamMemberSlot {
  const { reasoningEffort: _current, ...rest } = member
  return reasoningEffort === undefined ? rest : { ...rest, reasoningEffort }
}

function skillNameFromArguments(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('name' in value)) return undefined
  return typeof value.name === 'string' ? value.name : undefined
}

async function mapConcurrent<T>(
  values: readonly T[],
  concurrency: number,
  run: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++
      await run(values[index]!)
    }
  })
  await Promise.all(workers)
}
