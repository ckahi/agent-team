import { describe, expect, it, vi } from 'vitest'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { cleanupOrphans } from '../src/storage/orphan-cleanup.js'
import type { CompositeAgentTeamStore } from '../src/storage/store.js'
import type { Operation, TeamActivity, TeamAggregate, TeamMessage } from '../src/domain/types.js'

function fakeTable(map: Map<string, unknown>): never {
  const protoEntries = Map.prototype.entries
  return {
    put: async (key: string, value: unknown) => { map.set(key, value) },
    delete: async (key: string) => map.delete(key),
    entries: () => [...protoEntries.call(map)],
    size: map.size,
  } as never
}

function fakeDomain(tables: Record<string, Map<string, unknown>>): Domain<never> {
  return {
    name: 'fake',
    global: undefined as never,
    table: (name: string) => fakeTable(tables[name] ?? new Map()),
    close: async () => {},
  } as never
}

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
    type: 'instruction',
    content: 'b',
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

function operation(id: string, teamId: string | undefined): Operation {
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

interface OrphanMarkRecord {
  schemaVersion: 1
  teamId: string
  firstSeenAt: string
  lastSeenAt: string
  misses: number
}

interface World {
  teams: Map<string, TeamAggregate>
  messages: Map<string, TeamMessage>
  activities: Map<string, TeamActivity>
  operations: Map<string, Operation>
  marks: Map<string, OrphanMarkRecord>
  store: CompositeAgentTeamStore
  streams: Domain<never>
  runtime: Domain<never>
}

function makeWorld(teamIds: string[]): World {
  const teams = new Map<string, TeamAggregate>(teamIds.map(id => [id, team(id)]))
  const messages = new Map<string, TeamMessage>()
  const activities = new Map<string, TeamActivity>()
  const operations = new Map<string, Operation>()
  const marks = new Map<string, OrphanMarkRecord>()
  const store = {
    deleteMessage: async (id: string) => messages.delete(id),
    deleteActivity: async (id: string) => activities.delete(id),
    deleteOperation: async (id: string) => operations.delete(id),
  } as unknown as CompositeAgentTeamStore
  const streams = fakeDomain({ messages, activities, orphan_marks: marks })
  const runtime = fakeDomain({ teams, operations })
  return { teams, messages, activities, operations, marks, store, streams, runtime }
}

function run(w: World, mode: 'delete' | 'log' = 'delete'): ReturnType<typeof cleanupOrphans> {
  return cleanupOrphans({ store: w.store, runtime: w.runtime, streams: w.streams, mode, logger })
}

const logger = { warn: vi.fn(), info: vi.fn() }

describe('cleanupOrphans', () => {
  it('正常-首次发现孤儿：建标记且不删除（宽限期内不删）', async () => {
    const w = makeWorld(['t-live'])
    w.messages.set('m1', message('m1', 't-dead'))
    w.activities.set('a1', activity('a1', 't-dead'))
    const result = await run(w)
    expect(result.deleted).toBe(0)
    expect(w.messages.size).toBe(1)
    expect(w.marks.get('t-dead')?.misses).toBe(1)
    expect(result.marked).toBe(1)
  })

  it('正常-连续第 2 次启动团队仍缺失：删除孤儿并清标记', async () => {
    const w = makeWorld(['t-live'])
    w.messages.set('m1', message('m1', 't-dead'))
    w.activities.set('a1', activity('a1', 't-dead'))
    w.operations.set('op1', operation('op1', 't-dead'))
    w.marks.set('t-dead', { schemaVersion: 1, teamId: 't-dead', firstSeenAt: '2026-10-13T00:00:00.000Z', lastSeenAt: '2026-10-13T00:00:00.000Z', misses: 1 })
    const result = await run(w)
    expect(result.deleted).toBe(3)
    expect(w.messages.size).toBe(0)
    expect(w.activities.size).toBe(0)
    expect(w.operations.size).toBe(0)
    expect(w.marks.has('t-dead')).toBe(false)
  })

  it('正常-第 2 次启动前团队恢复：标记清除，数据零损失', async () => {
    const w = makeWorld([])
    w.messages.set('m1', message('m1', 't-back'))
    w.marks.set('t-back', { schemaVersion: 1, teamId: 't-back', firstSeenAt: '2026-10-13T00:00:00.000Z', lastSeenAt: '2026-10-13T00:00:00.000Z', misses: 1 })
    w.teams.set('t-back', team('t-back'))
    const result = await run(w)
    expect(result.deleted).toBe(0)
    expect(result.cleared).toBe(1)
    expect(w.messages.size).toBe(1)
    expect(w.marks.has('t-back')).toBe(false)
  })

  it('正常-teamId 缺省的 operation 永不删除', async () => {
    const w = makeWorld(['t-live'])
    w.operations.set('op-global', operation('op-global', undefined))
    await run(w)
    expect(w.operations.has('op-global')).toBe(true)
  })

  it('状态转换-teams 存在的记录任何情况不动；mode=log 只告警不删', async () => {
    const w = makeWorld(['t-live'])
    w.messages.set('m-live', message('m-live', 't-live'))
    w.messages.set('m-dead', message('m-dead', 't-dead'))
    w.messages.set('m-dead2', message('m-dead2', 't-dead'))
    const result = await run(w, 'log')
    expect(result.deleted).toBe(0)
    expect(w.messages.has('m-live')).toBe(true)
    expect(w.messages.has('m-dead')).toBe(true)
    expect(w.marks.get('t-dead')?.misses).toBe(1)
  })

  it('异常模拟-单团队坏文档场景（absent）：宽限期内不删，连续 2 次才兜底', async () => {
    const w = makeWorld(['t-live'])
    w.messages.set('m1', message('m1', 't-corrupt'))
    await run(w)
    expect(w.messages.size).toBe(1)
    await run(w)
    expect(w.messages.size).toBe(0)
  })

  it('幂等-连续两次执行第二次计数为 0（无新增孤儿）', async () => {
    const w = makeWorld(['t-live'])
    w.messages.set('m1', message('m1', 't-live'))
    const first = await run(w)
    const second = await run(w)
    expect(first.marked).toBe(0)
    expect(second.marked).toBe(0)
    expect(second.deleted).toBe(0)
    expect(w.messages.size).toBe(1)
  })

  it('patch-删除中途失败：标记保留（misses 已累加），剩余孤儿下轮重扫，不提前失效', async () => {
    const w = makeWorld(['t-live'])
    w.messages.set('m1', message('m1', 't-dead'))
    w.messages.set('m2', message('m2', 't-dead'))
    w.activities.set('a1', activity('a1', 't-dead'))
    w.marks.set('t-dead', { schemaVersion: 1, teamId: 't-dead', firstSeenAt: '2026-10-13T00:00:00.000Z', lastSeenAt: '2026-10-13T00:00:00.000Z', misses: 1 })
    const store = {
      deleteMessage: async (id: string) => {
        if (id === 'm1') throw Object.assign(new Error('locked'), { code: 'EPERM' })
        return w.messages.delete(id)
      },
      deleteActivity: async (id: string) => w.activities.delete(id),
      deleteOperation: async (id: string) => w.operations.delete(id),
    } as unknown as CompositeAgentTeamStore
    const result = await cleanupOrphans({ store, runtime: w.runtime, streams: w.streams, mode: 'delete', logger })
    expect(result.deleted).toBe(0)
    expect(w.marks.get('t-dead')?.misses).toBe(2)
    expect(w.messages.has('m1')).toBe(true)
    expect(w.messages.has('m2')).toBe(true)
    expect(w.activities.has('a1')).toBe(true)
    // next startup: mark alive → threshold already reached → remaining 3 delete and mark clears
    const second = await cleanupOrphans({ store: w.store, runtime: w.runtime, streams: w.streams, mode: 'delete', logger })
    expect(second.deleted).toBe(3)
    expect(w.marks.has('t-dead')).toBe(false)
    expect(w.messages.size).toBe(0)
  })

  it('边界-空表返回全 0', async () => {
    const w = makeWorld([])
    const result = await run(w)
    expect(result).toMatchObject({ marked: 0, cleared: 0, deleted: 0 })
  })

  it('可观测性-streams 超阈值告警', async () => {
    const w = makeWorld([])
    const many = new Map<string, TeamMessage>()
    for (let i = 0; i < 3; i += 1) many.set(`m${i}`, message(`m${i}`, 't-live'))
    w.streams = fakeDomain({ messages: many, activities: new Map(), orphan_marks: w.marks })
    const warn = vi.fn()
    const { warnIfStreamsLarge } = await import('../src/storage/orphan-cleanup.js')
    warnIfStreamsLarge(w.streams, 2, { warn, info: vi.fn() })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('3')
  })
})
