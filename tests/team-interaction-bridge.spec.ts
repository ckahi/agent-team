import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AgentTeamError } from '../src/domain/errors.js'
import {
  normalizeQuestionAnswers,
  resolveSessionLineageOwner,
  TeamInteractionBridge,
} from '../src/runtime/team-interaction-bridge.js'

type InteractionListener = (payload: unknown, next: () => Promise<unknown>) => unknown

describe('TeamInteractionBridge', () => {
  it('claims a team question via the waterfall and resolves it from the UI answer', async () => {
    const { ctx, dispatch } = contextWithListeners()
    const onChange = vi.fn()
    const bridge = new TeamInteractionBridge(ctx, {
      acceptsSession: id => id === 'session-1',
      onChange,
    })
    bridge.start()

    const next = vi.fn()
    const dispatched = dispatch('user-questions/request', {
      questions: [{
        id: 'language',
        question: '选择语言？',
        options: [{ label: 'TypeScript', description: '推荐' }, { label: 'Rust' }],
      }],
      agent: agentOf('session-1'),
    }, next) as Promise<unknown>

    await vi.waitFor(() => {
      expect(bridge.list('session-1')).toEqual([expect.objectContaining({ kind: 'question' })])
    })
    const pendingId = bridge.list('session-1')[0]!.id
    expect(onChange).toHaveBeenCalledWith('session-1')

    await bridge.respond('session-1', pendingId, {
      kind: 'question',
      answers: [{ id: 'language', selected: ['TypeScript'] }],
    })
    await expect(dispatched).resolves.toEqual({
      answers: [{ id: 'language', selected: ['TypeScript'] }],
    })
    expect(bridge.list('session-1')).toEqual([])
    expect(next).not.toHaveBeenCalled()
    await bridge.dispose()
  })

  it('claims an approval, resolves the official outcome, and rejects stale responses', async () => {
    const { ctx, dispatch } = contextWithListeners()
    const bridge = new TeamInteractionBridge(ctx, { acceptsSession: () => true, onChange: vi.fn() })
    bridge.start()

    const dispatched = dispatch('approval/request', {
      agent: agentOf('session-2'),
      toolName: 'bash',
      reason: '需要访问工作区之外的路径',
    }, vi.fn()) as Promise<unknown>

    await vi.waitFor(() => { expect(bridge.list('session-2')).toHaveLength(1) })
    const pendingId = bridge.list('session-2')[0]!.id

    await bridge.respond('session-2', pendingId, { kind: 'approval', outcome: 'allowed-once' })
    await expect(dispatched).resolves.toBe('allowed-once')
    await expect(bridge.respond('session-2', pendingId, {
      kind: 'approval',
      outcome: 'allowed-once',
    })).rejects.toMatchObject({ code: 'INTERACTION_NOT_FOUND' })
    expect(bridge.list('session-2')).toEqual([])
    await bridge.dispose()
  })

  it('delegates requests of foreign sessions to the built-in answerer chain', async () => {
    const { ctx, dispatch } = contextWithListeners()
    const bridge = new TeamInteractionBridge(ctx, {
      acceptsSession: id => id === 'session-1',
      onChange: vi.fn(),
    })
    bridge.start()

    const next = vi.fn(async () => 'unavailable' as const)
    const dispatched = dispatch('approval/request', {
      agent: agentOf('session-9'),
      toolName: 'bash',
    }, next) as Promise<unknown>

    await expect(dispatched).resolves.toBe('unavailable')
    expect(next).toHaveBeenCalled()
    expect(bridge.list('session-9')).toEqual([])
    await bridge.dispose()
  })

  it('顺序-prepend 包级监听器越过先注册的宿主转发桥并短路（G1 核心）', async () => {
    const { ctx, dispatch } = contextWithListeners()
    // 模拟宿主 api-remotes 转发桥：宿主启动时最先注册（push）、命中即转发主界面且不调 next()。
    const hostForwardingBridge = vi.fn(async (): Promise<never> => {
      throw new Error('host forwarding bridge must never be reached')
    })
    ctx.on('user-questions/request', hostForwardingBridge)
    ctx.on('approval/request', hostForwardingBridge)

    const bridge = new TeamInteractionBridge(ctx, {
      acceptsSession: id => id === 'session-1',
      onChange: vi.fn(),
    })
    bridge.start()

    const dispatched = dispatch('user-questions/request', {
      questions: [{
        id: 'language',
        question: '选择语言？',
        options: [{ label: 'TypeScript' }],
      }],
      agent: agentOf('session-1'),
    }, vi.fn()) as Promise<unknown>

    await vi.waitFor(() => {
      expect(bridge.list('session-1')).toEqual([expect.objectContaining({ kind: 'question' })])
    })
    const pendingId = bridge.list('session-1')[0]!.id
    await bridge.respond('session-1', pendingId, {
      kind: 'question',
      answers: [{ id: 'language', selected: ['TypeScript'] }],
    })
    // 插件先于转发桥获得应答权：短路后转发桥不执行，应答来自工作台。
    expect(hostForwardingBridge).not.toHaveBeenCalled()
    await expect(dispatched).resolves.toEqual({
      answers: [{ id: 'language', selected: ['TypeScript'] }],
    })
    await bridge.dispose()
  })

  it('幂等-start 重复调用只注册一份监听器', () => {
    const { ctx } = contextWithListeners()
    const seen: unknown[] = []
    const ctx2 = {
      on(name: string, listener: InteractionListener) {
        seen.push([name, listener])
        return () => undefined
      },
    } as unknown as Context
    void ctx
    const bridge = new TeamInteractionBridge(ctx2, { acceptsSession: () => false, onChange: vi.fn() })
    bridge.start()
    bridge.start()
    expect(seen).toHaveLength(2)
    bridge.dispose()
  })

  it('归属-子 agent 提权经 parentSession 归其成员会话（G3）', async () => {
    const { ctx, dispatch } = contextWithListeners()
    const onChange = vi.fn()
    const bridge = new TeamInteractionBridge(ctx, {
      acceptsSession: id => id === 'session-1',
      onChange,
    })
    bridge.start()

    const next = vi.fn(async () => 'unavailable' as const)
    const dispatched = dispatch('approval/request', {
      agent: childAgentOf('child-1', 'session-1'),
      toolName: 'bash',
      reason: '需要访问工作区之外的路径',
    }, next) as Promise<unknown>

    await vi.waitFor(() => {
      expect(bridge.list('session-1')).toEqual([expect.objectContaining({ kind: 'approval' })])
    })
    // record 归属成员会话而非子 agent 会话；转发链被短路。
    expect(bridge.list('child-1')).toEqual([])
    expect(onChange).toHaveBeenCalledWith('session-1')
    expect(next).not.toHaveBeenCalled()

    const pendingId = bridge.list('session-1')[0]!.id
    await bridge.respond('session-1', pendingId, { kind: 'approval', outcome: 'allowed-once' })
    await expect(dispatched).resolves.toBe('allowed-once')
    await bridge.dispose()
  })

  it('归属-解析矩阵（Table-Driven）', async () => {
    const cases: Array<{
      name: string
      agent: { id: string; session?: { id: string; header?: { parentSession?: string } } }
      resolveOwnedSession?: (sessionId: string) => string | undefined
      wantClaimed: boolean
      wantSessionId?: string
    }> = [
      {
        name: '正常-孙 agent 经 scope 回溯命中成员会话',
        agent: childAgentOf('grand-child-1', 'middle-1'),
        resolveOwnedSession: id => id === 'middle-1' ? 'session-1' : undefined,
        wantClaimed: true,
        wantSessionId: 'session-1',
      },
      {
        name: '边界-header 缺失则透传',
        agent: { id: 'stranger-1', session: { id: 'stranger-1' } },
        wantClaimed: false,
      },
      {
        name: '边界-parentSession 非 owned 则透传',
        agent: childAgentOf('child-2', 'stranger-9'),
        wantClaimed: false,
      },
      {
        name: '异常-scope 回溯抛错被包含、按透传处理',
        agent: childAgentOf('child-3', 'stranger-8'),
        resolveOwnedSession: () => { throw new Error('registry exploded') },
        wantClaimed: false,
      },
    ]
    for (const testCase of cases) {
      const { ctx, dispatch } = contextWithListeners()
      const bridge = new TeamInteractionBridge(ctx, {
        acceptsSession: id => id === 'session-1',
        onChange: vi.fn(),
        ...(testCase.resolveOwnedSession === undefined ? {} : { resolveOwnedSession: testCase.resolveOwnedSession }),
      })
      bridge.start()

      const next = vi.fn(async () => 'unavailable' as const)
      const dispatched = dispatch('approval/request', {
        agent: testCase.agent,
        toolName: 'bash',
      }, next) as Promise<unknown>

      if (testCase.wantClaimed) {
        await vi.waitFor(() => {
          expect(bridge.list(testCase.wantSessionId!), testCase.name).toHaveLength(1)
        })
        expect(next, testCase.name).not.toHaveBeenCalled()
        const pendingId = bridge.list(testCase.wantSessionId!)[0]!.id
        await bridge.respond(testCase.wantSessionId!, pendingId, { kind: 'approval', outcome: 'allowed-once' })
        await expect(dispatched).resolves.toBe('allowed-once')
      } else {
        await expect(dispatched).resolves.toBe('unavailable')
        expect(next, testCase.name).toHaveBeenCalled()
        expect(bridge.list('session-1'), testCase.name).toEqual([])
      }
      await bridge.dispose()
    }
  })

  it('日志-未 claim 请求打 warn 且含关键身份字段（G4）', async () => {
    const { ctx, dispatch } = contextWithListeners()
    const warn = vi.fn()
    ;(ctx as unknown as { logger: { warn: (message: string) => void } }).logger = { warn }

    const bridge = new TeamInteractionBridge(ctx, {
      acceptsSession: () => false,
      onChange: vi.fn(),
    })
    bridge.start()

    const next = vi.fn(async () => 'unavailable' as const)
    await dispatch('user-questions/request', {
      questions: [{ id: 'q', question: '选择？', options: [{ label: 'A' }] }],
      agent: childAgentOf('child-10', 'stranger-10'),
    }, next)
    await dispatch('approval/request', {
      agent: childAgentOf('child-11', 'stranger-11'),
      toolName: 'bash',
    }, next)

    expect(warn).toHaveBeenCalledTimes(2)
    const [questionWarn] = warn.mock.calls[0] as [string]
    const [approvalWarn] = warn.mock.calls[1] as [string]
    expect(questionWarn).toContain('will be answered by the host fallback')
    expect(questionWarn).toContain('agent.id=child-10')
    expect(questionWarn).toContain('agent.session.id=child-10')
    expect(questionWarn).toContain('parentSession=stranger-10')
    expect(approvalWarn).toContain('will be answered by the host fallback')
    expect(approvalWarn).toContain('agent.id=child-11')
    expect(approvalWarn).toContain('agent.session.id=child-11')
    expect(approvalWarn).toContain('parentSession=stranger-11')
    expect(approvalWarn).toContain('toolName=bash')
    await bridge.dispose()
  })

  it('日志-agent 缺失时 question 路径同样打 warn 且字段留空占位（B-1 一致性）', async () => {
    const { ctx, dispatch } = contextWithListeners()
    const warn = vi.fn()
    ;(ctx as unknown as { logger: { warn: (message: string) => void } }).logger = { warn }

    const bridge = new TeamInteractionBridge(ctx, {
      acceptsSession: () => false,
      onChange: vi.fn(),
    })
    bridge.start()

    const next = vi.fn(async () => 'unavailable' as const)
    await dispatch('user-questions/request', {
      questions: [{ id: 'q', question: '选择？', options: [{ label: 'A' }] }],
    }, next)

    expect(warn).toHaveBeenCalledTimes(1)
    const [questionWarn] = warn.mock.calls[0] as [string]
    expect(questionWarn).toContain('will be answered by the host fallback')
    expect(questionWarn).toContain('agent.id=undefined')
    expect(questionWarn).toContain('parentSession=undefined')
    expect(next).toHaveBeenCalled()
    await bridge.dispose()
  })

  it('日志-owned 请求不打未 claim warn', async () => {
    const { ctx, dispatch } = contextWithListeners()
    const warn = vi.fn()
    ;(ctx as unknown as { logger: { warn: (message: string) => void } }).logger = { warn }

    const bridge = new TeamInteractionBridge(ctx, {
      acceptsSession: id => id === 'session-1',
      onChange: vi.fn(),
    })
    bridge.start()

    const dispatched = dispatch('approval/request', {
      agent: agentOf('session-1'),
      toolName: 'bash',
    }, vi.fn()) as Promise<unknown>
    await vi.waitFor(() => { expect(bridge.list('session-1')).toHaveLength(1) })
    const pendingId = bridge.list('session-1')[0]!.id
    await bridge.respond('session-1', pendingId, { kind: 'approval', outcome: 'allowed-once' })
    await expect(dispatched).resolves.toBe('allowed-once')
    expect(warn).not.toHaveBeenCalled()
    await bridge.dispose()
  })

  it('竞态-abort 先于应答则 record 撤销且 waterfall 以取消失败收场（QA-1）', async () => {
    for (const kind of ['question', 'approval'] as const) {
      const { ctx, dispatch } = contextWithListeners()
      const bridge = new TeamInteractionBridge(ctx, {
        acceptsSession: id => id === 'session-1',
        onChange: vi.fn(),
      })
      bridge.start()

      const controller = new AbortController()
      const payload = kind === 'question'
        ? { questions: [{ id: 'q', question: '选择？', options: [{ label: 'A' }] }], agent: agentOf('session-1'), signal: controller.signal }
        : { agent: agentOf('session-1'), toolName: 'bash', signal: controller.signal }
      const dispatched = dispatch(kind === 'question' ? 'user-questions/request' : 'approval/request', payload, vi.fn()) as Promise<unknown>

      await vi.waitFor(() => {
        expect(bridge.list('session-1')).toHaveLength(1)
      })
      controller.abort()
      // abort 先到：record 被撤销，waterfall promise 以取消错误失败（不悬挂）。
      await expect(dispatched).rejects.toThrow(/cancel/i)
      expect(bridge.list('session-1')).toEqual([])
      await bridge.dispose()
    }
  })

  it('竞态-abort 后于应答则不重复撤销、结果保持（QA-1 反序）', async () => {
    const { ctx, dispatch } = contextWithListeners()
    const bridge = new TeamInteractionBridge(ctx, {
      acceptsSession: id => id === 'session-1',
      onChange: vi.fn(),
    })
    bridge.start()

    const controller = new AbortController()
    const dispatched = dispatch('approval/request', {
      agent: agentOf('session-1'),
      toolName: 'bash',
      signal: controller.signal,
    }, vi.fn()) as Promise<unknown>

    await vi.waitFor(() => { expect(bridge.list('session-1')).toHaveLength(1) })
    const pendingId = bridge.list('session-1')[0]!.id
    await bridge.respond('session-1', pendingId, { kind: 'approval', outcome: 'allowed-once' })
    // 应答先 settle，迟到的 abort 不得改变结果。
    await expect(dispatched).resolves.toBe('allowed-once')
    controller.abort()
    await expect(dispatched).resolves.toBe('allowed-once')
    expect(bridge.list('session-1')).toEqual([])
    await bridge.dispose()
  })

  it('claims via the agent id when the session id identity differs', async () => {
    const { ctx, dispatch } = contextWithListeners()
    const onChange = vi.fn()
    const bridge = new TeamInteractionBridge(ctx, {
      acceptsSession: id => id === 'agent-1',
      onChange,
    })
    bridge.start()

    const next = vi.fn()
    const dispatched = dispatch('user-questions/request', {
      questions: [{
        id: 'language',
        question: '选择语言？',
        options: [{ label: 'TypeScript' }],
      }],
      agent: { session: { id: SessionId('session-x') }, id: 'agent-1' },
    }, next) as Promise<unknown>

    await vi.waitFor(() => {
      expect(bridge.list('agent-1')).toEqual([expect.objectContaining({ kind: 'question' })])
    })
    expect(onChange).toHaveBeenCalledWith('agent-1')
    const pendingId = bridge.list('agent-1')[0]!.id
    await bridge.respond('agent-1', pendingId, {
      kind: 'question',
      answers: [{ id: 'language', selected: ['TypeScript'] }],
    })
    await expect(dispatched).resolves.toEqual({
      answers: [{ id: 'language', selected: ['TypeScript'] }],
    })
    expect(next).not.toHaveBeenCalled()
    await bridge.dispose()
  })
  it('claims interactions dispatched inside the agent scope via attachAgentContext', async () => {
    const { ctx } = contextWithListeners()
    const onChange = vi.fn()
    const bridge = new TeamInteractionBridge(ctx, {
      acceptsSession: id => id === 'session-1',
      onChange,
    })
    bridge.start()

    const listeners = new Map<string, InteractionListener>()
    const agentCtx = {
      on(name: string, listener: InteractionListener) {
        listeners.set(name, listener)
        return () => { listeners.delete(name) }
      },
    } as unknown as Context
    bridge.attachAgentContext(agentCtx)

    const next = vi.fn()
    const dispatched = (listeners.get('user-questions/request') as InteractionListener)({
      questions: [{
        id: 'language',
        question: '选择语言？',
        options: [{ label: 'TypeScript' }],
      }],
      agent: agentOf('session-1'),
    }, next) as Promise<unknown>

    await expect(bridge.list('session-1')).toEqual([expect.objectContaining({ kind: 'question' })])
    expect(onChange).toHaveBeenCalledWith('session-1')
    const pendingId = bridge.list('session-1')[0]!.id
    await bridge.respond('session-1', pendingId, {
      kind: 'question',
      answers: [{ id: 'language', selected: ['TypeScript'] }],
    })
    await expect(dispatched).resolves.toEqual({
      answers: [{ id: 'language', selected: ['TypeScript'] }],
    })
    expect(next).not.toHaveBeenCalled()
    await bridge.dispose()
  })
})

describe('normalizeQuestionAnswers', () => {
  it('rejects incomplete and forged option answers', () => {
    const questions = [{
      id: 'model',
      question: '选择模型？',
      options: [{ label: 'DeepSeek' }, { label: 'GLM' }],
    }]
    expect(() => normalizeQuestionAnswers(questions, [])).toThrow(AgentTeamError)
    expect(() => normalizeQuestionAnswers(questions, [{
      id: 'model',
      selected: ['Unknown'],
    }])).toThrow('包含无效选项')
  })
})

describe('resolveSessionLineageOwner', () => {
  const owned = new Set(['member-1', 'builder-1'])
  const isOwned = (id: string) => owned.has(id)
  const chain = (parents: Record<string, string>) =>
    (id: string) => parents[id]

  it('归属-正常-子会话逐级回溯到 owned 成员', () => {
    const readParent = chain({ 'child-1': 'member-1', 'grand-child-1': 'child-1' })
    expect(resolveSessionLineageOwner('grand-child-1', readParent, isOwned)).toBe('member-1')
    expect(resolveSessionLineageOwner('child-1', readParent, isOwned)).toBe('member-1')
  })

  it('归属-起点本身 owned 直接返回自身', () => {
    const readParent = chain({ 'member-1': 'root-1' })
    expect(resolveSessionLineageOwner('member-1', readParent, isOwned)).toBe('member-1')
  })

  it('归属-孤立会话无亲缘返回 undefined', () => {
    const readParent = chain({})
    expect(resolveSessionLineageOwner('stranger-1', readParent, isOwned)).toBeUndefined()
  })

  it('归属-环状 parentSession 深度上限截断返回 undefined', () => {
    const readParent = chain({ 'a-1': 'b-1', 'b-1': 'a-1' })
    expect(resolveSessionLineageOwner('a-1', readParent, isOwned)).toBeUndefined()
  })

  it('归属-链深超上限（8 层外仍不 owned）返回 undefined', () => {
    const parents: Record<string, string> = {}
    for (let i = 0; i < 11; i += 1) parents[`n${i}`] = `n${i + 1}`
    const readParent = chain(parents)
    expect(resolveSessionLineageOwner('n0', readParent, isOwned)).toBeUndefined()
  })

  it('异常-parentSession 读取抛错按无亲缘处理、不冒泡', () => {
    const readParent = () => { throw new Error('storage unavailable') }
    expect(resolveSessionLineageOwner('child-9', readParent, isOwned)).toBeUndefined()
  })
})

function agentOf(sessionId: string): { session: { id: ReturnType<typeof SessionId> } } {
  return { session: { id: SessionId(sessionId) } }
}

function childAgentOf(childId: string, parentSessionId: string): {
  id: string
  session: { id: ReturnType<typeof SessionId>; header: { parentSession: ReturnType<typeof SessionId> } }
} {
  return {
    id: childId,
    session: { id: SessionId(childId), header: { parentSession: SessionId(parentSessionId) } },
  }
}

function contextWithListeners(): {
  ctx: Context
  dispatch: (name: string, payload: unknown, next: () => Promise<unknown>) => unknown
} {
  const hooks = new Map<string, InteractionListener[]>()
  const ctx = {
    on(name: string, listener: InteractionListener, options?: { prepend?: boolean }) {
      const list = hooks.get(name) ?? []
      if (options?.prepend === true) list.unshift(listener)
      else list.push(listener)
      hooks.set(name, list)
      return () => {
        const current = hooks.get(name)
        if (current === undefined) return false
        const index = current.indexOf(listener)
        if (index < 0) return false
        current.splice(index, 1)
        return true
      }
    },
  } as unknown as Context
  return {
    ctx,
    // 复刻 cordis waterfall：监听器按注册序（含 prepend）外层优先，不调 next() 即短路。
    dispatch: (name, payload, innerNext) => {
      const list = [...(hooks.get(name) ?? [])]
      const run = (index: number): Promise<unknown> =>
        index >= list.length
          ? innerNext()
          : Promise.resolve(list[index]!(payload, () => run(index + 1)))
      return run(0)
    },
  }
}
