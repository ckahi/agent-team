import { stat, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import {
  agentTeamAssistantsSpec,
  agentTeamRuntimeSpec,
  agentTeamStreamsSpec,
  legacyAgentTeamSpec,
} from './domain.js'
import type { StoreWriteLogger } from './store.js'
import { safeRecordKey } from './store.js'
import { withWriteRetry, type WriteRetryOptions } from './write-retry.js'
import type {
  AssistantTemplate,
  Operation,
  TeamActivity,
  TeamAggregate,
  TeamMessage,
} from '../domain/types.js'

/** Read-back of one legacy table: `[record key, legacy record][]` (values opaque JSON). */
type LegacyEntries = Array<[string, unknown]>

function readTable(domain: Domain<never>, name: string): LegacyEntries {
  return [...(domain.table(name as never).entries() as unknown as LegacyEntries)]
}

export interface MigrationCounts {
  assistants: number
  teams: number
  messages: number
  activities: number
  operations: number
}

export interface MigrationResult {
  migrated: boolean
  counts?: MigrationCounts
  durationMs?: number
  backupPath?: string
  /** A-2: reconciliation passed but the .bak rename is still pending (retried next startup). */
  backupPending?: boolean
}

export interface MigrationDeps {
  /** Directory holding the legacy `agent_team.json` (the json backend root). */
  storageRoot: string
  /** Already-open new domains receiving the migrated records. */
  runtime: Domain<typeof agentTeamRuntimeSpec>
  assistants: Domain<typeof agentTeamAssistantsSpec>
  streams: Domain<typeof agentTeamStreamsSpec>
  /** Opens the legacy single-layout domain read-only. */
  openLegacy: () => Promise<Domain<typeof legacyAgentTeamSpec>>
  fileExists?: (path: string) => Promise<boolean>
  renameFile?: (from: string, to: string) => Promise<void>
  now?: () => Date
  logger?: StoreWriteLogger
  /** Retry overrides (tests shorten the backoff). */
  retry?: Pick<WriteRetryOptions, 'maxRetries' | 'delay'>
}

export const LEGACY_UNIT_FILE = 'agent_team.json'

type ReconciledTable = 'assistants' | 'teams' | 'messages' | 'activities' | 'operations'

/**
 * Mirrors the official DSH home priority (explicit config > $DSH_HOME >
 * ~/.dsh) without depending on the host-internal dsh-home-paths package,
 * which is not resolvable from the plugin build. The json backend root is
 * `<dsh home>/storages` (verified against the installed host layout).
 */
export function resolveStoragesRoot(): string {
  const override = process.env.DSH_HOME
  const home = override !== undefined && override.trim().length > 0
    ? override.trim()
    : join(homedir(), '.dsh')
  return join(home, 'storages')
}

function backupStamp(at: Date): string {
  return at.toISOString().replaceAll(':', '-')
}

/**
 * One-shot, re-entrant migration of the legacy single-unit `agent_team.json`
 * into the three split domains. Ordering guarantees crash safety: the legacy
 * file is never modified and the rename-to-backup is the last step, so any
 * interrupted run simply re-runs to convergence (puts are idempotent).
 *
 * Failure semantics (fail-closed, leader ruling 2026-10-14): any error —
 * including a corrupt legacy file — aborts plugin activation with the legacy
 * file untouched; the error message carries the absolute legacy path and a
 * manual recovery hint. Corrupt files are never auto-skipped.
 */
export async function migrateLegacyAgentTeamStore(deps: MigrationDeps): Promise<MigrationResult> {
  const legacyPath = join(deps.storageRoot, LEGACY_UNIT_FILE)
  try {
    const exists = deps.fileExists ?? (async path => {
      try {
        await stat(path)
        return true
      } catch (error) {
        // B-1 (06 QA B-1): only ENOENT means "no legacy file, nothing to
        // migrate". Any other stat failure (permissions/IO) must fail closed —
        // silently treating it as "absent" could skip a pending migration.
        if ((error as { code?: string }).code === 'ENOENT') return false
        throw error
      }
    })
    if (!await exists(legacyPath)) return { migrated: false }

    return await runMigration(deps, legacyPath)
  } catch (error) {
    throw wrapMigrationError(error, legacyPath)
  }
}

async function runMigration(deps: MigrationDeps, legacyPath: string): Promise<MigrationResult> {
  const startedAt = Date.now()
  const legacy = await deps.openLegacy()
  let counts: MigrationCounts
  let snapshot: Record<ReconciledTable, LegacyEntries>
  try {
    snapshot = {
      assistants: readTable(legacy, 'assistants'),
      teams: readTable(legacy, 'teams'),
      messages: readTable(legacy, 'messages'),
      activities: readTable(legacy, 'activities'),
      operations: readTable(legacy, 'operations'),
    }
    counts = {
      assistants: snapshot.assistants.length,
      teams: snapshot.teams.length,
      messages: snapshot.messages.length,
      activities: snapshot.activities.length,
      operations: snapshot.operations.length,
    }
    // Per-record units use the record key as the file name, which the host
    // restricts to /^[a-zA-Z0-9_-]+$/ — real-world message ids carry a
    // `agent-team:<uuid>` prefix (src/runtime/team-messages.ts), so keys are
    // sanitized with the exact same function the Composite store applies on
    // every subsequent read/update/delete (store.ts safeRecordKey).
    // assistants stays on the single layout (keys live inside one JSON
    // document), so its keys are preserved verbatim.
    for (const [key, value] of snapshot.assistants) {
      await deps.assistants.table('assistants').put(key, value as AssistantTemplate)
    }
    for (const [key, value] of snapshot.teams) {
      await deps.runtime.table('teams').put(safeRecordKey(key), value as TeamAggregate)
    }
    for (const [key, value] of snapshot.messages) {
      await deps.streams.table('messages').put(safeRecordKey(key), value as TeamMessage)
    }
    for (const [key, value] of snapshot.activities) {
      await deps.streams.table('activities').put(safeRecordKey(key), value as TeamActivity)
    }
    for (const [key, value] of snapshot.operations) {
      await deps.runtime.table('operations').put(safeRecordKey(key), value as Operation)
    }
  } finally {
    // patch-3: the legacy domain is always closed here, whether the drain
    // succeeded or failed, so the unit name is released for later retries.
    await legacy.close()
  }

  // A-1 (06 QA A-1, AC-2): per-table read-back reconciliation. The drain is
  // only considered successful when every migrated table's stored key set and
  // record contents match the legacy snapshot exactly.
  const targets: Array<{ domain: Domain<never>, table: string, records: LegacyEntries, encode: boolean }> = [
    { domain: deps.assistants, table: 'assistants', records: snapshot.assistants, encode: false },
    { domain: deps.runtime, table: 'teams', records: snapshot.teams, encode: true },
    { domain: deps.streams, table: 'messages', records: snapshot.messages, encode: true },
    { domain: deps.streams, table: 'activities', records: snapshot.activities, encode: true },
    { domain: deps.runtime, table: 'operations', records: snapshot.operations, encode: true },
  ]
  for (const { domain, table, records, encode } of targets) {
    const stored = new Map(readTable(domain, table))
    if (stored.size !== records.length) {
      throw new Error(`迁移对账失败：表 '${table}' 回读 ${stored.size} 条，应为 ${records.length} 条`)
    }
    for (const [key, value] of records) {
      const storedKey = encode ? safeRecordKey(key) : key
      const actual = stored.get(storedKey)
      if (actual === undefined || JSON.stringify(actual) !== JSON.stringify(value)) {
        throw new Error(`迁移对账失败：表 '${table}' 键 '${key}' 回读内容与旧存储不一致`)
      }
    }
  }
  // Reconciliation passed: the migration itself is complete and idempotent to
  // re-run. A-2 (06 QA A-2 / 01 v4 §4): renaming the legacy file to .bak is
  // only final cleanup — a rename failure (e.g. EPERM exhausted) does NOT fail
  // activation; the next startup re-runs this migration, reconciliation passes
  // immediately (already drained), and the rename is retried.
  const backupPath = join(deps.storageRoot, `${LEGACY_UNIT_FILE}.bak-${backupStamp((deps.now ?? (() => new Date()))())}`)
  const performRename = deps.renameFile ?? rename
  const retryOptions: WriteRetryOptions = {
    onRetry: ({ attempt, error, elapsedMs }) => {
      deps.logger?.warn(
        `agent-team: legacy storage rename retry (attempt ${attempt} elapsed ${elapsedMs}ms file '${legacyPath}')`,
        error,
      )
    },
  }
  if (deps.retry?.maxRetries !== undefined) retryOptions.maxRetries = deps.retry.maxRetries
  if (deps.retry?.delay !== undefined) retryOptions.delay = deps.retry.delay
  try {
    await withWriteRetry(() => performRename(legacyPath, backupPath), retryOptions)
  } catch (error) {
    deps.logger?.warn(
      `agent-team: legacy storage rename failed after retries (file '${legacyPath}'); migration data is reconciled and activation continues — the rename will be retried on next startup`,
      error,
    )
    return {
      migrated: true,
      counts,
      durationMs: Date.now() - startedAt,
      backupPending: true,
    }
  }

  return {
    migrated: true,
    counts,
    durationMs: Date.now() - startedAt,
    backupPath,
  }
}

/**
 * Fail-closed error wrapper for the plugin activation path: turns any
 * migration failure into a message that names the legacy file and the manual
 * recovery step (rename it away to skip migration).
 */
export function wrapMigrationError(error: unknown, legacyPath: string): Error {
  const message = [
    `agent-team 存储迁移失败：无法读取或迁移既有存储文件 ${legacyPath}`,
    '已保留该文件原样。可修复占用/损坏后重启自动重试；或将该文件改名移走以跳过迁移（旧数据保留在改名后的文件中）。',
  ].join(' ')
  if (error instanceof Error) {
    return new Error(`${message} 原因：${error.message}`, { cause: error })
  }
  return new Error(`${message} 原因：${String(error)}`, { cause: error instanceof Error ? error : undefined })
}
