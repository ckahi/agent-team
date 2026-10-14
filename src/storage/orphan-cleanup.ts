import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { OrphanMark } from './domain.js'
import type { StoreWriteLogger } from './store.js'

export type OrphanCleanupMode = 'delete' | 'log'

export interface OrphanCleanupLogger extends StoreWriteLogger {
  info?(message: string): void
}

export interface CleanupOrphansDeps {
  store: {
    deleteMessage(id: string): Promise<boolean>
    deleteActivity(id: string): Promise<boolean>
    deleteOperation(id: string): Promise<boolean>
  }
  /** Runtime domain: teams table (existence oracle) + operations table. */
  runtime: Domain<never>
  /** Streams domain: messages/activities/orphan_marks tables. */
  streams: Domain<never>
  mode: OrphanCleanupMode
  logger?: OrphanCleanupLogger
  now?: () => Date
}

export interface OrphanCleanupResult {
  /** Orphan teams marked for the first time this run (grace period started). */
  marked: number
  /** Grace marks cleared because the team is present again. */
  cleared: number
  /** Orphan records actually deleted this run (grace period expired, delete mode). */
  deleted: number
  counts: { messages: number, activities: number, operations: number }
}

const ORPHAN_DELETE_THRESHOLD = 2

/**
 * Startup compensation for cross-unit dissolve cleanup (01 §7, Q2): an orphan
 * is a stream record whose team is absent from the teams table — which also
 * covers a team document being invalid (schema-invalid → host moves it to
 * .bak; malformed JSON → silent absent) so the team reads as absent with no
 * plugin-side signal. Deletion only happens after the team has
 * been missing on `ORPHAN_DELETE_THRESHOLD` consecutive startups (grace-mark
 * mechanism), so a single transient state or one bad document can never wipe
 * a recoverable team's streams. Marks themselves live in the streams domain's
 * `orphan_marks` table and are never touched by the orphan scan.
 */
export async function cleanupOrphans(deps: CleanupOrphansDeps): Promise<OrphanCleanupResult> {
  const now = (deps.now ?? (() => new Date()))().toISOString()
  const teamsTable = deps.runtime.table('teams' as never) as KvTable<string, { teamId?: string }>
  const operationsTable = deps.runtime.table('operations' as never) as KvTable<string, { teamId?: string }>
  const messagesTable = deps.streams.table('messages' as never) as KvTable<string, { teamId: string }>
  const activitiesTable = deps.streams.table('activities' as never) as KvTable<string, { teamId: string }>
  const marksTable = deps.streams.table('orphan_marks' as never) as KvTable<string, OrphanMark>
  const teamIds = new Set<string>()
  for (const [id] of teamsTable.entries()) teamIds.add(id)

  const marks = new Map<string, OrphanMark>()
  for (const [id, mark] of marksTable.entries()) marks.set(id, mark)

  const orphans = new Map<string, { messages: string[], activities: string[], operations: string[] }>()
  const orphanList = (teamId: string) => {
    let entry = orphans.get(teamId)
    if (entry === undefined) {
      entry = { messages: [], activities: [], operations: [] }
      orphans.set(teamId, entry)
    }
    return entry
  }

  for (const [id, record] of messagesTable.entries()) {
    if (!teamIds.has(record.teamId)) orphanList(record.teamId).messages.push(id)
  }
  for (const [id, record] of activitiesTable.entries()) {
    if (!teamIds.has(record.teamId)) orphanList(record.teamId).activities.push(id)
  }
  for (const [id, record] of operationsTable.entries()) {
    if (record.teamId !== undefined && !teamIds.has(record.teamId)) orphanList(record.teamId).operations.push(id)
  }

  let marked = 0
  let cleared = 0
  let deleted = 0
  const deletedCounts = { messages: 0, activities: 0, operations: 0 }

  for (const [teamId, found] of orphans) {
    const mark = marks.get(teamId)
    if (mark === undefined) {
      await marksTable.put(teamId, {
        schemaVersion: 1,
        teamId,
        firstSeenAt: now,
        lastSeenAt: now,
        misses: 1,
      })
      marks.set(teamId, { schemaVersion: 1, teamId, firstSeenAt: now, lastSeenAt: now, misses: 1 })
      marked += 1
      deps.logger?.warn?.(
        `agent-team: orphan streams detected for missing team '${teamId}' (messages=${found.messages.length} activities=${found.activities.length} operations=${found.operations.length}); grace period started (delete after ${ORPHAN_DELETE_THRESHOLD} consecutive startups, mode=${deps.mode})`,
      )
      continue
    }
    const misses = mark.misses + 1
    await marksTable.put(teamId, { ...mark, lastSeenAt: now, misses })
    marks.set(teamId, { ...mark, lastSeenAt: now, misses })
    if (misses >= ORPHAN_DELETE_THRESHOLD && deps.mode === 'delete') {
      let deleteFailed = false
      try {
        for (const id of found.messages) await deps.store.deleteMessage(id)
        for (const id of found.activities) await deps.store.deleteActivity(id)
        for (const id of found.operations) await deps.store.deleteOperation(id)
      } catch (error) {
        // QA patch: keep the grace mark when any delete fails — the remaining
        // orphans are re-scanned next startup with the accumulated misses, so
        // a partial failure never resets the grace period nor loses records.
        deleteFailed = true
        deps.logger?.warn?.(
          `agent-team: orphan streams deletion failed for team '${teamId}' (will retry next startup, misses=${misses})`,
          error,
        )
      }
      if (!deleteFailed) {
        await marksTable.delete(teamId)
        marks.delete(teamId)
        deleted += found.messages.length + found.activities.length + found.operations.length
        deletedCounts.messages += found.messages.length
        deletedCounts.activities += found.activities.length
        deletedCounts.operations += found.operations.length
        deps.logger?.warn?.(
          `agent-team: orphan streams deleted for team '${teamId}' after ${misses} consecutive missing startups (messages=${found.messages.length} activities=${found.activities.length} operations=${found.operations.length})`,
        )
      }
    }
  }

  for (const [teamId, mark] of [...marks]) {
    if (!teamIds.has(teamId)) continue
    await marksTable.delete(teamId)
    marks.delete(teamId)
    cleared += 1
    deps.logger?.info?.(`agent-team: orphan grace mark cleared for recovered team '${teamId}' (had ${mark.misses} miss(es))`)
  }

  return {
    marked,
    cleared,
    deleted,
    counts: deletedCounts,
  }
}

/** Warn (once per startup) when the streams unit grows past the readability threshold. */
export function warnIfStreamsLarge(
  streams: Domain<never>,
  threshold: number,
  logger?: OrphanCleanupLogger,
): void {
  const messages = streams.table('messages' as never) as KvTable<string, unknown>
  const activities = streams.table('activities' as never) as KvTable<string, unknown>
  const size = messages.size + activities.size
  if (size > threshold) {
    logger?.warn?.(
      `agent-team: streams unit holds ${size} records (threshold ${threshold}); activation read time grows with file count — consider the activities retention ruling (01 Q1)`,
    )
  }
}
