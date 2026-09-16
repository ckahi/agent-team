import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { projectContextUsage, projectConversation } from '../src/runtime/conversation-projector.js'

describe('projectConversation', () => {
  it('projects an assistant message with embedded stream records as text plus reasoning', () => {
    const projected = projectConversation([
      event(0, 'user/message', {
        id: 'user-1', role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: 'Build it' }],
      }),
      event(1, 'assistant/message', {
        turn: 1,
        step: 1,
        message: {
          id: 'assistant-1', role: 'assistant', source: { kind: 'model', provider: 'openai', model: 'codex' },
          content: [{ type: 'reasoning', text: 'Checking files' }, { type: 'text', text: 'Working' }],
        },
        stream: [
          { type: 'reasoning-chunks', time0: 1_700_000_000_002, index: 1, dt: [], texts: ['Checking files'] },
          { type: 'text-chunks', time0: 1_700_000_000_003, index: 0, dt: [], texts: ['Working'] },
        ],
      }),
    ])

    expect(projected.throughSeq).toBe(1)
    expect(projected.nodes).toEqual([
      expect.objectContaining({ kind: 'user', text: 'Build it' }),
      expect.objectContaining({ kind: 'assistant', text: 'Working', reasoning: 'Checking files' }),
    ])
  })

  it('pairs a tool call with its result next to the final assistant message', () => {
    const projected = projectConversation([
      event(0, 'assistant/message', {
        turn: 1,
        step: 1,
        message: {
          id: 'assistant-1', role: 'assistant', source: { kind: 'model', provider: 'openai', model: 'codex' },
          content: [{ type: 'text', text: 'Final answer' }],
        },
        stream: [],
      }),
      event(2, 'tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{"path":"a.ts"}' }),
      event(3, 'tool/result', {
        turn: 1,
        step: 1,
        message: {
          id: 'tool-result-1', role: 'user', source: { kind: 'tool', callId: 'call-1' },
          content: [{
            type: 'tool-result', toolCallId: 'call-1', isError: false,
            content: [{ type: 'text', text: 'file contents' }],
          }],
        },
      }),
    ])

    expect(projected.nodes).toEqual([
      expect.objectContaining({ kind: 'assistant', text: 'Final answer' }),
      expect.objectContaining({ kind: 'tool', name: 'read', status: 'success', result: 'file contents' }),
    ])
  })

  it('derives reasoning timing from completed stream block records', () => {
    const projected = projectConversation([
      timedEvent(0, 3_500, 'assistant/message', {
        turn: 2,
        step: 1,
        message: {
          id: 'assistant-2', role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
          content: [
            { type: 'reasoning', text: '完整思考' },
            { type: 'text', text: '完整回复' },
          ],
        },
        stream: [
          { type: 'chunk', time: 1_000, chunk: { type: 'reasoning-delta', index: 0, text: '分析中' } },
          { type: 'chunk', time: 3_400, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: '分析完成' } } },
        ],
      }),
    ])

    expect(projected.nodes).toEqual([
      expect.objectContaining({
        kind: 'assistant',
        text: '完整回复',
        reasoning: '完整思考',
        reasoningStartedAt: 1_000,
        reasoningCompletedAt: 3_400,
      }),
    ])
  })

  it('keeps model-facing context out of the visible conversation', () => {
    const projected = projectConversation([
      event(0, 'user/message', {
        id: 'context-snapshot', role: 'user',
        source: {
          kind: 'plugin', plugin: 'dsh-runtime-context', form: 'snapshot',
          sections: [{ name: 'policy', text: 'Current runtime context' }],
        },
        content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier snapshots.' }],
      }),
      event(1, 'user/message', {
        id: 'skills-catalog', role: 'user',
        source: { kind: 'plugin', plugin: 'dsh-skills', form: 'catalog' },
        content: [{ type: 'text', text: '<system-reminder><available_skills>secret catalog</available_skills></system-reminder>' }],
      }),
      event(2, 'user/message', {
        id: 'user-1', role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: '你好' }],
      }),
      event(3, 'user/message', {
        id: 'relay-1', role: 'user',
        source: { kind: 'plugin', plugin: 'dsh-agent-team', form: 'relay' },
        content: [{ type: 'text', text: 'Leader 分配的任务' }],
      }),
      event(4, 'user/message', {
        id: 'foreign-relay', role: 'user',
        source: { kind: 'plugin', plugin: 'another-plugin', form: 'relay' },
        content: [{ type: 'text', text: '其他插件的内部转发' }],
      }),
    ])

    expect(projected.nodes).toEqual([
      expect.objectContaining({ kind: 'user', text: '你好' }),
      expect.objectContaining({ kind: 'user', text: 'Leader 分配的任务' }),
    ])
    expect(JSON.stringify(projected.nodes)).not.toContain('Current runtime context')
    expect(JSON.stringify(projected.nodes)).not.toContain('available_skills')
  })

  it('projects persisted member relays as structured compact team messages', () => {
    const projected = projectConversation([
      event(0, 'user/message', {
        id: 'relay-1', role: 'user',
        source: { kind: 'plugin', plugin: 'dsh-agent-team', form: 'relay' },
        content: [{ type: 'text', text: '[Team message from Coder]\nParser implemented.' }],
      }),
    ], 240, {
      team: {
        leaderSlotId: 'leader-1',
        members: {
          'leader-1': { id: 'leader-1', displayName: 'Lead' },
          'member-1': { id: 'member-1', displayName: 'Coder' },
        },
        retiredSessions: {},
      } as never,
      messages: [{
        id: 'relay-1',
        sender: { kind: 'member', id: 'member-1' },
        type: 'result',
        content: 'Parser implemented.',
        relatedTaskId: 'task-1',
      } as never],
    })

    expect(projected.nodes).toEqual([{
      id: 'relay-1',
      kind: 'team-message',
      seq: 0,
      time: 1_700_000_000_000,
      text: 'Parser implemented.',
      senderName: 'Coder',
      senderId: 'member-1',
      senderRole: 'member',
      messageType: 'result',
      relatedTaskId: 'task-1',
    }])
  })

  it('folds compaction checkpoints into a counted notice and drops shadowed history', () => {
    const projected = projectConversation([
      event(0, 'user/message', {
        id: 'user-old', role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: '被压缩的早期消息' }],
      }),
      event(1, 'assistant/message', {
        turn: 1, step: 1,
        message: {
          id: 'assistant-old', role: 'assistant', source: { kind: 'model', provider: 'openai', model: 'codex' },
          content: [{ type: 'text', text: '被压缩的早期回复' }],
        },
        stream: [],
      }),
      event(2, 'compaction/summary', {
        compactionId: 'cmp-1',
        shadowedSeqs: [0, 1],
        shadowedTokenCount: 900,
      }),
      event(3, 'user/message', {
        id: 'compact-checkpoint', role: 'user',
        source: { kind: 'plugin', plugin: 'compact', compactionId: 'cmp-1' },
        content: [{ type: 'text', text: 'summary text' }],
      }),
      event(4, 'user/message', {
        id: 'user-new', role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: '压缩后的新消息' }],
      }),
    ])

    expect(projected.nodes).toEqual([
      expect.objectContaining({ kind: 'notice', tone: 'neutral', text: '已压缩 2 条历史' }),
      expect.objectContaining({ kind: 'user', text: '压缩后的新消息' }),
    ])
    expect(JSON.stringify(projected.nodes)).not.toContain('被压缩的早期')
    expect(JSON.stringify(projected.nodes)).not.toContain('summary text')
  })

  it('renders a compaction checkpoint without a summary event as an uncounted notice', () => {
    const projected = projectConversation([
      event(0, 'user/message', {
        id: 'compact-checkpoint', role: 'user',
        source: { kind: 'plugin', plugin: 'compact', compactionId: 'cmp-2' },
        content: [{ type: 'text', text: 'summary' }],
      }),
    ])

    expect(projected.nodes).toEqual([
      expect.objectContaining({ kind: 'notice', tone: 'neutral', text: '已压缩历史消息' }),
    ])
  })
})

describe('projectContextUsage', () => {
  it('uses the latest prompt-side provider sample and context capacity', () => {
    const projected = projectContextUsage([
      event(0, 'request/context', { provider: 'zai-coding-cn', model: 'glm-5.3', contextWindow: 128_000 }),
      event(1, 'assistant/message', {
        turn: 1,
        step: 1,
        message: {
          id: 'assistant-1', role: 'assistant', source: { kind: 'model', provider: 'zai-coding-cn', model: 'glm-5.3' },
          content: [{ type: 'text', text: 'First' }],
        },
        stream: [],
        usage: { inputTokens: 1_000, outputTokens: 250, cacheReadTokens: 2_000, cacheWriteTokens: 300 },
      }),
      event(2, 'assistant/message', {
        turn: 2,
        step: 1,
        message: {
          id: 'assistant-2', role: 'assistant', source: { kind: 'model', provider: 'zai-coding-cn', model: 'glm-5.3' },
          content: [{ type: 'text', text: 'Second' }],
        },
        stream: [],
        usage: { inputTokens: 2_000, outputTokens: 400, cacheReadTokens: 4_000, cacheWriteTokens: 500 },
      }),
    ])

    expect(projected).toEqual({
      usedTokens: 6_900,
      inputTokens: 6_500,
      outputTokens: 400,
      cacheReadTokens: 4_000,
      cacheWriteTokens: 500,
      reasoningTokens: 0,
      contextWindow: 128_000,
    })
  })

  it('requires real usage but still reports details when the window is unknown', () => {
    expect(projectContextUsage([
      event(0, 'request/context', { provider: 'openai', model: 'codex', contextWindow: 200_000 }),
    ])).toBeUndefined()
    expect(projectContextUsage([
      event(0, 'assistant/message', {
        turn: 1,
        step: 1,
        message: {
          id: 'assistant-1', role: 'assistant', source: { kind: 'model', provider: 'openai', model: 'codex' },
          content: [],
        },
        usage: { inputTokens: 1_000, outputTokens: 100 },
      }),
    ])).toEqual({
      usedTokens: 1_100,
      inputTokens: 1_000,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    })
  })
})

function event(seq: number, type: SessionEvent['type'], data: unknown): SessionEvent {
  return { seq, time: 1_700_000_000_000 + seq, type, data } as SessionEvent
}

function timedEvent(seq: number, time: number, type: SessionEvent['type'], data: unknown): SessionEvent {
  return { seq, time, type, data } as SessionEvent
}
