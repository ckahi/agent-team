import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {
  AssistantTemplate,
  Operation,
  TeamActivity,
  TeamAggregate,
  TeamMessage,
} from '../domain/types.js'
import {
  agentTeamAssistantsSpec,
  agentTeamRuntimeSpec,
  agentTeamStreamsSpec,
  legacyAgentTeamSpec,
} from './domain.js'
import { withWriteRetry } from './write-retry.js'

export interface AgentTeamStore {
  getAssistant(id: string): AssistantTemplate | undefined
  listAssistants(): AssistantTemplate[]
  putAssistant(value: AssistantTemplate): Promise<void>
  updateAssistant(id: string, update: (current: AssistantTemplate) => AssistantTemplate): Promise<AssistantTemplate>
  deleteAssistant(id: string): Promise<boolean>

  getTeam(id: string): TeamAggregate | undefined
  listTeams(): TeamAggregate[]
  putTeam(value: TeamAggregate): Promise<void>
  updateTeam(id: string, update: (current: TeamAggregate) => TeamAggregate): Promise<TeamAggregate>
  deleteTeam(id: string): Promise<boolean>

  listMessages(teamId: string): TeamMessage[]
  putMessage(value: TeamMessage): Promise<void>
  deleteMessage(id: string): Promise<boolean>

  listActivities(teamId: string): TeamActivity[]
  putActivity(value: TeamActivity): Promise<void>
  deleteActivity(id: string): Promise<boolean>

  getOperation(id: string): Operation | undefined
  listOperations(): Operation[]
  putOperation(value: Operation): Promise<void>
  updateOperation(id: string, update: (current: Operation) => Operation): Promise<Operation>
  deleteOperation(id: string): Promise<boolean>
}

export interface StoreWriteLogger {
  warn(message: string, error?: unknown): void
}

/**
 * Per-record units use the record key as the file name, which the host
 * restricts to /^[a-zA-Z0-9_-]+$/ (dsh-storage-json assertSafeKey). Real-world
 * ids may carry a prefixed form such as `agent-team:<uuid>` (see
 * src/runtime/team-messages.ts), so every per-record key access must go
 * through this deterministic sanitizer. Idempotent: already-safe keys are
 * returned unchanged, and the only character ever replaced is `:` → `_`,
 * which cannot collide with any id shape currently produced.
 */
export function safeRecordKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/**
 * Pre-split store over the legacy single-layout domain. Only the migration
 * opens it (read-only drain of `agent_team.json`); it must not be used for
 * regular writes after the split.
 */
export class DomainAgentTeamStore implements AgentTeamStore {
  private readonly assistants: KvTable<string, AssistantTemplate>
  private readonly teams: KvTable<string, TeamAggregate>
  private readonly messages: KvTable<string, TeamMessage>
  private readonly activities: KvTable<string, TeamActivity>
  private readonly operations: KvTable<string, Operation>

  constructor(readonly domain: Domain<typeof legacyAgentTeamSpec>) {
    this.assistants = domain.table('assistants')
    this.teams = domain.table('teams')
    this.messages = domain.table('messages')
    this.activities = domain.table('activities')
    this.operations = domain.table('operations')
  }

  getAssistant(id: string): AssistantTemplate | undefined {
    return this.assistants.get(id)
  }

  listAssistants(): AssistantTemplate[] {
    return values(this.assistants)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  }

  putAssistant(value: AssistantTemplate): Promise<void> {
    return this.assistants.put(value.id, value)
  }

  updateAssistant(
    id: string,
    update: (current: AssistantTemplate) => AssistantTemplate,
  ): Promise<AssistantTemplate> {
    return this.assistants.update(id, update)
  }

  deleteAssistant(id: string): Promise<boolean> {
    return this.assistants.delete(id)
  }

  getTeam(id: string): TeamAggregate | undefined {
    return this.teams.get(id)
  }

  listTeams(): TeamAggregate[] {
    return values(this.teams)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
  }

  putTeam(value: TeamAggregate): Promise<void> {
    return this.teams.put(value.id, value)
  }

  updateTeam(id: string, update: (current: TeamAggregate) => TeamAggregate): Promise<TeamAggregate> {
    return this.teams.update(id, update)
  }

  deleteTeam(id: string): Promise<boolean> {
    return this.teams.delete(id)
  }

  listMessages(teamId: string): TeamMessage[] {
    return values(this.messages)
      .filter(message => message.teamId === teamId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  }

  putMessage(value: TeamMessage): Promise<void> {
    return this.messages.put(value.id, value)
  }

  deleteMessage(id: string): Promise<boolean> {
    return this.messages.delete(id)
  }

  listActivities(teamId: string): TeamActivity[] {
    return values(this.activities)
      .filter(activity => activity.teamId === teamId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  }

  putActivity(value: TeamActivity): Promise<void> {
    return this.activities.put(value.id, value)
  }

  deleteActivity(id: string): Promise<boolean> {
    return this.activities.delete(id)
  }

  getOperation(id: string): Operation | undefined {
    return this.operations.get(id)
  }

  listOperations(): Operation[] {
    return values(this.operations)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  }

  putOperation(value: Operation): Promise<void> {
    return this.operations.put(value.id, value)
  }

  updateOperation(id: string, update: (current: Operation) => Operation): Promise<Operation> {
    return this.operations.update(id, update)
  }

  deleteOperation(id: string): Promise<boolean> {
    return this.operations.delete(id)
  }
}

/**
 * Split-layout store implementing the unchanged `AgentTeamStore` contract over
 * three domains: team runtime (per-record teams/operations), assistant
 * configuration (single), and streams (per-record messages/activities/orphan
 * marks). All writes go through the EPERM rename retry wrapper; record keys
 * are UUIDs and must stay path-safe for the per-record layout.
 */
export class CompositeAgentTeamStore implements AgentTeamStore {
  protected readonly teamsTable: KvTable<string, TeamAggregate>
  protected readonly operationsTable: KvTable<string, Operation>
  protected readonly assistantsTable: KvTable<string, AssistantTemplate>
  protected readonly messagesTable: KvTable<string, TeamMessage>
  protected readonly activitiesTable: KvTable<string, TeamActivity>

  constructor(
    runtime: Domain<typeof agentTeamRuntimeSpec>,
    assistantsDomain: Domain<typeof agentTeamAssistantsSpec>,
    streams: Domain<typeof agentTeamStreamsSpec>,
    private readonly writeLogger?: StoreWriteLogger,
  ) {
    this.teamsTable = runtime.table('teams')
    this.operationsTable = runtime.table('operations')
    this.assistantsTable = assistantsDomain.table('assistants')
    this.messagesTable = streams.table('messages')
    this.activitiesTable = streams.table('activities')
  }

  private retry<T>(table: string, key: string, operation: () => Promise<T>): Promise<T> {
    return withWriteRetry(operation, {
      onRetry: ({ attempt, error, elapsedMs }) => {
        this.writeLogger?.warn(
          `agent-team: storage write retry (table '${table}' key '${key}' attempt ${attempt} elapsed ${elapsedMs}ms)`,
          error,
        )
      },
    })
  }

  getAssistant(id: string): AssistantTemplate | undefined {
    return this.assistantsTable.get(id)
  }

  listAssistants(): AssistantTemplate[] {
    return values(this.assistantsTable)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  }

  putAssistant(value: AssistantTemplate): Promise<void> {
    return this.retry('assistants', value.id, () => this.assistantsTable.put(value.id, value))
  }

  updateAssistant(
    id: string,
    update: (current: AssistantTemplate) => AssistantTemplate,
  ): Promise<AssistantTemplate> {
    return this.retry('assistants', id, () => this.assistantsTable.update(id, update))
  }

  deleteAssistant(id: string): Promise<boolean> {
    return this.retry('assistants', id, () => this.assistantsTable.delete(id))
  }

  getTeam(id: string): TeamAggregate | undefined {
    return this.teamsTable.get(safeRecordKey(id))
  }

  listTeams(): TeamAggregate[] {
    return values(this.teamsTable)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
  }

  putTeam(value: TeamAggregate): Promise<void> {
    return this.retry('teams', value.id, () => this.teamsTable.put(safeRecordKey(value.id), value))
  }

  updateTeam(id: string, update: (current: TeamAggregate) => TeamAggregate): Promise<TeamAggregate> {
    return this.retry('teams', id, () => this.teamsTable.update(safeRecordKey(id), update))
  }

  deleteTeam(id: string): Promise<boolean> {
    return this.retry('teams', id, () => this.teamsTable.delete(safeRecordKey(id)))
  }

  listMessages(teamId: string): TeamMessage[] {
    return values(this.messagesTable)
      .filter(message => message.teamId === teamId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  }

  putMessage(value: TeamMessage): Promise<void> {
    return this.retry('messages', value.id, () => this.messagesTable.put(safeRecordKey(value.id), value))
  }

  deleteMessage(id: string): Promise<boolean> {
    return this.retry('messages', id, () => this.messagesTable.delete(safeRecordKey(id)))
  }

  listActivities(teamId: string): TeamActivity[] {
    return values(this.activitiesTable)
      .filter(activity => activity.teamId === teamId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  }

  putActivity(value: TeamActivity): Promise<void> {
    return this.retry('activities', value.id, () => this.activitiesTable.put(safeRecordKey(value.id), value))
  }

  deleteActivity(id: string): Promise<boolean> {
    return this.retry('activities', id, () => this.activitiesTable.delete(safeRecordKey(id)))
  }

  getOperation(id: string): Operation | undefined {
    return this.operationsTable.get(safeRecordKey(id))
  }

  listOperations(): Operation[] {
    return values(this.operationsTable)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  }

  putOperation(value: Operation): Promise<void> {
    return this.retry('operations', value.id, () => this.operationsTable.put(safeRecordKey(value.id), value))
  }

  updateOperation(id: string, update: (current: Operation) => Operation): Promise<Operation> {
    return this.retry('operations', id, () => this.operationsTable.update(safeRecordKey(id), update))
  }

  deleteOperation(id: string): Promise<boolean> {
    return this.retry('operations', id, () => this.operationsTable.delete(safeRecordKey(id)))
  }
}

function values<K extends string, V>(table: KvTable<K, V>): V[] {
  return [...table.entries()].map(([, value]) => value)
}
