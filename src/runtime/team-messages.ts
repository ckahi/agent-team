import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { freezeMessage, MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { AgentTeamError } from '../domain/errors.js'
import type { TeamAggregate, TeamMessage } from '../domain/types.js'

type TaskStatus = 'pending' | 'assigned' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled'

export function requireMessageContent(value: string): string {
  const content = value.trim()
  if (content.length === 0) throw new AgentTeamError('INVALID_REQUEST', 'Message content cannot be empty')
  if (content.length > 100_000) throw new AgentTeamError('INVALID_REQUEST', 'Message content is too large')
  return content
}

export function createTeamMessage(
  input: Omit<TeamMessage, 'schemaVersion' | 'attachments' | 'deliveryState' | 'createdAt'>,
): TeamMessage {
  return {
    schemaVersion: 1,
    ...input,
    attachments: [],
    deliveryState: 'queued',
    createdAt: new Date().toISOString(),
  }
}

export function createTaskDispatchMessage(input: {
  team: TeamAggregate
  senderSlotId: string
  recipientSlotId: string
  taskId: string
  type: 'instruction' | 'progress' | 'result' | 'question' | 'warning'
  content: string
}): TeamMessage {
  const id = String(MessageId(`agent-team:${randomUUID()}`))
  return createTeamMessage({
    id,
    teamId: input.team.id,
    sender: { kind: 'member', id: input.senderSlotId },
    recipient: input.recipientSlotId === input.team.leaderSlotId
      ? { kind: 'leader', slotId: input.recipientSlotId }
      : { kind: 'member', slotId: input.recipientSlotId },
    type: input.type,
    content: input.content,
    relatedTaskId: input.taskId,
    idempotencyKey: id,
  })
}

export function createSystemTeamMessage(input: {
  team: TeamAggregate
  recipientSlotId: string
  content: string
}): TeamMessage {
  const id = String(MessageId(`agent-team:${randomUUID()}`))
  return createTeamMessage({
    id,
    teamId: input.team.id,
    sender: { kind: 'system', id: 'dsh-agent-team' },
    recipient: input.recipientSlotId === input.team.leaderSlotId
      ? { kind: 'leader', slotId: input.recipientSlotId }
      : { kind: 'member', slotId: input.recipientSlotId },
    type: 'system',
    content: input.content,
    idempotencyKey: id,
  })
}

export function assignmentContent(title: string, description: string, fileScopes: readonly string[]): string {
  return [
    `A team task has been assigned to you: ${title}`,
    description.length === 0 ? undefined : `Description: ${description}`,
    fileScopes.length === 0 ? undefined : `File scopes: ${fileScopes.join(', ')}`,
    'Read the task board for the task id, mark it running when you begin, and report progress or the final result with team_update_task.',
  ].filter((line): line is string => line !== undefined).join('\n')
}

export function reassignmentContent(title: string, result?: string, error?: string): string {
  return [
    `A team task has been reassigned to you: ${title}`,
    result === undefined ? undefined : `Prior result: ${result}`,
    error === undefined ? undefined : `Prior error: ${error}`,
    'Read the task board for details and update the task with team_update_task.',
  ].filter((line): line is string => line !== undefined).join('\n')
}

export function taskUpdateContent(
  title: string,
  status: TaskStatus,
  result?: string,
  error?: string,
): string {
  return [
    `Task update: ${title}`,
    `Status: ${status}`,
    result === undefined ? undefined : `Result: ${result}`,
    error === undefined ? undefined : `Error: ${error}`,
  ].filter((line): line is string => line !== undefined).join('\n')
}

export function taskMessageType(status: TaskStatus): 'progress' | 'result' | 'question' | 'warning' {
  if (status === 'completed') return 'result'
  if (status === 'blocked') return 'question'
  if (status === 'failed' || status === 'cancelled') return 'warning'
  return 'progress'
}

export function messageFromRecord(team: TeamAggregate, record: TeamMessage): UserMessage {
  if (record.sender.kind === 'system') {
    return freezeMessage({
      id: MessageId(record.id),
      role: 'user',
      content: [{ type: 'text', text: `[Team event]\n${record.content}` }],
      source: { kind: 'plugin', plugin: 'dsh-agent-team', form: 'relay' },
    })
  }
  const sender = record.sender.kind === 'member' ? team.members[record.sender.id] : undefined
  const retiredSender = record.sender.kind === 'member'
    ? Object.values(team.retiredSessions).find(session => session.formerSlotId === record.sender.id)
    : undefined
  const senderName = sender?.displayName ?? retiredSender?.displayName ?? '已移出成员'
  const text = record.sender.kind === 'member'
    ? `${teamMessageHeader(senderName, record.sender.id)}\n${record.content}`
    : record.content
  return freezeMessage({
    id: MessageId(record.id),
    role: 'user',
    content: [{ type: 'text', text }],
    source: record.sender.kind === 'member'
      ? { kind: 'plugin', plugin: 'dsh-agent-team', form: 'relay' }
      : { kind: 'user' },
  })
}

export function teamMessageHeader(displayName: string, slotId: string): string {
  return `[Team message from ${displayName}; slotId=${slotId}]`
}

export function sessionHasMessage(agent: Agent, messageId: string): boolean {
  return agent.session.snapshotEvents().some(event => {
    if (event.type !== 'agent/inbox/spliced') return false
    return event.data.inserted.some(message => String(message.id) === messageId)
  })
}
