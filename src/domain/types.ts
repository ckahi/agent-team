import type { z } from 'zod'
import type {
  assistantSnapshotSchema,
  addTeamMemberInputSchema,
  assistantTemplateSchema,
  cloneTeamInputSchema,
  createAssistantInputSchema,
  createTeamDraftInputSchema,
  createTeamMemberInputSchema,
  fileScopeLeaseSchema,
  memberRuntimeStateSchema,
  operationSchema,
  retiredMemberSessionSchema,
  teamActivitySchema,
  teamAggregateSchema,
  teamLastErrorSchema,
  teamMemberSlotSchema,
  teamMessageSchema,
  teamTaskSchema,
  updateAssistantInputSchema,
} from './schemas.js'

export type AssistantSnapshot = z.infer<typeof assistantSnapshotSchema>
export type AssistantTemplate = z.infer<typeof assistantTemplateSchema>
export type CreateAssistantInput = z.infer<typeof createAssistantInputSchema>
export type UpdateAssistantInput = z.infer<typeof updateAssistantInputSchema>
export type MemberRuntimeState = z.infer<typeof memberRuntimeStateSchema>
export type TeamMemberSlot = z.infer<typeof teamMemberSlotSchema>
export type RetiredMemberSession = z.infer<typeof retiredMemberSessionSchema>
export type TeamTask = z.infer<typeof teamTaskSchema>
export type FileScopeLease = z.infer<typeof fileScopeLeaseSchema>
export type TeamAggregate = z.infer<typeof teamAggregateSchema>
export type TeamLastError = z.infer<typeof teamLastErrorSchema>
export type TeamMessage = z.infer<typeof teamMessageSchema>
export type TeamActivity = z.infer<typeof teamActivitySchema>
export type Operation = z.infer<typeof operationSchema>
export type CreateTeamMemberInput = z.infer<typeof createTeamMemberInputSchema>
export type AddTeamMemberInput = z.infer<typeof addTeamMemberInputSchema>
export type CreateTeamDraftInput = z.infer<typeof createTeamDraftInputSchema>
export type CloneTeamInput = z.infer<typeof cloneTeamInputSchema>

export interface Page<T> {
  items: T[]
  total: number
}

export function snapshotAssistant(assistant: AssistantTemplate): AssistantSnapshot {
  return {
    assistantId: assistant.id,
    revision: assistant.revision,
    name: assistant.name,
    instructions: assistant.instructions,
    provider: assistant.provider,
    model: assistant.model,
    ...(assistant.reasoningEffort === undefined ? {} : { reasoningEffort: assistant.reasoningEffort }),
    agentPresetId: assistant.agentPresetId,
    permissionPresetId: assistant.permissionPresetId,
    skillAllowlist: [...assistant.skillAllowlist],
    mcpServers: [...assistant.mcpServers],
  }
}

export function rebuildMemberSnapshot(member: TeamMemberSlot, assistant: AssistantTemplate): TeamMemberSlot {
  return {
    ...member,
    displayName: assistant.name,
    assistantSnapshot: snapshotAssistant(assistant),
  }
}

export function isTeamBusy(team: TeamAggregate): boolean {
  return Object.values(team.members).some(member => (
    member.lastRuntimeState === 'running' || member.lastRuntimeState === 'waiting_approval'
  )) || Object.values(team.tasks).some(task => task.status === 'running')
}

export function memberTemplateDrift(member: TeamMemberSlot, assistant: AssistantTemplate): boolean {
  const fresh = snapshotAssistant(assistant)
  const current = member.assistantSnapshot
  return member.displayName !== assistant.name
    || current.assistantId !== fresh.assistantId
    || current.revision !== fresh.revision
    || current.name !== fresh.name
    || current.instructions !== fresh.instructions
    || current.provider !== fresh.provider
    || current.model !== fresh.model
    || current.reasoningEffort !== fresh.reasoningEffort
    || current.agentPresetId !== fresh.agentPresetId
    || current.permissionPresetId !== fresh.permissionPresetId
    || current.skillAllowlist.length !== fresh.skillAllowlist.length
    || fresh.skillAllowlist.some((value, index) => value !== current.skillAllowlist[index])
    || current.mcpServers.length !== fresh.mcpServers.length
    || fresh.mcpServers.some((value, index) => value !== current.mcpServers[index])
}
