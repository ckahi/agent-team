import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../src/config.js'
import { AgentTeamError } from '../src/domain/errors.js'
import type {
  AssistantTemplate,
  Operation,
  TeamActivity,
  TeamAggregate,
  TeamMessage,
} from '../src/domain/types.js'
import { AgentTeamService } from '../src/service/agent-team-service.js'
import type { AgentTeamStore } from '../src/storage/store.js'
import { TeamRuntime } from '../src/runtime/team-runtime.js'
import type { TeamCommandHandler } from '../src/runtime/team-command-handler.js'
import type { TeamMessageDispatcher } from '../src/runtime/team-message-dispatcher.js'
import { ASSISTANT_BUILDER_PROMPT } from '../src/runtime/assistant-builder-runtime.js'

const config: Config = {
  maxRequestBytes: 128 * 1024,
  sseHeartbeatMs: 20_000,
  runtimeConcurrency: 4,
  directMemberChatDefault: true,
  assistantBuilderProvider: '',
  assistantBuilderModel: '',
  assistantBuilderAgentPresetId: '',
  assistantBuilderPermissionPresetId: '',
}

describe('AgentTeamService', () => {
  it('announces model directory changes so open selectors refresh', () => {
    const { ctx, service } = createHarness()
    const listener = vi.fn()
    service.subscribe(listener)

    ctx.emit('llm/adapters-updated')

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      entityType: 'catalog',
      entityId: 'models',
      kind: 'catalog.models_updated',
    }))
  })

  it('reuses identical uploads and only renames same-name files with different content', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'agent-team-upload-'))
    try {
      const { service } = createHarness(workspacePath)
      const assistant = await service.createAssistant(assistantInput())
      const team = await service.createTeamDraft({
        name: 'Upload team',
        workspaceId: 'workspace-1',
        directMemberChat: true,
        members: [{ assistantId: assistant.id, role: 'leader' }],
      })
      const bytes = new TextEncoder().encode('hello')
      const changedBytes = new TextEncoder().encode('changed')

      const first = await service.uploadWorkspaceFile(team.id, '../notes.txt', bytes)
      const duplicate = await service.uploadWorkspaceFile(team.id, '../notes.txt', bytes)
      const changed = await service.uploadWorkspaceFile(team.id, '../notes.txt', changedBytes)
      const changedDuplicate = await service.uploadWorkspaceFile(team.id, '../notes.txt', changedBytes)

      expect(first).toEqual({ name: 'notes.txt', path: '.agent-team/uploads/notes.txt', bytes: 5 })
      expect(duplicate).toEqual(first)
      expect(changed).toEqual({ name: 'notes (1).txt', path: '.agent-team/uploads/notes (1).txt', bytes: 7 })
      expect(changedDuplicate).toEqual(changed)
      await expect(readFile(join(workspacePath, first.path), 'utf8')).resolves.toBe('hello')
      await expect(readFile(join(workspacePath, changed.path), 'utf8')).resolves.toBe('changed')
    } finally {
      await rm(workspacePath, { recursive: true, force: true })
    }
  })

  it('lists the earliest created assistants first', async () => {
    const { service, store } = createHarness()
    const base = {
      schemaVersion: 1 as const,
      description: undefined,
      icon: undefined,
      instructions: 'Coordinate the team.',
      provider: 'openai',
      model: 'codex',
      agentPresetId: 'default',
      permissionPresetId: 'standard',
      skillAllowlist: [],
      mcpServers: [],
      revision: 1,
    }
    await store.putAssistant({
      ...base,
      id: 'older-assistant',
      name: 'Older assistant',
      createdAt: '2026-08-17T08:00:00.000Z',
      updatedAt: '2026-08-17T08:00:00.000Z',
    })
    await store.putAssistant({
      ...base,
      id: 'newer-assistant',
      name: 'Newer assistant',
      createdAt: '2026-08-18T08:00:00.000Z',
      updatedAt: '2026-08-18T08:00:00.000Z',
    })

    expect(service.listAssistants().items.map(assistant => assistant.id)).toEqual([
      'older-assistant',
      'newer-assistant',
    ])
  })

  it('delegates the built-in assistant builder conversation without storing it as a template', async () => {
    const { service, store } = createHarness()
    const conversation = {
      schemaVersion: 1 as const,
      sessionId: 'agent-team:assistant-builder',
      status: 'idle' as const,
      throughSeq: -1,
      nodes: [],
      pendingInteractions: [],
      configuration: {
        provider: 'test-provider',
        model: 'test-model',
        agentPresetId: 'standard',
        permissionPresetId: 'workspace-write',
      },
    }
    const draft = {
      schemaVersion: 1 as const,
      configuration: conversation.configuration,
    }
    const builder = {
      listConversations: vi.fn(async () => ({ items: [], total: 0 })),
      getDraft: vi.fn(async () => draft),
      configureDraft: vi.fn(async () => ({
        ...draft,
        configuration: {
          ...draft.configuration,
          provider: 'another-provider',
          model: 'another-model',
        },
      })),
      startConversation: vi.fn(async () => conversation),
      getConversation: vi.fn(async () => conversation),
      configure: vi.fn(async () => ({
        ...conversation,
        configuration: {
          ...conversation.configuration,
          provider: 'another-provider',
          model: 'another-model',
        },
      })),
      sendMessage: vi.fn(async () => ({ messageId: 'message-1' })),
      respondToInteraction: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      archiveConversation: vi.fn(async () => {}),
    }
    service.attachAssistantBuilderRuntime(builder as never)

    await expect(service.listAssistantBuilderConversations()).resolves.toEqual({ items: [], total: 0 })
    await expect(service.getAssistantBuilderDraft()).resolves.toEqual(draft)
    await expect(service.configureAssistantBuilderDraft('another-provider', 'another-model')).resolves.toMatchObject({
      configuration: { provider: 'another-provider', model: 'another-model' },
    })
    await expect(service.startAssistantBuilderConversation(
      'test-provider',
      'test-model',
      'Create a reviewer',
    )).resolves.toEqual(conversation)
    await expect(service.getAssistantBuilderConversation(conversation.sessionId)).resolves.toEqual(conversation)
    await expect(service.configureAssistantBuilder(conversation.sessionId, 'another-provider', 'another-model')).resolves.toMatchObject({
      configuration: { provider: 'another-provider', model: 'another-model' },
    })
    await expect(service.sendAssistantBuilderMessage(conversation.sessionId, 'Create a reviewer')).resolves.toEqual({ messageId: 'message-1' })
    await service.respondToAssistantBuilderInteraction(conversation.sessionId, 'question:1', {
      kind: 'question',
      answers: [{ id: 'name', selected: ['Reviewer'] }],
    })
    await service.stopAssistantBuilder(conversation.sessionId)
    await service.archiveAssistantBuilderConversation(conversation.sessionId)

    expect(builder.sendMessage).toHaveBeenCalledWith(conversation.sessionId, 'Create a reviewer')
    expect(builder.respondToInteraction).toHaveBeenCalledWith(
      conversation.sessionId,
      'question:1',
      { kind: 'question', answers: [{ id: 'name', selected: ['Reviewer'] }] },
    )
    expect(builder.startConversation).toHaveBeenCalledWith('test-provider', 'test-model', 'Create a reviewer')
    expect(builder.configureDraft).toHaveBeenCalledWith('another-provider', 'another-model')
    expect(builder.configure).toHaveBeenCalledWith(conversation.sessionId, 'another-provider', 'another-model')
    expect(builder.stop).toHaveBeenCalledWith(conversation.sessionId)
    expect(builder.archiveConversation).toHaveBeenCalledWith(conversation.sessionId)
    expect(store.listAssistants()).toHaveLength(0)
    expect(ASSISTANT_BUILDER_PROMPT).toContain('assistant_builder_get_catalog')
    expect(ASSISTANT_BUILDER_PROMPT).toContain('assistant_builder_prepare')
    expect(ASSISTANT_BUILDER_PROMPT).toContain('assistant_builder_commit')
    expect(ASSISTANT_BUILDER_PROMPT).not.toContain('assistant_builder_create')
    expect(ASSISTANT_BUILDER_PROMPT).toContain('必须等待新的用户消息')
    expect(ASSISTANT_BUILDER_PROMPT).toContain('不要要求固定口令')
    expect(ASSISTANT_BUILDER_PROMPT).toContain('明确表达同意')
    expect(ASSISTANT_BUILDER_PROMPT).toContain('不要询问或限制普通工具')
    expect(ASSISTANT_BUILDER_PROMPT).toContain('MCP Servers')
    expect(ASSISTANT_BUILDER_PROMPT).toContain('优先调用 ask_user_question')
  })

  it('lists model- or user-invocable Skills with their invocation policy', async () => {
    const { service } = createHarness()

    await expect(service.skillCatalog('default')).resolves.toEqual({
      agentPresetId: 'default',
      skills: [{
        name: 'code-review',
        description: 'Review code changes.',
        source: 'user-agents',
        modelInvocable: true,
        userInvocable: true,
      }, {
        name: 'manual-only',
        description: 'Only users may invoke this.',
        source: 'user-agents',
        modelInvocable: false,
        userInvocable: true,
      }],
    })
  })

  it('groups MCP tools by Server for the chosen Agent Preset', async () => {
    const { service } = createHarness()

    await expect(service.mcpCatalog('default')).resolves.toEqual({
      agentPresetId: 'default',
      servers: [
        {
          name: 'figma',
          tools: [{ name: 'mcp__figma__inspect', description: 'Inspect a Figma node.' }],
        },
        {
          name: 'github',
          tools: [
            { name: 'mcp__github__create_issue', description: 'Create an issue.' },
            { name: 'mcp__github__list_issues', description: 'List issues.' },
          ],
        },
      ],
    })
  })

  it('localizes built-in permission preset names while preserving their ids', async () => {
    const { service } = createHarness()

    await expect(service.catalog()).resolves.toMatchObject({
      permissionPresets: [
        { value: 'standard', name: '标准' },
        { value: 'workspace-write', name: '工作区可写' },
      ],
    })
  })

  it('reads and validates exact-model reasoning efforts without hard-coded ids', async () => {
    const { service } = createHarness()

    await expect(service.modelCapabilities('openai', 'codex')).resolves.toEqual({
      provider: 'openai',
      model: 'codex',
      reasoning: {
        efforts: [
          { id: 'low', name: 'Low', description: 'Faster reasoning.' },
          { id: 'high', name: 'High' },
        ],
        defaultEffort: 'low',
      },
    })

    const assistant = await service.createAssistant({
      ...assistantInput(),
      reasoningEffort: 'high',
    })
    const team = await service.createTeamDraft({
      name: 'Reasoning Team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    const member = team.members[team.leaderSlotId]!

    expect(assistant.reasoningEffort).toBe('high')
    expect(member.reasoningEffort).toBe('high')
    expect(member.assistantSnapshot.reasoningEffort).toBe('high')
    await expect(service.createAssistant({
      ...assistantInput(),
      reasoningEffort: 'invented',
    })).rejects.toMatchObject({ code: 'MODEL_REFERENCE_INVALID' })
  })

  it('changes a draft member reasoning effort without modifying the assistant default', async () => {
    const { service } = createHarness()
    const assistant = await service.createAssistant({
      ...assistantInput(),
      reasoningEffort: 'low',
    })
    const team = await service.createTeamDraft({
      name: 'Reasoning Override Team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    const member = team.members[team.leaderSlotId]!

    const changed = await service.setMemberReasoningEffort(team.id, member.id, 'high')
    const restoredDefault = await service.setMemberReasoningEffort(changed.id, member.id, undefined)

    expect(changed.members[member.id]?.reasoningEffort).toBe('high')
    expect(restoredDefault.members[member.id]?.reasoningEffort).toBeUndefined()
    expect(service.getAssistant(assistant.id).reasoningEffort).toBe('low')
  })

  it('validates an assistant draft without storing it', async () => {
    const { service, store } = createHarness()

    await expect(service.validateAssistantDraft({
      ...assistantInput(),
      name: '  Codex Lead  ',
    })).resolves.toMatchObject({ name: 'Codex Lead' })

    expect(store.listAssistants()).toHaveLength(0)
  })

  describe('validateAssistantUpdate', () => {
    it('merges the patch over the current template and reports the revision without storing', async () => {
      const { service, store } = createHarness()
      const assistant = await service.createAssistant(assistantInput())

      const validated = await service.validateAssistantUpdate(assistant.id, {
        instructions: 'Updated instructions.',
        reasoningEffort: 'high',
      })

      expect(validated.id).toBe(assistant.id)
      expect(validated.expectedRevision).toBe(1)
      expect(validated.value).toMatchObject({
        name: 'Codex Lead',
        instructions: 'Updated instructions.',
        reasoningEffort: 'high',
        provider: 'openai',
        model: 'codex',
        agentPresetId: 'default',
        permissionPresetId: 'standard',
        skillAllowlist: [],
        mcpServers: [],
      })
      expect(store.getAssistant(assistant.id)?.instructions).toBe('Coordinate the team.')
      expect(store.getAssistant(assistant.id)?.revision).toBe(1)
    })

    it('is idempotent for the same patch', async () => {
      const { service } = createHarness()
      const assistant = await service.createAssistant(assistantInput())
      const first = await service.validateAssistantUpdate(assistant.id, { name: 'Renamed' })
      const second = await service.validateAssistantUpdate(assistant.id, { name: 'Renamed' })
      expect(second).toEqual(first)
    })

    it('rejects an unknown assistant id', async () => {
      const { service } = createHarness()
      await expect(service.validateAssistantUpdate('missing', { name: 'X' }))
        .rejects.toMatchObject({ code: 'ASSISTANT_NOT_FOUND' })
    })

    it('rejects unknown patch fields', async () => {
      const { service } = createHarness()
      const assistant = await service.createAssistant(assistantInput())
      await expect(service.validateAssistantUpdate(assistant.id, { nonsenseField: true } as never))
        .rejects.toThrow()
    })

    it('rejects an invalid permission preset reference', async () => {
      const { service } = createHarness()
      const assistant = await service.createAssistant(assistantInput())
      await expect(service.validateAssistantUpdate(assistant.id, { permissionPresetId: 'nonexistent' }))
        .rejects.toMatchObject({ code: 'PERMISSION_PRESET_INVALID' })
    })
  })

  it('creates a multi-member draft and dissolves only the team', async () => {
    const { service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const team = await service.createTeamDraft({
      name: 'Compiler Team',
      workspaceId: 'workspace-1',
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })

    expect(Object.values(team.members)).toHaveLength(2)
    expect(Object.values(team.members).map(member => member.displayName)).toEqual(['Codex Lead', 'Codex Lead'])
    expect(new Set(Object.values(team.members).map(member => member.sessionId)).size).toBe(2)
    expect(() => service.getAssistant(assistant.id)).not.toThrow()

    await expect(service.dissolveTeam(team.id, 'wrong')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await service.dissolveTeam(team.id, team.name)

    expect(store.getTeam(team.id)).toBeUndefined()
    expect(store.listMessages(team.id)).toHaveLength(0)
    expect(store.listActivities(team.id)).toHaveLength(0)
    expect(service.getAssistant(assistant.id).name).toBe('Codex Lead')
  })

  it('clones team configuration into fresh members and sessions without runtime records', async () => {
    const { service, store } = createHarness()
    const assistant = await service.createAssistant({
      ...assistantInput(),
      reasoningEffort: 'low',
      skillAllowlist: ['code-review'],
      mcpServers: ['github'],
    })
    const draft = await service.createTeamDraft({
      name: 'Source Team',
      workspaceId: 'workspace-1',
      directMemberChat: false,
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })
    const memberId = Object.values(draft.members).find(member => member.role === 'member')!.id
    const configured = await service.setMemberPermissionPreset(draft.id, memberId, 'workspace-write')
    const source = await store.updateTeam(configured.id, team => ({
      ...team,
      tasks: {
        'task-1': {
          id: 'task-1',
          title: 'Existing work',
          description: 'Do not copy this task.',
          status: 'running',
          ownerSlotId: memberId,
          dependencyIds: [],
          fileScopes: [],
          revision: 1,
          createdAt: team.createdAt,
          updatedAt: team.updatedAt,
        },
      },
    }))
    await service.updateAssistant(assistant.id, { instructions: 'Updated after team creation.' })

    const clone = await service.cloneTeam(source.id, {
      name: 'Copied Team',
      workspaceId: 'workspace-1',
    })
    const sourceMembers = Object.values(source.members)
    const clonedMembers = Object.values(clone.members)

    expect(clone).toMatchObject({
      name: 'Copied Team',
      workspaceId: 'workspace-1',
      state: 'draft',
      directMemberChat: false,
      revision: 1,
      tasks: {},
      leases: {},
      outbox: {},
      retiredSessions: {},
    })
    expect(clone.id).not.toBe(source.id)
    expect(clonedMembers.map(member => member.displayName)).toEqual(sourceMembers.map(member => member.displayName))
    expect(clonedMembers.map(member => member.role)).toEqual(sourceMembers.map(member => member.role))
    expect(clonedMembers.map(member => member.permissionPresetId)).toEqual(sourceMembers.map(member => member.permissionPresetId))
    expect(clonedMembers.every(member => member.assistantSnapshot.instructions === 'Coordinate the team.')).toBe(true)
    expect(clonedMembers.every(member => member.assistantSnapshot.skillAllowlist[0] === 'code-review')).toBe(true)
    expect(clonedMembers.every(member => member.assistantSnapshot.mcpServers[0] === 'github')).toBe(true)
    expect(new Set(clonedMembers.map(member => member.id)).size).toBe(clonedMembers.length)
    expect(new Set(clonedMembers.map(member => member.sessionId)).size).toBe(clonedMembers.length)
    expect(clonedMembers.every(member => !sourceMembers.some(sourceMember => sourceMember.id === member.id))).toBe(true)
    expect(clonedMembers.every(member => !sourceMembers.some(sourceMember => sourceMember.sessionId === member.sessionId))).toBe(true)
    expect(clone.members[clone.leaderSlotId]?.role).toBe('leader')
    expect(service.getTeam(source.id).tasks['task-1']).toBeDefined()
  })

  it('rejects cloning into an unavailable Workspace', async () => {
    const { service } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const source = await service.createTeamDraft({
      name: 'Source Team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })

    await expect(service.cloneTeam(source.id, {
      name: 'Copied Team',
      workspaceId: 'missing-workspace',
    })).rejects.toMatchObject({ code: 'WORKSPACE_UNAVAILABLE' })
  })

  it('rejects malformed Skill names before storing a template', async () => {
    const { service } = createHarness()
    await expect(service.createAssistant({
      ...assistantInput(),
      skillAllowlist: ['Not A Skill'],
    })).rejects.toMatchObject({ code: 'SKILL_REFERENCE_INVALID' })
  })

  it('rejects MCP Servers that are malformed or unavailable to the Agent Preset', async () => {
    const { service } = createHarness()

    await expect(service.createAssistant({
      ...assistantInput(),
      mcpServers: ['bad server'],
    })).rejects.toMatchObject({ code: 'MCP_REFERENCE_INVALID' })
    await expect(service.createAssistant({
      ...assistantInput(),
      mcpServers: ['missing'],
    })).rejects.toMatchObject({ code: 'MCP_REFERENCE_INVALID' })
  })

  it('persists selected MCP Servers into new team member snapshots', async () => {
    const { service } = createHarness()
    const assistant = await service.createAssistant({
      ...assistantInput(),
      mcpServers: ['github', 'github'],
    })
    const team = await service.createTeamDraft({
      name: 'MCP Team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })

    expect(assistant.mcpServers).toEqual(['github'])
    expect(Object.values(team.members)[0]?.assistantSnapshot.mcpServers).toEqual(['github'])
  })

  it('rejects the removed maxTokens field', async () => {
    const { service } = createHarness()
    await expect(service.createAssistant({
      ...assistantInput(),
      maxTokens: 4096,
    } as never)).rejects.toThrow()
  })

  it('dissolves a started team while preserving its assistant template', async () => {
    const { ctx, service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Durable Team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const team = service.getTeam(draft.id)
    const member = team.members[team.leaderSlotId]!
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    const agent = fakeAgent()
    runtimeInternals(runtime).owned.set(member.sessionId, fakeOwned(agent))

    await service.dissolveTeam(team.id, team.name)

    expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
    expect(agent.whenIdle).toHaveBeenCalledOnce()
    expect(runtimeInternals(runtime).owned.size).toBe(0)
    expect(store.getTeam(draft.id)).toBeUndefined()
    expect(store.getAssistant(assistant.id)).toBeDefined()
  })

  it('keeps a failed started-team dissolution retryable', async () => {
    const { ctx, service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Retryable Team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const team = service.getTeam(draft.id)
    const member = team.members[team.leaderSlotId]!
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    const agent = fakeAgent()
    runtimeInternals(runtime).owned.set(member.sessionId, {
      teamId: team.id,
      slotId: member.id,
      handle: {
        agent,
        dispose: vi.fn(async () => { throw new Error('dispose failed') }),
      },
    })

    await expect(service.dissolveTeam(team.id, team.name)).rejects.toMatchObject({ code: 'TEAM_DELETE_FAILED' })

    expect(store.getTeam(team.id)?.state).toBe('delete_blocked')
    expect(store.getAssistant(assistant.id)).toBeDefined()
  })

  it('adds, promotes, and removes draft members without changing templates', async () => {
    const { service } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Mutable Draft',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    const added = await service.addMember(draft.id, {
      assistantId: assistant.id,
    }, { expectedRevision: draft.revision })
    const second = Object.values(added.members).find(member => member.id !== draft.leaderSlotId)!
    const promoted = await service.changeLeader(added.id, second.id, { expectedRevision: added.revision })
    const original = promoted.members[draft.leaderSlotId]!
    const removed = await service.removeMember(promoted.id, original.id, { expectedRevision: promoted.revision })

    expect(Object.values(removed.members).map(member => member.displayName)).toEqual(['Codex Lead'])
    expect(service.getAssistant(assistant.id).revision).toBe(1)
  })

  it('notifies the leader after a new live member is ready', async () => {
    const { ctx, service, store } = createHarness()
    ctx.provide('sessionPersistence', { list: async () => [] } as never)
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Growing Team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const team = service.getTeam(draft.id)
    const leader = team.members[team.leaderSlotId]!
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    const leaderAgent = fakeAgent()
    const ensureMemberOnline = vi.fn(async () => {})
    runtimeInternals(runtime).owned.set(leader.sessionId, fakeOwned(leaderAgent))
    runtimeInternals(runtime).ensureMemberOnline = ensureMemberOnline

    const added = await service.addMember(team.id, {
      assistantId: assistant.id,
    }, { expectedRevision: team.revision })
    const member = Object.values(added.members).find(value => value.id !== leader.id)!

    expect(ensureMemberOnline).toHaveBeenCalledOnce()
    expect(leaderAgent.followup).toHaveBeenCalledOnce()
    expect(leaderAgent.followup.mock.calls[0]?.[0]).toMatchObject({
      source: { kind: 'plugin', plugin: 'dsh-agent-team', form: 'relay' },
      content: [{ type: 'text', text: expect.stringContaining(member.id) }],
    })
    expect(Object.keys(added.outbox)).toHaveLength(0)
    expect(service.listMessages(team.id).items).toContainEqual(expect.objectContaining({
      sender: { kind: 'system', id: 'dsh-agent-team' },
      recipient: { kind: 'leader', slotId: leader.id },
      type: 'system',
      deliveryState: 'delivered',
    }))
  })

  it('adds a member to an error team without activating it', async () => {
    const { ctx, service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Stalled Team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'error' }))
    const team = service.getTeam(draft.id)
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    const ensureMemberOnline = vi.fn(async () => {})
    runtimeInternals(runtime).ensureMemberOnline = ensureMemberOnline

    const added = await service.addMember(team.id, {
      assistantId: assistant.id,
    }, { expectedRevision: team.revision })

    const second = Object.values(added.members).find(value => value.id !== team.leaderSlotId)!
    expect(added.state).toBe('error')
    expect(second.desiredState).toBe('offline')
    expect(service.getTeam(team.id).revision).toBe(team.revision + 1)
    expect(ensureMemberOnline).not.toHaveBeenCalled()
  })

  it('still refuses to add members while a team is starting', async () => {
    const { service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Starting Team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'starting' }))
    const team = service.getTeam(draft.id)

    await expect(service.addMember(team.id, { assistantId: assistant.id }))
      .rejects.toMatchObject({ code: 'TEAM_NOT_ACTIVE' })
  })

  it('retries starting an error team back to active', async () => {
    const { ctx, service, store } = createHarness()
    ctx.provide('sessionPersistence', { list: async () => [] } as never)
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Restartable Team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'error' }))
    const team = service.getTeam(draft.id)
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    const ensureMemberOnline = vi.fn(async () => {})
    runtimeInternals(runtime).ensureMemberOnline = ensureMemberOnline
    runtimeInternals(runtime).messages = { recover: vi.fn(async () => {}) } as never

    const started = await service.startTeam(team.id, { expectedRevision: team.revision })

    expect(started.state).toBe('active')
    expect(Object.values(started.members).every(member => member.desiredState === 'online')).toBe(true)
    expect(ensureMemberOnline).toHaveBeenCalledOnce()
  })

  it('allows changing the leader of an error team', async () => {
    const { service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Error Succession Team',
      workspaceId: 'workspace-1',
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'error' }))
    const team = service.getTeam(draft.id)
    const successor = Object.values(team.members).find(value => value.id !== team.leaderSlotId)!

    const changed = await service.changeLeader(team.id, successor.id, { expectedRevision: team.revision })

    expect(changed.leaderSlotId).toBe(successor.id)
    expect(changed.state).toBe('error')
  })

  it('refreshes member snapshots from current templates when starting an error team', async () => {
    const { ctx, service, store } = createHarness()
    ctx.provide('sessionPersistence', { list: async () => [] } as never)
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Stale Snapshot Team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'error' }))
    const team = service.getTeam(draft.id)
    await service.updateAssistant(assistant.id, { name: 'Codex Lead v2', agentPresetId: 'standard' })
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    runtimeInternals(runtime).ensureMemberOnline = vi.fn(async () => {})
    runtimeInternals(runtime).messages = { recover: vi.fn(async () => {}) } as never

    const started = await service.startTeam(team.id, { expectedRevision: team.revision })
    const member = started.members[team.leaderSlotId]!

    expect(started.state).toBe('active')
    expect(member.assistantSnapshot.agentPresetId).toBe('standard')
    expect(member.assistantSnapshot.revision).toBe(2)
    expect(member.displayName).toBe('Codex Lead v2')
  })

  it('refreshes snapshots when starting a draft team after template edits', async () => {
    const { ctx, service } = createHarness()
    ctx.provide('sessionPersistence', { list: async () => [] } as never)
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Fresh Draft Team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    await service.updateAssistant(assistant.id, { agentPresetId: 'standard' })
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    runtimeInternals(runtime).ensureMemberOnline = vi.fn(async () => {})
    runtimeInternals(runtime).messages = { recover: vi.fn(async () => {}) } as never

    const started = await service.startTeam(draft.id, { expectedRevision: draft.revision })
    const member = started.members[started.leaderSlotId]!

    expect(started.state).toBe('active')
    expect(member.assistantSnapshot.agentPresetId).toBe('standard')
  })

  it('skips the snapshot write when templates are unchanged', async () => {
    const { ctx, service, store } = createHarness()
    ctx.provide('sessionPersistence', { list: async () => [] } as never)
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Unchanged Team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    runtimeInternals(runtime).ensureMemberOnline = vi.fn(async () => {})
    runtimeInternals(runtime).messages = { recover: vi.fn(async () => {}) } as never

    const started = await service.startTeam(draft.id, { expectedRevision: draft.revision })

    expect(started.revision).toBe(draft.revision + 2)
    expect(store.listActivities(draft.id).map(activity => activity.kind)).not.toContain('team.snapshots_refreshed')
  })

  it('fails start and names the member when its assistant is missing', async () => {
    const { ctx, service, store } = createHarness()
    ctx.provide('sessionPersistence', { list: async () => [] } as never)
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Missing Template Team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'error' }))
    const team = service.getTeam(draft.id)
    const member = team.members[team.leaderSlotId]!
    await store.deleteAssistant(assistant.id)
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    runtimeInternals(runtime).ensureMemberOnline = vi.fn(async () => {})
    runtimeInternals(runtime).messages = { recover: vi.fn(async () => {}) } as never

    await expect(service.startTeam(team.id, { expectedRevision: team.revision }))
      .rejects.toMatchObject({ code: 'ASSISTANT_NOT_FOUND' })

    const failed = service.getTeam(team.id)
    expect(failed.state).toBe('error')
    expect(failed.lastError?.code).toBe('ASSISTANT_NOT_FOUND')
    expect(failed.lastError?.message).toContain(member.displayName)
  })

  it('records lastError on start failure and clears it after a successful retry', async () => {
    const { ctx, service, store } = createHarness()
    ctx.provide('sessionPersistence', { list: async () => [] } as never)
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Retry Cycle Team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'error' }))
    const team = service.getTeam(draft.id)
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    const failure = new AgentTeamError(
      'PRESET_PROMPT_INCOMPATIBLE',
      `成员“${assistant.name}”启动失败：Preset 'minimal' replaced Agent Team prompt sections`,
    )
    runtimeInternals(runtime).ensureMemberOnline = vi.fn(async () => { throw failure })
    runtimeInternals(runtime).messages = { recover: vi.fn(async () => {}) } as never

    await expect(service.startTeam(team.id, { expectedRevision: team.revision }))
      .rejects.toMatchObject({ code: 'PRESET_PROMPT_INCOMPATIBLE' })

    const failed = service.getTeam(team.id)
    expect(failed.state).toBe('error')
    expect(failed.lastError).toMatchObject({ code: 'PRESET_PROMPT_INCOMPATIBLE', message: failure.message })
    expect(typeof failed.lastError?.failedAt).toBe('string')

    runtimeInternals(runtime).ensureMemberOnline = vi.fn(async () => {})
    const retried = await service.startTeam(team.id, { expectedRevision: failed.revision })

    expect(retried.state).toBe('active')
    expect(retried.lastError).toBeUndefined()
  })

  it('preserves member-level overrides across a snapshot refresh', async () => {
    const { ctx, service, store } = createHarness()
    ctx.provide('sessionPersistence', { list: async () => [] } as never)
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Override Team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'error' }))
    const team = service.getTeam(draft.id)
    const member = team.members[team.leaderSlotId]!
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    runtimeInternals(runtime).owned.set(member.sessionId, fakeOwned(fakeAgent()))
    await service.setMemberPermissionPreset(team.id, member.id, 'workspace-write')
    await service.setMemberReasoningEffort(team.id, member.id, 'high')
    await service.updateAssistant(assistant.id, { agentPresetId: 'standard' })
    runtimeInternals(runtime).ensureMemberOnline = vi.fn(async () => {})
    runtimeInternals(runtime).messages = { recover: vi.fn(async () => {}) } as never

    const started = await service.startTeam(team.id, { expectedRevision: service.getTeam(team.id).revision })
    const refreshed = started.members[member.id]!

    expect(refreshed.permissionPresetId).toBe('workspace-write')
    expect(refreshed.reasoningEffort).toBe('high')
    expect(refreshed.assistantSnapshot.agentPresetId).toBe('standard')
    expect(refreshed.assistantSnapshot.permissionPresetId).toBe('standard')
  })

  it('refreshes snapshots on reset restart and clears lastError', async () => {
    const { ctx, service, store } = createHarness()
    ctx.provide('sessionPersistence', { list: async () => [] } as never)
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Reset Refresh Team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    await store.updateTeam(draft.id, team => ({
      ...team,
      state: 'error',
      lastError: { code: 'PRESET_PROMPT_INCOMPATIBLE', message: 'stale failure', failedAt: '2026-09-13T00:00:00.000Z' },
    }))
    const team = service.getTeam(draft.id)
    const member = team.members[team.leaderSlotId]!
    await service.updateAssistant(assistant.id, { agentPresetId: 'standard' })
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    runtimeInternals(runtime).ensureMembersOnline = vi.fn(async () => {})
    runtimeInternals(runtime).owned.set(member.sessionId, fakeOwned(fakeAgent()))

    const reset = await service.resetTeam(team.id, team.name)

    expect(reset.state).toBe('active')
    expect(reset.members[member.id]?.assistantSnapshot.agentPresetId).toBe('standard')
    expect(reset.lastError).toBeUndefined()
  })

  it('keeps snapshots stale on recoverTeams but clears lastError when recovery succeeds', async () => {
    const { ctx, service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Recover Stale Team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    await store.updateTeam(draft.id, team => ({
      ...team,
      state: 'error',
      lastError: { message: 'stale failure', failedAt: '2026-09-13T00:00:00.000Z' },
    }))
    const team = service.getTeam(draft.id)
    const member = team.members[team.leaderSlotId]!
    await service.updateAssistant(assistant.id, { agentPresetId: 'standard' })
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    runtimeInternals(runtime).ensureMembersOnline = vi.fn(async () => {})
    runtimeInternals(runtime).messages = { recover: vi.fn(async () => {}) } as never

    await runtime.recoverTeams()

    const recovered = service.getTeam(team.id)
    expect(recovered.state).toBe('active')
    expect(recovered.members[member.id]?.assistantSnapshot.agentPresetId).toBe('default')
    expect(recovered.lastError).toBeUndefined()
  })

  it('atomically queues an assigned task and wakes its owner', async () => {
    const { ctx, service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Dispatch Team',
      workspaceId: 'workspace-1',
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const team = service.getTeam(draft.id)
    const member = Object.values(team.members).find(value => value.role === 'member')!
    const runtime = runtimeInternals(new TeamRuntime(ctx, config, service))
    const leaderAgent = fakeAgent()
    const memberAgent = fakeAgent()
    runtime.owned.set(team.members[team.leaderSlotId]!.sessionId, fakeOwned(leaderAgent))
    runtime.owned.set(member.sessionId, fakeOwned(memberAgent))

    const created = await runtime.commands.createTask(team.id, team.leaderSlotId, {
      title: 'Implement parser',
      description: 'Add the parser implementation.',
      ownerSlotId: member.id,
      fileScopes: ['src/parser.ts'],
    })

    expect(created).toMatchObject({ status: 'assigned', deliveryState: 'delivered' })
    expect(memberAgent.followup).toHaveBeenCalledOnce()
    expect(Object.keys(service.getTeam(team.id).outbox)).toHaveLength(0)
    const assignment = service.listMessages(team.id).items[0]!
    expect(assignment).toMatchObject({
      deliveryState: 'delivered',
      recipient: { kind: 'member', slotId: member.id },
      relatedTaskId: created.taskId,
    })

    const updated = await runtime.commands.updateTask(team.id, member.id, {
      taskId: created.taskId,
      status: 'completed',
      result: 'Parser implemented and tested.',
    })

    expect(updated.deliveryState).toBe('delivered')
    expect(leaderAgent.followup).toHaveBeenCalledOnce()
    expect(leaderAgent.followup.mock.calls[0]?.[0]).toMatchObject({
      content: [{ type: 'text', text: expect.stringContaining(`slotId=${member.id}`) }],
    })
    expect(service.listMessages(team.id).items[1]).toMatchObject({
      type: 'result',
      recipient: { kind: 'leader', slotId: team.leaderSlotId },
      relatedTaskId: created.taskId,
    })
  })

  it('keeps failed assignment delivery in the durable outbox and recovers it', async () => {
    const { ctx, service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Recovery Team',
      workspaceId: 'workspace-1',
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const team = service.getTeam(draft.id)
    const member = Object.values(team.members).find(value => value.role === 'member')!
    const runtime = runtimeInternals(new TeamRuntime(ctx, config, service))
    const memberAgent = fakeAgent()
    memberAgent.followup.mockImplementationOnce(() => { throw new Error('temporary inbox failure') })
    runtime.owned.set(member.sessionId, fakeOwned(memberAgent))

    const created = await runtime.commands.createTask(team.id, team.leaderSlotId, {
      title: 'Recoverable assignment',
      ownerSlotId: member.id,
    })

    expect(created.deliveryState).toBe('queued')
    expect(Object.keys(service.getTeam(team.id).outbox)).toHaveLength(1)
    expect(service.listMessages(team.id).items[0]?.deliveryState).toBe('failed')

    memberAgent.followup.mockImplementation(message => {
      memberAgent.splice(message)
    })
    await runtime.messages.recover(service.getTeam(team.id))

    expect(memberAgent.followup).toHaveBeenCalledTimes(2)
    expect(Object.keys(service.getTeam(team.id).outbox)).toHaveLength(0)
    expect(service.listMessages(team.id).items[0]?.deliveryState).toBe('delivered')
  })

  it('stops the active member, clears pending inbox work, and waits for idle', async () => {
    const { ctx, service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Stop Team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    await store.updateTeam(draft.id, team => ({
      ...team,
      state: 'active',
      members: Object.fromEntries(Object.entries(team.members).map(([id, member]) => [
        id,
        { ...member, lastRuntimeState: 'running' },
      ])),
    }))
    const team = service.getTeam(draft.id)
    const member = team.members[team.leaderSlotId]!
    const runtime = runtimeInternals(new TeamRuntime(ctx, config, service))
    const agent = fakeAgent()
    agent.status = 'running'
    agent.whenIdle.mockImplementation(async () => { agent.status = 'idle' })
    runtime.owned.set(member.sessionId, fakeOwned(agent))

    await runtime.stopMember(team.id, member.id)

    expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' })
    expect(agent.whenIdle).toHaveBeenCalledOnce()
    expect(service.getTeam(team.id).members[member.id]?.lastRuntimeState).toBe('idle')
  })

  it('reliably notifies the leader after removing a live member', async () => {
    const { ctx, service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Roster Team',
      workspaceId: 'workspace-1',
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const team = service.getTeam(draft.id)
    const leader = team.members[team.leaderSlotId]!
    const member = Object.values(team.members).find(value => value.role === 'member')!
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    const leaderAgent = fakeAgent()
    const memberAgent = fakeAgent()
    runtimeInternals(runtime).owned.set(leader.sessionId, fakeOwned(leaderAgent))
    runtimeInternals(runtime).owned.set(member.sessionId, fakeOwned(memberAgent))

    const removed = await service.removeMember(team.id, member.id, { expectedRevision: team.revision })

    expect(removed.members[member.id]).toBeUndefined()
    expect(removed.retiredSessions[member.sessionId]).toMatchObject({ displayName: member.displayName })
    expect(memberAgent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
    expect(leaderAgent.followup).toHaveBeenCalledOnce()
    expect(leaderAgent.followup.mock.calls[0]?.[0]).toMatchObject({
      role: 'user',
      source: { kind: 'plugin', plugin: 'dsh-agent-team', form: 'relay' },
      content: [{ type: 'text', text: expect.stringContaining(member.id) }],
    })
    expect(Object.keys(removed.outbox)).toHaveLength(0)
    expect(service.listMessages(team.id).items).toContainEqual(expect.objectContaining({
      sender: { kind: 'system', id: 'dsh-agent-team' },
      recipient: { kind: 'leader', slotId: leader.id },
      type: 'system',
      deliveryState: 'delivered',
    }))
  })

  it('changes a live member permission without modifying the assistant default', async () => {
    const { ctx, service, store, permissionSet } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Permission Team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, role: 'leader' }],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const team = service.getTeam(draft.id)
    const member = team.members[team.leaderSlotId]!
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    runtimeInternals(runtime).owned.set(member.sessionId, fakeOwned(fakeAgent()))

    const changed = await service.setMemberPermissionPreset(team.id, member.id, 'workspace-write')

    expect(permissionSet).toHaveBeenCalledWith(expect.anything(), 'workspace-write')
    expect(changed.members[member.id]?.permissionPresetId).toBe('workspace-write')
    expect(changed.members[member.id]?.assistantSnapshot.permissionPresetId).toBe('standard')
    expect(service.getAssistant(assistant.id).permissionPresetId).toBe('standard')
  })

  it('clears every task and rotates every member onto a fresh Session', async () => {
    const { ctx, service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Fresh Context Team',
      workspaceId: 'workspace-1',
      members: [
        { assistantId: assistant.id, role: 'leader' },
        { assistantId: assistant.id, role: 'member' },
      ],
    })
    const taskId = 'task-1'
    await store.updateTeam(draft.id, team => ({
      ...team,
      state: 'active',
      tasks: {
        [taskId]: {
          id: taskId,
          title: 'Old work',
          description: 'Must not survive the reset.',
          status: 'running',
          ownerSlotId: Object.values(team.members).find(member => member.role === 'member')?.id,
          dependencyIds: [],
          fileScopes: ['src/old.ts'],
          revision: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
    }))
    const before = service.getTeam(draft.id)
    const oldSessionIds = Object.values(before.members).map(member => member.sessionId)
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    const ensureMembersOnline = vi.fn(async () => {})
    runtimeInternals(runtime).ensureMembersOnline = ensureMembersOnline
    for (const member of Object.values(before.members)) {
      runtimeInternals(runtime).owned.set(member.sessionId, fakeOwned(fakeAgent()))
    }

    await expect(service.resetTeam(before.id, 'wrong')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    const reset = await service.resetTeam(before.id, before.name)

    expect(reset.state).toBe('active')
    expect(Object.keys(reset.tasks)).toHaveLength(0)
    expect(Object.keys(reset.leases)).toHaveLength(0)
    expect(Object.keys(reset.outbox)).toHaveLength(0)
    const newSessionIds = Object.values(reset.members).map(member => member.sessionId)
    expect(newSessionIds).toHaveLength(oldSessionIds.length)
    expect(newSessionIds.every(id => !oldSessionIds.includes(id))).toBe(true)
    expect(oldSessionIds.every(id => reset.retiredSessions[id] !== undefined)).toBe(true)
    expect(runtimeInternals(runtime).owned.size).toBe(0)
    expect(ensureMembersOnline).toHaveBeenCalledOnce()
  })
})

function createHarness(workspacePath = '/tmp/agent-team-workspace'): {
  ctx: Context
  service: AgentTeamService
  store: MemoryStore
  permissionSet: ReturnType<typeof vi.fn>
} {
  const ctx = new Context()
  ctx.provide('llm', {
    listProviders: () => [{ id: 'openai', name: 'OpenAI' }],
    listModels: async () => [{ id: 'codex', name: 'Codex' }],
    resolveModelInfo: async (provider: string, model: string) => ({
      provider,
      model,
      reasoning: {
        efforts: [
          { id: 'low', name: 'Low', description: 'Faster reasoning.' },
          { id: 'high', name: 'High' },
        ],
        defaultEffort: 'low',
      },
    }),
  } as never)
  ctx.provide('agentPresets', {
    list: async () => [{ id: 'default', name: 'Default' }],
    resolve: async (id: string) => ({ id, name: id }),
    standingKeyFor: async () => ({ kind: 'preset-scope' }),
  } as never)
  ctx.provide('tools', {
    get: (name: string) => name === 'skill' ? { name: 'skill' } : undefined,
    schemas: () => [
      { name: 'skill', description: 'Load one Skill.' },
      { name: 'mcp__github__list_issues', description: 'List issues.' },
      { name: 'mcp__figma__inspect', description: 'Inspect a Figma node.' },
      { name: 'mcp__github__create_issue', description: 'Create an issue.' },
    ],
  } as never)
  ctx.provide('skills', {
    list: async () => [
      {
        name: 'code-review',
        description: 'Review code changes.',
        invocation: { modelInvocable: true, userInvocable: true },
        source: 'user-agents',
        provider: 'filesystem',
      },
      {
        name: 'manual-only',
        description: 'Only users may invoke this.',
        invocation: { modelInvocable: false, userInvocable: true },
        source: 'user-agents',
        provider: 'filesystem',
      },
    ],
  } as never)
  const permissionSet = vi.fn()
  ctx.provide('permissionPresets', {
    names: ['standard', 'workspace-write'],
    optionOf: (name: string) => ({ value: name, name }),
    set: permissionSet,
  } as never)
  ctx.provide('agents', {
    get: () => undefined,
  } as never)
  ctx.provide('sessions', {
    flush: async () => {},
  } as never)
  const workspace = {
    id: 'workspace-1',
    path: workspacePath,
    title: 'Workspace',
    status: async () => 'ok' as const,
    attachSession: async () => {},
    detachSession: async () => {},
  }
  ctx.provide('workspaceRegistry', {
    get: (id: string) => id === workspace.id ? workspace : undefined,
    list: () => [workspace],
  } as never)
  const store = new MemoryStore()
  return { ctx, service: new AgentTeamService(ctx, config, store), store, permissionSet }
}

interface FakeAgent {
  followup: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  whenIdle: ReturnType<typeof vi.fn>
  status: 'idle' | 'running'
  splice: (message: unknown) => void
  session: { snapshotEvents(): Array<{ type: string; data: { inserted: unknown[] } }> }
}

interface RuntimeInternals {
  owned: Map<string, unknown>
  commands: TeamCommandHandler
  messages: TeamMessageDispatcher
  ensureMembersOnline: (team: TeamAggregate) => Promise<void>
  ensureMemberOnline: (team: TeamAggregate, member: TeamAggregate['members'][string], persisted: boolean) => Promise<void>
  stopMember(teamId: string, slotId: string): Promise<void>
}

function runtimeInternals(runtime: TeamRuntime): RuntimeInternals {
  return runtime as unknown as RuntimeInternals
}

function fakeAgent(): FakeAgent {
  const log: Array<{ type: string; data: { inserted: unknown[] } }> = []
  const session: FakeAgent['session'] = { snapshotEvents: () => [...log] }
  return {
    session,
    status: 'idle',
    followup: vi.fn(message => {
      log.push({ type: 'agent/inbox/spliced', data: { inserted: [message] } })
    }),
    splice: message => {
      log.push({ type: 'agent/inbox/spliced', data: { inserted: [message] } })
    },
    cancel: vi.fn(),
    whenIdle: vi.fn(async () => {}),
  }
}

function fakeOwned(agent: FakeAgent): unknown {
  return {
    teamId: 'test-team',
    slotId: 'test-slot',
    handle: { agent, dispose: vi.fn(async () => {}) },
    modelSelection: { current: undefined, assembled: undefined },
  }
}

function assistantInput() {
  return {
    name: 'Codex Lead',
    instructions: 'Coordinate the team.',
    provider: 'openai',
    model: 'codex',
    agentPresetId: 'default',
    permissionPresetId: 'standard',
    skillAllowlist: [],
    mcpServers: [],
  }
}

class MemoryStore implements AgentTeamStore {
  private assistants = new Map<string, AssistantTemplate>()
  private teams = new Map<string, TeamAggregate>()
  private messages = new Map<string, TeamMessage>()
  private activities = new Map<string, TeamActivity>()
  private operations = new Map<string, Operation>()

  getAssistant(id: string) { return this.assistants.get(id) }
  listAssistants() { return [...this.assistants.values()] }
  async putAssistant(value: AssistantTemplate) { this.assistants.set(value.id, value) }
  updateAssistant(id: string, update: (current: AssistantTemplate) => AssistantTemplate) {
    return updateMap(this.assistants, id, update)
  }
  async deleteAssistant(id: string) { return this.assistants.delete(id) }

  getTeam(id: string) { return this.teams.get(id) }
  listTeams() { return [...this.teams.values()] }
  async putTeam(value: TeamAggregate) { this.teams.set(value.id, value) }
  updateTeam(id: string, update: (current: TeamAggregate) => TeamAggregate) {
    return updateMap(this.teams, id, update)
  }
  async deleteTeam(id: string) { return this.teams.delete(id) }

  listMessages(teamId: string) { return [...this.messages.values()].filter(value => value.teamId === teamId) }
  async putMessage(value: TeamMessage) { this.messages.set(value.id, value) }
  async deleteMessage(id: string) { return this.messages.delete(id) }

  listActivities(teamId: string) { return [...this.activities.values()].filter(value => value.teamId === teamId) }
  async putActivity(value: TeamActivity) { this.activities.set(value.id, value) }
  async deleteActivity(id: string) { return this.activities.delete(id) }

  getOperation(id: string) { return this.operations.get(id) }
  listOperations() { return [...this.operations.values()] }
  async putOperation(value: Operation) { this.operations.set(value.id, value) }
  updateOperation(id: string, update: (current: Operation) => Operation) {
    return updateMap(this.operations, id, update)
  }
  async deleteOperation(id: string) { return this.operations.delete(id) }
}

async function updateMap<T>(map: Map<string, T>, id: string, update: (current: T) => T): Promise<T> {
  const current = map.get(id)
  if (current === undefined) throw new AgentTeamError('INVALID_REQUEST', `Unknown record '${id}'`)
  const next = update(current)
  map.set(id, next)
  return next
}
