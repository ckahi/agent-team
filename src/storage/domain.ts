import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import {
  assistantTemplateSchema,
  operationSchema,
  teamActivitySchema,
  teamAggregateSchema,
  teamMessageSchema,
} from '../domain/schemas.js'
import type {
  AssistantTemplate,
  Operation,
  TeamActivity,
  TeamAggregate,
  TeamMessage,
} from '../domain/types.js'

export type AssistantId = string
export type TeamId = string
export type MessageId = string
export type ActivityId = string
export type OperationId = string
export type OrphanMarkId = string

export const orphanMarkSchema = z.object({
  schemaVersion: z.literal(1),
  teamId: z.string().min(1),
  firstSeenAt: z.iso.datetime({ offset: true }),
  lastSeenAt: z.iso.datetime({ offset: true }),
  misses: z.int().nonnegative(),
})

export type OrphanMark = z.infer<typeof orphanMarkSchema>

/**
 * Pre-split snapshot of the shipped single-layout domain. Only the migration
 * opens it (read-only) to drain legacy `agent_team.json`; it must stay
 * field-for-field identical to the pre-split spec so schema validation
 * behaves exactly as before. Removal is deferred until every deployment has
 * migrated (see 04 遗留项).
 */
export const legacyAgentTeamSpec = defineDomain({
  name: 'agent_team',
  version: 1,
  tables: {
    assistants: domainTable<AssistantId, AssistantTemplate>(assistantTemplateSchema),
    teams: domainTable<TeamId, TeamAggregate>(teamAggregateSchema),
    messages: domainTable<MessageId, TeamMessage>(teamMessageSchema),
    activities: domainTable<ActivityId, TeamActivity>(teamActivitySchema),
    operations: domainTable<OperationId, Operation>(operationSchema),
  },
})

/**
 * Team runtime unit: one file per team aggregate / outbox cursor. Per-record
 * record keys become file names and must stay path-safe (`randomUUID()`-style
 * ids satisfy `[a-zA-Z0-9_-]+`); any future id scheme must keep that
 * guarantee. Schema-invalid record documents are moved to .bak by the host
 * (logger.error, no plugin callback); malformed-JSON documents read as absent
 * silently. Either way the team reads as absent while the document stays on
 * disk (or as .bak) for manual recovery — see the orphan grace mechanism.
 */
export const agentTeamRuntimeSpec = defineDomain({
  name: 'agent_team_runtime',
  version: 1,
  layout: 'per-record',
  // Per-record units carry a backupRecord path in the installed backend
  // (dsh-storage-json lib/index.js:479), so a schema-invalid document is
  // moved to .bak (host logger.error, no plugin callback) instead of
  // rejecting the whole open. Malformed-JSON documents still read as absent
  // silently. Declaring this on a single-layout unit throws at open
  // (dsh-storage-domain lib/index.js:373) — single units must NOT declare.
  invalidRecords: 'backup-and-skip',
  tables: {
    teams: domainTable<TeamId, TeamAggregate>(teamAggregateSchema),
    operations: domainTable<OperationId, Operation>(operationSchema),
  },
})

/** Assistant configuration unit: low-frequency, small, single file. */
export const agentTeamAssistantsSpec = defineDomain({
  name: 'agent_team_assistants',
  version: 1,
  tables: {
    assistants: domainTable<AssistantId, AssistantTemplate>(assistantTemplateSchema),
  },
})

/**
 * Stream unit: one file per message / activity plus the orphan-cleanup grace
 * marks. Schema-invalid documents are moved to .bak by the host (logger.error,
 * no plugin callback); malformed-JSON documents read as absent silently.
 */
export const agentTeamStreamsSpec = defineDomain({
  name: 'agent_team_streams',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    messages: domainTable<MessageId, TeamMessage>(teamMessageSchema),
    activities: domainTable<ActivityId, TeamActivity>(teamActivitySchema),
    orphan_marks: domainTable<OrphanMarkId, OrphanMark>(orphanMarkSchema),
  },
})
