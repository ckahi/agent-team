import { z } from 'zod'

const isoDate = z.iso.datetime({ offset: true })
const nonEmpty = z.string().trim().min(1)

export const assistantSnapshotSchema = z.object({
  assistantId: nonEmpty,
  revision: z.int().positive(),
  name: nonEmpty,
  instructions: z.string(),
  provider: nonEmpty,
  model: nonEmpty,
  reasoningEffort: nonEmpty.optional(),
  agentPresetId: nonEmpty,
  permissionPresetId: nonEmpty,
  skillAllowlist: z.array(nonEmpty),
  mcpServers: z.array(nonEmpty),
}).strict()

export const assistantTemplateSchema = z.object({
  schemaVersion: z.literal(1),
  id: nonEmpty,
  name: nonEmpty,
  description: z.string().optional(),
  icon: z.string().optional(),
  instructions: z.string(),
  provider: nonEmpty,
  model: nonEmpty,
  reasoningEffort: nonEmpty.optional(),
  agentPresetId: nonEmpty,
  permissionPresetId: nonEmpty,
  skillAllowlist: z.array(nonEmpty),
  mcpServers: z.array(nonEmpty),
  revision: z.int().positive(),
  createdAt: isoDate,
  updatedAt: isoDate,
}).strict()

export const memberRuntimeStateSchema = z.enum([
  'offline',
  'starting',
  'idle',
  'running',
  'waiting_approval',
  'error',
])

export const teamMemberSlotSchema = z.object({
  id: nonEmpty,
  assistantId: nonEmpty,
  displayName: nonEmpty,
  role: z.enum(['leader', 'member']),
  assistantSnapshot: assistantSnapshotSchema,
  permissionPresetId: nonEmpty,
  reasoningEffort: nonEmpty.optional(),
  sessionId: nonEmpty,
  desiredState: z.enum(['online', 'offline', 'removing']),
  lastRuntimeState: memberRuntimeStateSchema,
  joinedAt: isoDate,
}).strict()

export const retiredMemberSessionSchema = z.object({
  formerSlotId: nonEmpty,
  sessionId: nonEmpty,
  displayName: nonEmpty,
  removedAt: isoDate,
}).strict()

export const teamTaskSchema = z.object({
  id: nonEmpty,
  title: nonEmpty,
  description: z.string(),
  status: z.enum(['pending', 'assigned', 'running', 'blocked', 'completed', 'failed', 'cancelled']),
  ownerSlotId: nonEmpty.optional(),
  createdBySlotId: nonEmpty.optional(),
  dependencyIds: z.array(nonEmpty),
  fileScopes: z.array(nonEmpty),
  result: z.string().optional(),
  error: z.string().optional(),
  revision: z.int().positive(),
  createdAt: isoDate,
  updatedAt: isoDate,
}).strict()

export const fileScopeLeaseSchema = z.object({
  id: nonEmpty,
  slotId: nonEmpty,
  taskId: nonEmpty,
  path: nonEmpty,
  acquiredAt: isoDate,
  expiresAt: isoDate.optional(),
}).strict()

const attachmentRefSchema = z.object({
  kind: z.enum(['workspace_path', 'url']),
  value: nonEmpty,
  label: z.string().optional(),
}).strict()

export const teamMessageSchema = z.object({
  schemaVersion: z.literal(1),
  id: nonEmpty,
  teamId: nonEmpty,
  sender: z.object({
    kind: z.enum(['user', 'member', 'system']),
    id: nonEmpty,
  }).strict(),
  recipient: z.object({
    kind: z.enum(['leader', 'member', 'broadcast']),
    slotId: nonEmpty.optional(),
  }).strict(),
  type: z.enum(['instruction', 'progress', 'result', 'question', 'warning', 'system']),
  content: z.string(),
  relatedTaskId: nonEmpty.optional(),
  attachments: z.array(attachmentRefSchema),
  deliveryState: z.enum(['queued', 'delivered', 'read', 'failed']),
  idempotencyKey: nonEmpty,
  createdAt: isoDate,
}).strict()

export const teamLastErrorSchema = z.object({
  code: z.string().optional(),
  message: z.string(),
  failedAt: isoDate,
}).strict()

export const teamAggregateSchema = z.object({
  schemaVersion: z.literal(1),
  id: nonEmpty,
  name: nonEmpty,
  workspaceId: nonEmpty,
  workspacePath: nonEmpty,
  leaderSlotId: nonEmpty,
  state: z.enum([
    'draft',
    'starting',
    'active',
    'ownership_conflict',
    'deleting',
    'delete_blocked',
    'error',
  ]),
  directMemberChat: z.boolean(),
  members: z.record(z.string(), teamMemberSlotSchema),
  retiredSessions: z.record(z.string(), retiredMemberSessionSchema),
  tasks: z.record(z.string(), teamTaskSchema),
  leases: z.record(z.string(), fileScopeLeaseSchema),
  outbox: z.record(z.string(), teamMessageSchema),
  lastError: teamLastErrorSchema.optional(),
  revision: z.int().positive(),
  createdAt: isoDate,
  updatedAt: isoDate,
}).strict()

export const teamActivitySchema = z.object({
  schemaVersion: z.literal(1),
  id: nonEmpty,
  teamId: nonEmpty,
  kind: nonEmpty,
  entityId: nonEmpty.optional(),
  summary: z.string(),
  revision: z.int().nonnegative(),
  createdAt: isoDate,
}).strict()

export const operationSchema = z.object({
  schemaVersion: z.literal(1),
  id: nonEmpty,
  teamId: nonEmpty.optional(),
  kind: z.enum(['dissolve_team', 'remove_member', 'sync_member', 'migrate_records']),
  state: z.enum(['pending', 'running', 'blocked', 'completed', 'failed']),
  stage: nonEmpty,
  cursor: z.string().optional(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  createdAt: isoDate,
  updatedAt: isoDate,
}).strict()

export const createAssistantInputSchema = assistantTemplateSchema.pick({
  name: true,
  description: true,
  icon: true,
  instructions: true,
  provider: true,
  model: true,
  reasoningEffort: true,
  agentPresetId: true,
  permissionPresetId: true,
  skillAllowlist: true,
  mcpServers: true,
})

export const updateAssistantInputSchema = createAssistantInputSchema.partial().strict()

export const createTeamMemberInputSchema = z.object({
  assistantId: nonEmpty,
  role: z.enum(['leader', 'member']),
}).strict()

export const addTeamMemberInputSchema = createTeamMemberInputSchema.omit({ role: true }).strict()

export const createTeamDraftInputSchema = z.object({
  name: nonEmpty,
  workspaceId: nonEmpty,
  directMemberChat: z.boolean().optional(),
  members: z.array(createTeamMemberInputSchema).min(1),
}).strict()

export const cloneTeamInputSchema = z.object({
  name: nonEmpty,
  workspaceId: nonEmpty,
}).strict()
