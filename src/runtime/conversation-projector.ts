import type { AssistantStreamRecord, ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TeamAggregate, TeamMessage } from '../domain/types.js'
import type { ConversationNode, MemberConversationView } from '../transport/contracts.js'

interface TeamProjectionContext {
  team: Pick<TeamAggregate, 'leaderSlotId' | 'members' | 'retiredSessions'>
  messages: readonly TeamMessage[]
}

export function projectContextUsage(
  events: readonly SessionEvent[],
): MemberConversationView['contextUsage'] {
  let latestUsage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
  } | undefined
  let contextWindow: number | undefined

  for (const event of events) {
    if (event.type === 'request/context') contextWindow = event.data.contextWindow
    const usage = event.type === 'assistant/message' ? event.data.usage : undefined
    if (usage !== undefined) latestUsage = usage
  }

  if (latestUsage === undefined) return undefined
  const cacheReadTokens = latestUsage.cacheReadTokens ?? 0
  const cacheWriteTokens = latestUsage.cacheWriteTokens ?? 0
  const inputTokens = latestUsage.inputTokens + cacheReadTokens + cacheWriteTokens
  const outputTokens = latestUsage.outputTokens
  return {
    usedTokens: inputTokens + outputTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens: latestUsage.reasoningTokens ?? 0,
    ...(contextWindow === undefined ? {} : { contextWindow }),
  }
}

export function projectConversation(
  events: readonly SessionEvent[],
  limit = 240,
  teamContext?: TeamProjectionContext,
): {
  throughSeq: number
  nodes: ConversationNode[]
} {
  const nodes: ConversationNode[] = []
  const tools = new Map<string, number>()
  const teamMessages = new Map(teamContext?.messages.map(message => [message.id, message]) ?? [])

  for (const event of events) {
    switch (event.type) {
      case 'user/message': {
        if (!isVisibleUserSource(event.data.source)) break
        const text = textOf(event.data.content)
        if (text.length > 0) {
          const messageId = String(event.data.id)
          const teamMessage = teamMessages.get(messageId)
          if (teamContext !== undefined && teamMessage !== undefined && teamMessage.sender.kind !== 'user') {
            nodes.push(teamMessageNode(teamContext.team, teamMessage, event.seq, event.time))
          } else {
            nodes.push({
              id: messageId,
              kind: 'user',
              seq: event.seq,
              time: event.time,
              text,
            })
          }
        }
        break
      }
      case 'assistant/message': {
        const text = textOf(event.data.message.content)
        const reasoning = reasoningOf(event.data.message.content)
        if (text.length > 0 || reasoning.length > 0) {
          const timing = reasoningTimingOf(event.data.stream ?? [])
          nodes.push({
            id: String(event.data.message.id),
            kind: 'assistant',
            seq: event.seq,
            time: event.time,
            text,
            ...(reasoning.length === 0 ? {} : { reasoning }),
            ...(timing.startedAt === undefined ? {} : {
              reasoningStartedAt: timing.startedAt,
              ...(timing.completedAt === undefined ? {} : {
                reasoningCompletedAt: timing.completedAt,
              }),
            }),
          })
        }
        break
      }
      case 'tool/call': {
        const callId = String(event.data.callId)
        tools.set(callId, nodes.length)
        nodes.push({
          id: `tool:${callId}`,
          kind: 'tool',
          seq: event.seq,
          time: event.time,
          callId,
          name: event.data.name,
          arguments: event.data.arguments,
          status: 'running',
        })
        break
      }
      case 'tool/result': {
        const callId = String(event.data.message.content[0].toolCallId)
        const index = tools.get(callId)
        const result = textOf(event.data.message.content[0].content)
        const error = event.data.error === undefined
          ? undefined
          : `${event.data.error.name}: ${event.data.error.code}`
        if (index !== undefined) {
          const node = nodes[index]
          if (node?.kind === 'tool') nodes[index] = {
            ...node,
            seq: event.seq,
            status: event.data.message.content[0].isError === true || error !== undefined ? 'error' : 'success',
            ...(result.length === 0 ? {} : { result }),
            ...(error === undefined ? {} : { error }),
          }
        } else {
          nodes.push({
            id: `tool:${callId}`,
            kind: 'tool',
            seq: event.seq,
            time: event.time,
            callId,
            name: 'tool',
            arguments: '',
            status: event.data.message.content[0].isError === true || error !== undefined ? 'error' : 'success',
            ...(result.length === 0 ? {} : { result }),
            ...(error === undefined ? {} : { error }),
          })
        }
        break
      }
      case 'turn/end': {
        if (event.data.reason.kind === 'error') nodes.push({
          id: `turn-error:${event.seq}`,
          kind: 'notice',
          seq: event.seq,
          time: event.time,
          tone: 'error',
          text: event.data.reason.error.message,
        })
        if (event.data.reason.kind === 'max-tokens') nodes.push({
          id: `turn-warning:${event.seq}`,
          kind: 'notice',
          seq: event.seq,
          time: event.time,
          tone: 'warning',
          text: '本轮输出已达到模型长度上限。',
        })
        break
      }
    }
  }

  nodes.sort((left, right) => left.seq - right.seq)
  return {
    throughSeq: events.at(-1)?.seq ?? -1,
    nodes: nodes.slice(-limit),
  }
}

/**
 * 0.1.5 起流式 chunk 不再是会话事件，`assistant/message` 内嵌完整流记录；
 * 由此还原 reasoning 起止时间（仅用于 UI 呈现，取首次出现时刻即可）。
 */
function reasoningTimingOf(stream: readonly AssistantStreamRecord[]): {
  startedAt?: number
  completedAt?: number
} {
  let startedAt: number | undefined
  let completedAt: number | undefined
  const noteReasoning = (time: number): void => { startedAt ??= time }
  const noteText = (time: number): void => { if (startedAt !== undefined) completedAt ??= time }
  for (const record of stream) {
    if (record.type === 'chunk') {
      const chunk = record.chunk
      if (chunk.type === 'reasoning-delta') {
        if (chunk.text.length > 0) noteReasoning(record.time)
      } else if (chunk.type === 'text-delta') {
        if (chunk.text.length > 0) noteText(record.time)
      } else if (chunk.type === 'block-end') {
        if (chunk.block.type === 'reasoning' && chunk.block.text.length > 0) {
          noteReasoning(record.time)
          noteText(record.time)
        }
        if (chunk.block.type === 'text') noteText(record.time)
      }
    } else if (record.type === 'reasoning-chunks') {
      if (record.texts.some(text => text.length > 0)) noteReasoning(record.time0)
    } else if (record.type === 'text-chunks') {
      if (record.texts.some(text => text.length > 0)) noteText(record.time0)
    }
  }
  return {
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
  }
}

function teamMessageNode(
  team: TeamProjectionContext['team'],
  message: TeamMessage,
  seq: number,
  time: number,
): Extract<ConversationNode, { kind: 'team-message' }> {
  if (message.sender.kind === 'system') {
    return {
      id: message.id,
      kind: 'team-message',
      seq,
      time,
      text: message.content,
      senderName: '团队事件',
      senderId: message.sender.id,
      senderRole: 'system',
      messageType: message.type,
      ...(message.relatedTaskId === undefined ? {} : { relatedTaskId: message.relatedTaskId }),
    }
  }
  const current = team.members[message.sender.id]
  const retired = Object.values(team.retiredSessions)
    .find(session => session.formerSlotId === message.sender.id)
  return {
    id: message.id,
    kind: 'team-message',
    seq,
    time,
    text: message.content,
    senderName: current?.displayName ?? retired?.displayName ?? '已移出成员',
    senderId: message.sender.id,
    senderRole: message.sender.id === team.leaderSlotId ? 'leader' : 'member',
    messageType: message.type,
    ...(message.relatedTaskId === undefined ? {} : { relatedTaskId: message.relatedTaskId }),
  }
}

function isVisibleUserSource(source: MessageSource): boolean {
  if (source.kind === 'user') return true
  if (source.kind !== 'plugin') return false
  return source.plugin === 'dsh-agent-team' && source.form === 'relay'
}

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap(block => {
    if (block.type === 'text') return [block.text]
    if (block.type === 'tool-result') return [textOf(block.content)]
    if (block.type === 'image') return ['[图片]']
    return []
  }).filter(Boolean).join('\n')
}

function reasoningOf(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap(block => block.type === 'reasoning' ? [block.text] : []).join('\n')
}
