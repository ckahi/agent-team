// AC-8 (04 Plan v3.1 / TODO-6): real-scale measurement over the REAL installed
// json backend (per-record layout, real fs under os.tmpdir()). Skipped when the
// host-installed backend module is not present on this machine.
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CompositeAgentTeamStore } from '../src/storage/store.js'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { KvUnit, KvFacet, StorageBackend } from '@deepseek-ai/dsh-storage'
import type { Operation, TeamActivity, TeamAggregate, TeamMessage } from '../src/domain/types.js'

const APP_MODULES = 'H:/Program Files/DSH Desktop/resources/app/node_modules'
const BACKEND_MODULE = join(APP_MODULES, '@deepseek-ai/dsh-storage-json/lib/index.js')
const backendAvailable = existsSync(BACKEND_MODULE)

const dshRequire = createRequire(import.meta.url)

function team(id: string): TeamAggregate {
  return {
    schemaVersion: 1,
    id,
    name: `team-${id}`,
    workspaceId: 'ws',
    workspacePath: 'C:/tmp',
    leaderSlotId: 'lead',
    state: 'active',
    directMemberChat: false,
    members: {},
    retiredSessions: {},
    tasks: {},
    leases: {},
    outbox: {},
    revision: 1,
    createdAt: '2026-10-14T00:00:00.000Z',
    updatedAt: '2026-10-14T00:00:00.000Z',
  } as TeamAggregate
}

function message(id: string, teamId: string): TeamMessage {
  return {
    schemaVersion: 1,
    id,
    teamId,
    sender: { kind: 'member', id: 'a' },
    recipient: { kind: 'leader' },
    type: 'progress',
    content: 'x'.repeat(200),
    attachments: [],
    deliveryState: 'delivered',
    idempotencyKey: `k-${id}`,
    createdAt: '2026-10-14T01:00:00.000Z',
  } as TeamMessage
}

function activity(id: string, teamId: string): TeamActivity {
  return {
    schemaVersion: 1,
    id,
    teamId,
    kind: 'team.message',
    summary: 's',
    revision: 1,
    createdAt: '2026-10-14T01:00:00.000Z',
  } as TeamActivity
}

function operation(id: string, teamId: string): Operation {
  return {
    schemaVersion: 1,
    id,
    teamId,
    kind: 'dissolve_team',
    state: 'completed',
    stage: 's',
    createdAt: '2026-10-14T01:00:00.000Z',
    updatedAt: '2026-10-14T01:00:00.000Z',
  } as Operation
}

/** Domain-like adapter over a real per-record KvUnit (memory mirror + durable unit ops). */
function unitAsDomain(name: string, tables: string[], unit: KvUnit, cache: Map<string, Map<string, unknown>>): Domain<never> {
  return {
    name,
    global: undefined as never,
    table: (tableName: string) => {
      const mirror = cache.get(tableName)
      if (mirror === undefined) throw new Error(`undeclared table ${tableName}`)
      return {
        put: async (key: string, value: unknown) => {
          await unit.putRecord(tableName, key, value)
          mirror.set(key, value)
        },
        delete: async (key: string) => {
          await unit.deleteRecord(tableName, key)
          mirror.delete(key)
        },
        get: (key: string) => mirror.get(key),
        entries: () => [...mirror.entries()],
        size: mirror.size,
      } as never
    },
    close: async () => { await unit.close() },
  } as never
}

interface World {
  root: string
  backend: StorageBackend
  store: CompositeAgentTeamStore
  caches: Record<string, Map<string, Map<string, unknown>>>
}

async function openDomains(backend: StorageBackend & { kv: KvFacet }, cachesOut: Record<string, Map<string, Map<string, unknown>>>): Promise<CompositeAgentTeamStore> {
  const openUnit = async (name: string, tables: string[]): Promise<Domain<never>> => {
    const unit = await backend.kv.open({
      name,
      version: 1,
      tables,
      hasGlobal: false,
      layout: 'per-record',
    })
    const perTable = new Map<string, Map<string, unknown>>()
    for (const t of tables) perTable.set(t, new Map())
    const snapshot = await unit.loadAll()
    for (const [t, records] of Object.entries(snapshot.tables)) {
      const mirror = perTable.get(t)
      if (mirror !== undefined) for (const [k, v] of Object.entries(records)) mirror.set(k, v)
    }
    cachesOut[name] = perTable
    return unitAsDomain(name, tables, unit, perTable)
  }
  const runtime = await openUnit('agent_team_runtime', ['teams', 'operations'])
  const assistants = await openUnit('agent_team_assistants', ['assistants'])
  const streams = await openUnit('agent_team_streams', ['messages', 'activities', 'orphan_marks'])
  return new CompositeAgentTeamStore(runtime, assistants, streams)
}

const worlds: World[] = []
afterEach(async () => {
  for (const w of worlds.splice(0)) {
    await w.backend.close().catch(() => {})
    await rm(w.root, { recursive: true, force: true }).catch(() => {})
  }
})

describe.skipIf(!backendAvailable)('AC-8 真实规模实测（安装版 json 后端 + 真实 fs）', () => {
  it('20 团队 × 每 30 消息/活动 + 写入与启动读回耗时对照', async () => {
    const { JsonStorageBackend } = dshRequire(BACKEND_MODULE) as { JsonStorageBackend: new (root: string) => StorageBackend & { kv: KvFacet } }
    const root = await mkdtemp(join(tmpdir(), 'agent-team-ac8-'))
    const backend = new JsonStorageBackend(root)
    const caches: Record<string, Map<string, Map<string, unknown>>> = {}
    const store = await openDomains(backend, caches)
    worlds.push({ root, backend, store, caches })
    const TEAM_COUNT = 20
    const PER_TEAM = 30

    const writeStart = performance.now()
    for (let t = 0; t < TEAM_COUNT; t += 1) {
      const teamId = `t${t}`
      await store.putTeam(team(teamId))
      for (let i = 0; i < PER_TEAM; i += 1) {
        await store.putMessage(message(`m-${t}-${i}`, teamId))
        await store.putActivity(activity(`a-${t}-${i}`, teamId))
      }
      await store.putOperation(operation(`op-${t}`, teamId))
    }
    const writeMs = performance.now() - writeStart
    const writeCount = TEAM_COUNT * (1 + PER_TEAM * 2 + 1)
    const avgWriteMs = writeMs / writeCount

    // restart path: close everything, reopen on the SAME root, measure activation read
    await backend.close()
    const reopenedBackend = new JsonStorageBackend(root)
    const reopenedCaches: Record<string, Map<string, Map<string, unknown>>> = {}
    const readStart = performance.now()
    const reopened = await openDomains(reopenedBackend, reopenedCaches)
    const readMs = performance.now() - readStart
    worlds.push({ root, backend: reopenedBackend, store: reopened, caches: reopenedCaches })
    expect(reopened.listTeams()).toHaveLength(TEAM_COUNT)
    expect(reopened.listMessages('t0')).toHaveLength(PER_TEAM)
    expect(reopened.listActivities('t7')).toHaveLength(PER_TEAM)

    // single-team write latency stays flat regardless of accumulated volume (per-record core claim)
    const lateWriteStart = performance.now()
    await reopened.putMessage(message('m-late', 't0'))
    const lateWriteMs = performance.now() - lateWriteStart

    // eslint-disable-next-line no-console
    console.log(`[AC-8] writes=${writeCount} total=${writeMs.toFixed(0)}ms avg=${avgWriteMs.toFixed(1)}ms | reopen-read=${readMs.toFixed(0)}ms | late-single-write=${lateWriteMs.toFixed(1)}ms`)

    // loose guards — regression detectors, not strict SLOs
    expect(avgWriteMs).toBeLessThan(100)
    expect(readMs).toBeLessThan(10_000)
    expect(lateWriteMs).toBeLessThan(1_000)
  }, 120_000)
})
