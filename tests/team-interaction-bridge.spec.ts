import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AgentTeamError } from '../src/domain/errors.js'
import {
  normalizeQuestionAnswers,
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

function agentOf(sessionId: string): { session: { id: ReturnType<typeof SessionId> } } {
  return { session: { id: SessionId(sessionId) } }
}

function contextWithListeners(): {
  ctx: Context
  dispatch: (name: string, payload: unknown, next: () => Promise<unknown>) => unknown
} {
  const listeners = new Map<string, InteractionListener>()
  const ctx = {
    on(name: string, listener: InteractionListener) {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
  } as unknown as Context
  return {
    ctx,
    dispatch: (name, payload, next) => listeners.get(name)?.(payload, next),
  }
}
