import { randomUUID } from 'node:crypto'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { AgentTeamError } from '../domain/errors.js'
import type { AgentTeamService } from '../service/agent-team-service.js'
import {
  assignmentContent,
  createTaskDispatchMessage,
  createTeamMessage,
  reassignmentContent,
  requireMessageContent,
  taskMessageType,
  taskUpdateContent,
  teamMessageHeader,
} from './team-messages.js'

interface TeamCommandPort {
  deliverMessage: (teamId: string, messageId: string) => Promise<boolean>
  followup: (sessionId: string, message: UserMessage) => void
}

export class TeamCommandHandler {
  constructor(
    private readonly service: AgentTeamService,
    private readonly port: TeamCommandPort,
  ) {}

  async createTask(
    teamId: string,
    creatorSlotId: string,
    input: { title: string; description?: string; ownerSlotId?: string; fileScopes?: string[] },
  ): Promise<{ taskId: string; status: string; deliveryState?: 'queued' | 'delivered' }> {
    const team = this.service.getTeam(teamId)
    if (team.leaderSlotId !== creatorSlotId) {
      throw new AgentTeamError('INVALID_REQUEST', 'Only the current team leader may create tasks')
    }
    if (input.ownerSlotId !== undefined && team.members[input.ownerSlotId] === undefined) {
      throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown task owner '${input.ownerSlotId}'`)
    }
    const title = requireShortText(input.title, 'Task title', 500)
    const now = new Date().toISOString()
    const taskId = randomUUID()
    const status = input.ownerSlotId === undefined ? 'pending' as const : 'assigned' as const
    const owner = input.ownerSlotId === undefined ? undefined : team.members[input.ownerSlotId]
    const assignment = owner === undefined || owner.id === creatorSlotId
      ? undefined
      : createTaskDispatchMessage({
        team,
        senderSlotId: creatorSlotId,
        recipientSlotId: owner.id,
        taskId,
        type: 'instruction',
        content: assignmentContent(title, input.description?.trim() ?? '', uniqueStrings(input.fileScopes ?? [])),
      })
    await this.service.updateRuntimeTeam(
      teamId,
      current => ({
        ...current,
        tasks: {
          ...current.tasks,
          [taskId]: {
            id: taskId,
            title,
            description: input.description?.trim() ?? '',
            status,
            ...(input.ownerSlotId === undefined ? {} : { ownerSlotId: input.ownerSlotId }),
            createdBySlotId: creatorSlotId,
            dependencyIds: [],
            fileScopes: uniqueStrings(input.fileScopes ?? []),
            revision: 1,
            createdAt: now,
            updatedAt: now,
          },
        },
        outbox: assignment === undefined
          ? current.outbox
          : { ...current.outbox, [assignment.id]: assignment },
      }),
      'team.task_created',
      `Task ${title} created`,
    )
    if (assignment === undefined) return { taskId, status }
    const delivered = await this.port.deliverMessage(teamId, assignment.id)
    return { taskId, status, deliveryState: delivered ? 'delivered' : 'queued' }
  }

  async updateTask(
    teamId: string,
    callerSlotId: string,
    input: {
      taskId: string
      status: 'pending' | 'assigned' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled'
      result?: string
      error?: string
      ownerSlotId?: string
    },
  ): Promise<{ taskId: string; status: string; deliveryState?: 'queued' | 'delivered' }> {
    const team = this.service.getTeam(teamId)
    const task = team.tasks[input.taskId]
    if (task === undefined) throw new AgentTeamError('INVALID_REQUEST', `Unknown task '${input.taskId}'`)
    if (callerSlotId !== team.leaderSlotId && task.ownerSlotId !== callerSlotId) {
      throw new AgentTeamError('INVALID_REQUEST', 'A member may update only its own task')
    }
    if (input.ownerSlotId !== undefined) {
      if (callerSlotId !== team.leaderSlotId) {
        throw new AgentTeamError('INVALID_REQUEST', 'Only the team leader may reassign tasks')
      }
      if (team.members[input.ownerSlotId] === undefined) {
        throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown task owner '${input.ownerSlotId}'`)
      }
    }
    const nextOwnerSlotId = input.ownerSlotId ?? task.ownerSlotId
    const ownerChanged = input.ownerSlotId !== undefined && input.ownerSlotId !== task.ownerSlotId
    const shouldDispatchAssignment = ownerChanged
      && nextOwnerSlotId !== undefined
      && nextOwnerSlotId !== callerSlotId
    const shouldNotifyLeader = callerSlotId !== team.leaderSlotId
    const notification = shouldDispatchAssignment
      ? createTaskDispatchMessage({
        team,
        senderSlotId: callerSlotId,
        recipientSlotId: nextOwnerSlotId!,
        taskId: task.id,
        type: 'instruction',
        content: reassignmentContent(task.title, input.result, input.error),
      })
      : shouldNotifyLeader
        ? createTaskDispatchMessage({
          team,
          senderSlotId: callerSlotId,
          recipientSlotId: team.leaderSlotId,
          taskId: task.id,
          type: taskMessageType(input.status),
          content: taskUpdateContent(task.title, input.status, input.result, input.error),
        })
        : undefined
    await this.service.updateRuntimeTeam(
      teamId,
      current => ({
        ...current,
        tasks: {
          ...current.tasks,
          [input.taskId]: {
            ...current.tasks[input.taskId]!,
            status: input.status,
            ...(input.result === undefined ? {} : { result: input.result }),
            ...(input.error === undefined ? {} : { error: input.error }),
            ...(input.ownerSlotId === undefined ? {} : { ownerSlotId: input.ownerSlotId }),
            revision: current.tasks[input.taskId]!.revision + 1,
            updatedAt: new Date().toISOString(),
          },
        },
        outbox: notification === undefined
          ? current.outbox
          : { ...current.outbox, [notification.id]: notification },
      }),
      'team.task_updated',
      `Task ${task.title} entered ${input.status}`,
    )
    if (notification === undefined) return { taskId: input.taskId, status: input.status }
    const delivered = await this.port.deliverMessage(teamId, notification.id)
    return {
      taskId: input.taskId,
      status: input.status,
      deliveryState: delivered ? 'delivered' : 'queued',
    }
  }

  async sendMemberMessage(
    teamId: string,
    senderSlotId: string,
    recipientSlotId: string,
    rawContent: string,
    type: 'instruction' | 'progress' | 'result' | 'question' | 'warning' = 'progress',
  ): Promise<{ messageId: string; deliveryState: 'delivered' }> {
    const team = this.service.getTeam(teamId)
    const sender = team.members[senderSlotId]
    const recipient = team.members[recipientSlotId]
    if (sender === undefined || recipient === undefined) {
      throw new AgentTeamError('MEMBER_NOT_FOUND', 'Sender or recipient is not a current team member')
    }
    if (senderSlotId !== team.leaderSlotId && recipientSlotId !== team.leaderSlotId && !team.directMemberChat) {
      throw new AgentTeamError('INVALID_REQUEST', 'Direct member-to-member messages are disabled')
    }
    const content = requireMessageContent(rawContent)
    const relay = createUserMessage({
      content: [{ type: 'text', text: `${teamMessageHeader(sender.displayName, sender.id)}\n${content}` }],
      source: {
        kind: 'agent-team',
        form: 'relay',
      },
    })
    const record = createTeamMessage({
      id: String(relay.id),
      teamId,
      sender: { kind: 'member', id: senderSlotId },
      recipient: recipientSlotId === team.leaderSlotId
        ? { kind: 'leader', slotId: recipientSlotId }
        : { kind: 'member', slotId: recipientSlotId },
      type,
      content,
      idempotencyKey: String(relay.id),
    })
    await this.service.putRuntimeMessage(record)
    try {
      this.port.followup(recipient.sessionId, relay)
      await this.service.putRuntimeMessage({ ...record, deliveryState: 'delivered' })
      return { messageId: record.id, deliveryState: 'delivered' }
    } catch (error) {
      await this.service.putRuntimeMessage({ ...record, deliveryState: 'failed' })
      throw error
    }
  }
}

function requireShortText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new AgentTeamError('INVALID_REQUEST', `${label} cannot be empty`)
  if (normalized.length > maxLength) throw new AgentTeamError('INVALID_REQUEST', `${label} is too long`)
  return normalized
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}
