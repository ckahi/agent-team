import { describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Config } from '../src/config.js'
import type { AssistantBuilderModelReference } from '../src/storage/assistant-builder-preferences.js'
import {
  AssistantBuilderRuntime,
  hasFreshAssistantDraftUserResponse,
} from '../src/runtime/assistant-builder-runtime.js'

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

describe('AssistantBuilderRuntime', () => {
  it('lists persisted conversations with a title and progress state', async () => {
    const createdAt = 1_700_000_000_000
    const events = [userEvent(0, '我需要一个负责 React 前端开发和代码审查的助手')]
    const ctx = {
      on: vi.fn(() => vi.fn()),
      sessionPersistence: {
        list: vi.fn(async () => [
          { header: { id: 'agent-team:assistant-builder:history-1', createdAt }, revision: 'r1' },
          { header: { id: 'agent-team:assistant-builder:legacy-empty', createdAt: createdAt + 1 }, revision: 'r2' },
        ]),
        open: vi.fn(async (sessionId: string) => ({
          header: { createdAt },
          read: vi.fn(async () => ({
            events: sessionId.endsWith('legacy-empty') ? [] : events,
          })),
          close: vi.fn(async () => {}),
        })),
      },
      workspaceRegistry: { archivedSessionIds: [] },
    }
    const runtime = new AssistantBuilderRuntime(
      ctx as never,
      config,
      {} as never,
      fakeModelPreferences(),
      fakeInteractionBridge() as never,
    )

    await expect(runtime.listConversations()).resolves.toEqual({
      items: [{
        sessionId: 'agent-team:assistant-builder:history-1',
        title: '我需要一个负责 React 前端开发和代码审查的助手',
        createdAt: new Date(createdAt).toISOString(),
        updatedAt: new Date(events[0]!.time).toISOString(),
        state: 'in_progress',
      }],
      total: 1,
    })

    await runtime.dispose()
  })

  it('switches model by flushing and resuming the same Session', async () => {
    const first = fakeHandle()
    const second = fakeHandle()
    const handles = [first, second]
    const cwdVariable = vi.fn()
    const restrict = vi.fn()
    const resume = vi.fn(async (options: { setup?: (ctx: unknown, agent: unknown) => Promise<void> }) => {
      const handle = handles.shift()
      if (handle === undefined) throw new Error('Missing fake Agent handle')
      await options.setup?.(fakeAgentContext(handle.agent, cwdVariable, restrict), handle.agent)
      return handle
    })
    const create = vi.fn(async (options: { setup?: (ctx: unknown, agent: unknown) => Promise<void> }) => {
      const handle = handles.shift()
      if (handle === undefined) throw new Error('Missing fake Agent handle')
      await options.setup?.(fakeAgentContext(handle.agent, cwdVariable, restrict), handle.agent)
      return handle
    })
    const flush = vi.fn(async () => {})
    const archivedSessionIds: string[] = []
    const archiveSession = vi.fn(async (sessionId: string) => { archivedSessionIds.push(sessionId) })
    const ctx = {
      on: vi.fn(() => vi.fn()),
      agents: {
        get: vi.fn(() => undefined),
        resume,
        create,
      },
      llm: {
        listProviders: vi.fn(() => [
          { id: 'deepseek-official', name: 'DeepSeek' },
          { id: 'zai-coding-cn', name: 'ZAI' },
        ]),
        listModels: vi.fn(async (provider: string) => provider === 'deepseek-official'
          ? [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }]
          : [{ id: 'glm-5.3', name: 'GLM 5.3' }]),
        resolveModelInfo: vi.fn(async () => ({})),
      },
      agentPresets: {
        defaultId: 'standard',
        resolve: vi.fn(async () => ({})),
        mount: vi.fn(async () => ({})),
      },
      permissionPresets: {
        names: ['read-only'],
        defaultPreset: 'read-only',
        set: vi.fn(),
      },
      sessionPersistence: {
        list: vi.fn(async () => [{ header: { id: 'agent-team:assistant-builder' }, revision: 'r1' }]),
        open: vi.fn(async () => ({
          header: {},
          read: vi.fn(async () => ({ events: [] })),
          close: vi.fn(async () => {}),
        })),
      },
      sessions: { flush },
      logger: { warn: vi.fn() },
      workspaceRegistry: { archivedSessionIds, archiveSession },
    }
    const service = {
      publishAssistantBuilderConversation: vi.fn(),
    }
    let lastSelectedModel: AssistantBuilderModelReference | undefined
    const conversationModels = new Map<string, AssistantBuilderModelReference>()
    const modelPreferences = {
      getConversationModel: vi.fn((sessionId: string) => conversationModels.get(sessionId)),
      getLastSelectedModel: vi.fn(() => lastSelectedModel),
      setConversationModel: vi.fn(async (sessionId: string, provider: string, model: string) => {
        conversationModels.set(sessionId, { provider, model })
      }),
      setSelectedModel: vi.fn(async (sessionId: string, provider: string, model: string) => {
        const selected = { provider, model }
        conversationModels.set(sessionId, selected)
        lastSelectedModel = selected
      }),
      setLastSelectedModel: vi.fn(async (provider: string, model: string) => {
        lastSelectedModel = { provider, model }
      }),
    }
    const interactions = fakeInteractionBridge()
    const runtime = new AssistantBuilderRuntime(
      ctx as never,
      config,
      service as never,
      modelPreferences,
      interactions as never,
    )

    await expect(runtime.getDraft()).resolves.toMatchObject({
      configuration: {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
      },
    })
    expect(ctx.agents.create).not.toHaveBeenCalled()

    const initial = await runtime.getConversation('agent-team:assistant-builder')
    await runtime.respondToInteraction('agent-team:assistant-builder', 'question:rpc-1', {
      kind: 'question',
      answers: [{ id: 'name', selected: ['Reviewer'] }],
    })
    const switched = await runtime.configure('agent-team:assistant-builder', 'zai-coding-cn', 'glm-5.3')

    expect(initial.configuration).toMatchObject({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })
    expect(first.dispose).toHaveBeenCalledOnce()
    expect(flush).toHaveBeenCalledWith(first.agent.session)
    expect(resume).toHaveBeenLastCalledWith(expect.objectContaining({
      resumeSessionId: 'agent-team:assistant-builder',
      agentOptions: { provider: 'zai-coding-cn', model: 'glm-5.3' },
    }))
    expect(switched.configuration).toMatchObject({
      provider: 'zai-coding-cn',
      model: 'glm-5.3',
    })
    expect(modelPreferences.setSelectedModel).toHaveBeenCalledWith(
      'agent-team:assistant-builder',
      'zai-coding-cn',
      'glm-5.3',
    )
    expect(cwdVariable).toHaveBeenCalledWith('cwd', expect.any(Function))
    expect(restrict).toHaveBeenCalledWith({ deny: ['write', 'edit', 'bash'] })
    expect(interactions.respond).toHaveBeenCalledWith(
      'agent-team:assistant-builder',
      'question:rpc-1',
      { kind: 'question', answers: [{ id: 'name', selected: ['Reviewer'] }] },
    )

    await runtime.dispose()

    const restored = fakeHandle()
    handles.push(restored)
    const restartedRuntime = new AssistantBuilderRuntime(
      ctx as never,
      config,
      service as never,
      modelPreferences,
      fakeInteractionBridge() as never,
    )
    const restarted = await restartedRuntime.getConversation('agent-team:assistant-builder')

    expect(restarted.configuration).toMatchObject({
      provider: 'zai-coding-cn',
      model: 'glm-5.3',
    })
    expect(resume).toHaveBeenLastCalledWith(expect.objectContaining({
      agentOptions: { provider: 'zai-coding-cn', model: 'glm-5.3' },
    }))

    await restartedRuntime.archiveConversation('agent-team:assistant-builder')

    expect(archiveSession).toHaveBeenCalledWith('agent-team:assistant-builder')
    await expect(restartedRuntime.listConversations()).resolves.toEqual({ items: [], total: 0 })
    await expect(restartedRuntime.getConversation('agent-team:assistant-builder'))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })

    const fresh = fakeHandle()
    handles.push(fresh)
    await restartedRuntime.startConversation(
      'zai-coding-cn',
      'glm-5.3',
      '创建一个代码审查助手',
    )

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      agentOptions: { provider: 'zai-coding-cn', model: 'glm-5.3' },
    }))
    expect(fresh.agent.followup).toHaveBeenCalledOnce()

    await restartedRuntime.dispose()
  })

  it('requires a fresh, real user response after preparation', () => {
    const beforePreparation = userEvent(4, '确认创建')
    const pluginRelay = userEvent(6, '确认创建', {
      kind: 'plugin',
      plugin: 'dsh-agent-team',
      form: 'relay',
    })
    const naturalConfirmation = userEvent(7, '没问题，就这样创建吧')

    expect(hasFreshAssistantDraftUserResponse([beforePreparation], 5)).toBe(false)
    expect(hasFreshAssistantDraftUserResponse([pluginRelay], 5)).toBe(false)
    expect(hasFreshAssistantDraftUserResponse([naturalConfirmation], 5)).toBe(true)
  })
})

function userEvent(seq: number, text: string, source: unknown = { kind: 'user' }): SessionEvent {
  return {
    seq,
    time: 1_700_000_000_000 + seq,
    type: 'user/message',
    data: {
      id: `message-${seq}`,
      content: [{ type: 'text', text }],
      source,
    },
  } as SessionEvent
}

function fakeModelPreferences() {
  return {
    getConversationModel: vi.fn(() => undefined),
    getLastSelectedModel: vi.fn(() => undefined),
    setConversationModel: vi.fn(async () => {}),
    setSelectedModel: vi.fn(async () => {}),
    setLastSelectedModel: vi.fn(async () => {}),
  }
}

function fakeInteractionBridge() {
  return {
    registerScope: vi.fn(() => vi.fn()),
    list: vi.fn(() => []),
    respond: vi.fn(async () => undefined),
    attachAgentContext: vi.fn(),
  }
}

interface RegisteredTool {
  name: string
  execute: (args: Record<string, unknown>, exec: { agent?: { id?: string; session?: { snapshotEvents(): SessionEvent[] } } }) => Promise<unknown>
}

function toolOf(registered: readonly RegisteredTool[], name: string): RegisteredTool {
  const tool = registered.find(item => item.name === name)
  if (tool === undefined) throw new Error(`Tool '${name}' was not registered`)
  return tool
}

function createToolHarness(service: Record<string, unknown>): {
  runtime: AssistantBuilderRuntime
  registered: RegisteredTool[]
  sessionEvents: SessionEvent[]
  dispose: () => Promise<void>
} {
  const registered: RegisteredTool[] = []
  const sessionEvents: SessionEvent[] = []
  const handle = fakeHandle()
  handle.agent.session.snapshotEvents = () => sessionEvents
  const cwdVariable = vi.fn()
  const restrict = vi.fn()
  const fakeCtx = fakeAgentContext(handle.agent, cwdVariable, restrict, registered)
  const ctx = {
    on: vi.fn(() => vi.fn()),
    agents: {
      get: vi.fn(() => undefined),
      resume: vi.fn(async (options: { setup?: (ctx: unknown, agent: unknown) => Promise<void> }) => {
        await options.setup?.(fakeCtx, handle.agent)
        return handle
      }),
      create: vi.fn(async (options: { setup?: (ctx: unknown, agent: unknown) => Promise<void> }) => {
        await options.setup?.(fakeCtx, handle.agent)
        return handle
      }),
    },
    llm: {
      listProviders: vi.fn(() => [{ id: 'deepseek-official', name: 'DeepSeek' }]),
      listModels: vi.fn(async () => [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }]),
      resolveModelInfo: vi.fn(async () => ({})),
    },
    agentPresets: {
      defaultId: 'standard',
      resolve: vi.fn(async () => ({})),
      mount: vi.fn(async () => ({})),
    },
    permissionPresets: {
      names: ['read-only'],
      defaultPreset: 'read-only',
      set: vi.fn(),
    },
    sessionPersistence: {
      list: vi.fn(async () => [{ header: { id: 'agent-team:assistant-builder' }, revision: 'r1' }]),
      open: vi.fn(async () => ({
        header: {},
        read: vi.fn(async () => ({ events: [] })),
        close: vi.fn(async () => {}),
      })),
    },
    sessions: { flush: vi.fn(async () => {}) },
    logger: { warn: vi.fn() },
    workspaceRegistry: { archivedSessionIds: [], archiveSession: vi.fn(async () => {}) },
  }
  const runtime = new AssistantBuilderRuntime(
    ctx as never,
    config,
    service as never,
    fakeModelPreferences(),
    fakeInteractionBridge() as never,
  )
  return { runtime, registered, sessionEvents, dispose: () => runtime.dispose() }
}

function createAssistantServiceStub(): Record<string, unknown> & {
  validateAssistantUpdate: ReturnType<typeof vi.fn>
  updateAssistant: ReturnType<typeof vi.fn>
} {
  const template = {
    schemaVersion: 1 as const,
    id: 'assistant-1',
    name: 'Reviewer',
    instructions: 'Review code.',
    provider: 'openai',
    model: 'codex',
    agentPresetId: 'default',
    permissionPresetId: 'standard',
    skillAllowlist: ['code-review'],
    mcpServers: [],
    revision: 3,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
  }
  return {
    listAssistants: vi.fn(() => ({ items: [template], total: 1 })),
    getAssistant: vi.fn((id: string) => {
      if (id !== template.id) throw new Error('Unknown assistant')
      return template
    }),
    validateAssistantUpdate: vi.fn(async () => ({
      id: template.id,
      expectedRevision: 3,
      value: { ...template, instructions: 'Updated instructions.' },
    })),
    updateAssistant: vi.fn(async () => ({ ...template, revision: 4 })),
    publishAssistantBuilderConversation: vi.fn(),
  }
}

describe('AssistantBuilderRuntime assistant template tools', () => {
  it('registers the read/update tools without denying them in restrict', async () => {
    const service = createAssistantServiceStub()
    const { runtime, registered, dispose } = createToolHarness(service)
    await runtime.getConversation('agent-team:assistant-builder')
    const names = registered.map(tool => tool.name)
    expect(names).toEqual(expect.arrayContaining([
      'assistant_builder_list_assistants',
      'assistant_builder_get_assistant',
      'assistant_builder_update_assistant',
    ]))
    await dispose()
  })

  it('lists existing assistant summaries', async () => {
    const service = createAssistantServiceStub()
    const { runtime, registered, dispose } = createToolHarness(service)
    await runtime.getConversation('agent-team:assistant-builder')
    const result = await toolOf(registered, 'assistant_builder_list_assistants')
      .execute({}, { agent: { id: 'agent-team:assistant-builder' } })
    expect(service.listAssistants).toHaveBeenCalled()
    expect(result).toEqual({
      items: [{
        id: 'assistant-1',
        name: 'Reviewer',
        description: undefined,
        provider: 'openai',
        model: 'codex',
        revision: 3,
        updatedAt: '2026-09-02T00:00:00.000Z',
      }],
      total: 1,
    })
    await dispose()
  })

  it('reads a single assistant template by id and propagates unknown-id errors', async () => {
    const service = createAssistantServiceStub()
    const { runtime, registered, dispose } = createToolHarness(service)
    await runtime.getConversation('agent-team:assistant-builder')
    const tool = toolOf(registered, 'assistant_builder_get_assistant')
    const read = await tool.execute({ id: 'assistant-1' }, { agent: { id: 'agent-team:assistant-builder' } })
    expect(service.getAssistant).toHaveBeenCalledWith('assistant-1')
    expect(read).toMatchObject({ id: 'assistant-1', name: 'Reviewer', skillAllowlist: ['code-review'] })
    await expect(tool.execute({ id: 'missing' }, { agent: { id: 'agent-team:assistant-builder' } }))
      .rejects.toThrow()
    await dispose()
  })

  it('rejects template tools called outside the owned agent', async () => {
    const service = createAssistantServiceStub()
    const { runtime, registered, dispose } = createToolHarness(service)
    await runtime.getConversation('agent-team:assistant-builder')
    await expect(toolOf(registered, 'assistant_builder_list_assistants')
      .execute({}, { agent: { id: 'someone-else' } })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await dispose()
  })

  it('prepares an update without writing and reports the expected revision', async () => {
    const service = createAssistantServiceStub()
    const { runtime, registered, sessionEvents, dispose } = createToolHarness(service)
    await runtime.getConversation('agent-team:assistant-builder')
    const tool = toolOf(registered, 'assistant_builder_update_assistant')
    const prepared = await tool.execute(
      { action: 'prepare', id: 'assistant-1', expectedRevision: 3, instructions: 'Updated instructions.' },
      { agent: { id: 'agent-team:assistant-builder', session: { snapshotEvents: () => sessionEvents } } },
    )
    expect(service.validateAssistantUpdate).toHaveBeenCalledWith('assistant-1', { instructions: 'Updated instructions.' })
    expect(prepared).toMatchObject({ id: 'assistant-1', expectedRevision: 3, requiresExplicitUserConfirmation: true })
    expect(service.updateAssistant).not.toHaveBeenCalled()
    await dispose()
  })

  it('rejects a commit when nothing was prepared', async () => {
    const service = createAssistantServiceStub()
    const { runtime, registered, sessionEvents, dispose } = createToolHarness(service)
    await runtime.getConversation('agent-team:assistant-builder')
    await expect(toolOf(registered, 'assistant_builder_update_assistant')
      .execute({ action: 'commit' }, { agent: { id: 'agent-team:assistant-builder', session: { snapshotEvents: () => sessionEvents } } }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(service.updateAssistant).not.toHaveBeenCalled()
    await dispose()
  })

  it('rejects a commit without a fresh real user response after preparation', async () => {
    const service = createAssistantServiceStub()
    const { runtime, registered, sessionEvents, dispose } = createToolHarness(service)
    await runtime.getConversation('agent-team:assistant-builder')
    const tool = toolOf(registered, 'assistant_builder_update_assistant')
    await tool.execute(
      { action: 'prepare', id: 'assistant-1', instructions: 'Updated instructions.' },
      { agent: { id: 'agent-team:assistant-builder', session: { snapshotEvents: () => sessionEvents } } },
    )
    await expect(tool.execute({ action: 'commit' }, { agent: { id: 'agent-team:assistant-builder', session: { snapshotEvents: () => sessionEvents } } }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(service.updateAssistant).not.toHaveBeenCalled()
    await dispose()
  })

  it('commits a prepared update through the optimistic lock and clears the pending draft', async () => {
    const service = createAssistantServiceStub()
    const { runtime, registered, sessionEvents, dispose } = createToolHarness(service)
    await runtime.getConversation('agent-team:assistant-builder')
    const tool = toolOf(registered, 'assistant_builder_update_assistant')
    const prepared = await tool.execute(
      { action: 'prepare', id: 'assistant-1', instructions: 'Updated instructions.' },
      { agent: { id: 'agent-team:assistant-builder', session: { snapshotEvents: () => sessionEvents } } },
    )
    sessionEvents.push(userEvent(9, '确认修改'))
    const committed = await tool.execute({ action: 'commit' }, { agent: { id: 'agent-team:assistant-builder', session: { snapshotEvents: () => sessionEvents } } })
    expect(service.updateAssistant).toHaveBeenCalledWith(
      'assistant-1',
      expect.objectContaining({ instructions: 'Updated instructions.' }),
      { expectedRevision: (prepared as { expectedRevision: number }).expectedRevision },
    )
    expect(committed).toMatchObject({ id: 'assistant-1', revision: 4 })
    sessionEvents.length = 0
    await expect(tool.execute({ action: 'commit' }, { agent: { id: 'agent-team:assistant-builder', session: { snapshotEvents: () => sessionEvents } } }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await dispose()
  })

  it('clears pending updates when the conversation is archived', async () => {
    const service = createAssistantServiceStub()
    const { runtime, registered, sessionEvents, dispose } = createToolHarness(service)
    await runtime.getConversation('agent-team:assistant-builder')
    const tool = toolOf(registered, 'assistant_builder_update_assistant')
    await tool.execute(
      { action: 'prepare', id: 'assistant-1', instructions: 'Updated instructions.' },
      { agent: { id: 'agent-team:assistant-builder', session: { snapshotEvents: () => sessionEvents } } },
    )

    await runtime.archiveConversation('agent-team:assistant-builder')

    // Even with a fresh real user message after archive, commit must fail:
    // the pending update was dropped together with the archived session.
    sessionEvents.push(userEvent(9, '确认修改'))
    await expect(tool.execute({ action: 'commit' }, { agent: { id: 'agent-team:assistant-builder', session: { snapshotEvents: () => sessionEvents } } }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(service.updateAssistant).not.toHaveBeenCalled()
    await dispose()
  })
})

function fakeHandle() {
  const agent = {
    id: 'agent-team:assistant-builder',
    status: 'idle' as const,
    session: { snapshotEvents: (): SessionEvent[] => [], header: {} },
    followup: vi.fn(),
    cancel: vi.fn(),
    whenIdle: vi.fn(async () => {}),
  }
  return {
    agent,
    dispose: vi.fn(async () => {}),
  }
}

function fakeAgentContext(
  agent: unknown,
  variable: ReturnType<typeof vi.fn>,
  restrict: ReturnType<typeof vi.fn>,
  registered: RegisteredTool[] = [],
): unknown {
  return {
    agent,
    workspaceRegistry: { archiveSession: vi.fn(async () => {}) },
    sessions: { flush: vi.fn(async () => {}) },
    tools: {
      presentAs: vi.fn(),
      guard: vi.fn(),
      register: vi.fn((tool: RegisteredTool) => { registered.push(tool) }),
      schemas: vi.fn(() => [
        { name: 'assistant_builder_get_catalog' },
        { name: 'assistant_builder_prepare' },
        { name: 'assistant_builder_commit' },
        { name: 'assistant_builder_list_assistants' },
        { name: 'assistant_builder_get_assistant' },
        { name: 'assistant_builder_update_assistant' },
        { name: 'ask_user_question' },
        { name: 'read' },
        { name: 'read_image' },
        { name: 'glob' },
        { name: 'grep' },
        { name: 'write' },
        { name: 'edit' },
        { name: 'bash' },
      ]),
      restrict,
    },
    systemPrompt: {
      variable,
      section: vi.fn(),
      assemble: vi.fn(async () => ({
        sections: [{ name: 'agent-team:assistant-builder', text: 'Assistant Builder' }],
      })),
    },
  }
}
