import { describe, expect, it, vi } from 'vitest'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { CompositeAgentTeamStore, safeRecordKey } from '../src/storage/store.js'
import {
  agentTeamAssistantsSpec,
  agentTeamRuntimeSpec,
  agentTeamStreamsSpec,
} from '../src/storage/domain.js'
import type { Operation, TeamActivity, TeamAggregate, TeamMessage } from '../src/domain/types.js'

type AnyTable = KvTable<string, unknown>

function fakeTable(): AnyTable & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>()
  const table = {
    map,
    get: (key: string) => map.get(key),
    put: async (key: string, value: unknown) => { map.set(key, value) },
    delete: async (key: string) => map.delete(key),
    update: async (key: string, update: (current: unknown) => unknown) => {
      const current = map.get(key)
      if (current === undefined) throw new Error(`missing-key: ${key}`)
      const next = update(current)
      map.set(key, next)
      return next
    },
    entries: () => [...map.entries()],
    keys: () => [...map.keys()],
    size: map.size,
  }
  return table as never
}

function fakeDomain(tables: Record<string, AnyTable>): Domain<never> {
  return {
    name: 'fake',
    global: undefined as never,
    table: ((name: string) => tables[name]) as never,
    close: async () => {},
  } as never
}

interface Fixture {
  teams: Map<string, TeamAggregate>
  operations: Map<string, Operation>
  assistants: Map<string, unknown>
  messages: Map<string, TeamMessage>
  activities: Map<string, TeamActivity>
  marks: Map<string, unknown>
  store: CompositeAgentTeamStore
}

function makeStore(logger?: { warn: (message: string, error?: unknown) => void }): Fixture {
  const teams = fakeTable()
  const operations = fakeTable()
  const assistants = fakeTable()
  const messages = fakeTable()
  const activities = fakeTable()
  const marks = fakeTable()
  const store = new CompositeAgentTeamStore(
    fakeDomain({ teams, operations }) as never,
    fakeDomain({ assistants }) as never,
    fakeDomain({ messages, activities, orphan_marks: marks }) as never,
    logger,
  )
  return {
    teams: teams.map as Map<string, TeamAggregate>,
    operations: operations.map as Map<string, Operation>,
    assistants: assistants.map,
    messages: messages.map as Map<string, TeamMessage>,
    activities: activities.map as Map<string, TeamActivity>,
    marks: marks.map,
    store,
  }
}

function team(id: string, updatedAt: string): TeamAggregate {
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
    updatedAt,
  } as TeamAggregate
}

function message(id: string, teamId: string, createdAt: string, deliveryState: TeamMessage['deliveryState'] = 'delivered'): TeamMessage {
  return {
    schemaVersion: 1,
    id,
    teamId,
    sender: { kind: 'member', id: 'a' },
    recipient: { kind: 'leader' },
    type: 'instruction',
    content: 'hello',
    attachments: [],
    deliveryState,
    idempotencyKey: `k-${id}`,
    createdAt,
  } as TeamMessage
}

function activity(id: string, teamId: string, createdAt: string): TeamActivity {
  return {
    schemaVersion: 1,
    id,
    teamId,
    kind: 'team.message',
    summary: 's',
    revision: 1,
    createdAt,
  } as TeamActivity
}

describe('CompositeAgentTeamStore', () => {
  it('正常-五表 put/get/list/update/delete 全部落到对应域', async () => {
    const fx = makeStore()
    const t = team('t1', '2026-10-14T01:00:00.000Z')
    await fx.store.putTeam(t)
    expect(fx.teams.get('t1')).toEqual(t)
    expect(fx.store.getTeam('t1')).toEqual(t)

    await fx.store.putMessage(message('m1', 't1', '2026-10-14T02:00:00.000Z'))
    expect(fx.messages.size).toBe(1)

    await fx.store.putActivity(activity('a1', 't1', '2026-10-14T03:00:00.000Z'))
    expect(fx.activities.size).toBe(1)

    const operation: Operation = {
      schemaVersion: 1,
      id: 'op1',
      teamId: 't1',
      kind: 'dissolve_team',
      state: 'pending',
      stage: 'stage',
      createdAt: '2026-10-14T04:00:00.000Z',
      updatedAt: '2026-10-14T04:00:00.000Z',
    }
    await fx.store.putOperation(operation)
    expect(fx.operations.get('op1')).toEqual(operation)

    await fx.store.putAssistant({
      schemaVersion: 1,
      id: 'as1',
      name: 'assistant',
      description: '',
      instructions: '',
      provider: 'p',
      model: 'm',
      agentPresetId: 'ap',
      permissionPresetId: 'pp',
      skillAllowlist: [],
      mcpServers: [],
      revision: 1,
      createdAt: '2026-10-14T05:00:00.000Z',
      updatedAt: '2026-10-14T05:00:00.000Z',
    })
    expect(fx.assistants.size).toBe(1)

    const updated = await fx.store.updateTeam('t1', current => ({ ...current, revision: current.revision + 1 }))
    expect(updated.revision).toBe(2)

    expect(await fx.store.deleteActivity('a1')).toBe(true)
    expect(fx.activities.size).toBe(0)
    expect(await fx.store.deleteMessage('m1')).toBe(true)
    expect(fx.messages.size).toBe(0)
  })

  it('正常-listMessages/listActivities 按 teamId 过滤并按 createdAt+id 排序', async () => {
    const fx = makeStore()
    await fx.store.putTeam(team('t1', '2026-10-14T01:00:00.000Z'))
    await fx.store.putTeam(team('t2', '2026-10-14T00:30:00.000Z'))
    await fx.store.putMessage(message('m-b', 't1', '2026-10-14T02:00:00.000Z'))
    await fx.store.putMessage(message('m-a', 't1', '2026-10-14T02:00:00.000Z'))
    await fx.store.putMessage(message('m-other', 't2', '2026-10-14T01:00:00.000Z'))
    await fx.store.putActivity(activity('a-b', 't1', '2026-10-14T02:00:00.000Z'))
    await fx.store.putActivity(activity('a-a', 't1', '2026-10-14T02:00:00.000Z'))

    const messages = fx.store.listMessages('t1')
    expect(messages.map(item => item.id)).toEqual(['m-a', 'm-b'])
    const activities = fx.store.listActivities('t1')
    expect(activities.map(item => item.id)).toEqual(['a-a', 'a-b'])

    const teams = fx.store.listTeams()
    expect(teams.map(item => item.id)).toEqual(['t1', 't2'])
  })

  it('边界-空表 list 返回空数组，delete 不存在键返回 false', async () => {
    const fx = makeStore()
    expect(fx.store.listTeams()).toEqual([])
    expect(fx.store.listMessages('t1')).toEqual([])
    expect(fx.store.listActivities('t1')).toEqual([])
    expect(fx.store.listAssistants()).toEqual([])
    expect(fx.store.listOperations()).toEqual([])
    expect(await fx.store.deleteMessage('nope')).toBe(false)
    expect(fx.store.getOperation('nope')).toBeUndefined()
  })

  it('幂等-同键重复 put 后 list 单条', async () => {
    const fx = makeStore()
    const t = team('t1', '2026-10-14T01:00:00.000Z')
    await fx.store.putTeam(t)
    await fx.store.putTeam({ ...t, revision: 2 })
    expect(fx.store.listTeams()).toHaveLength(1)
    expect(fx.store.getTeam('t1')?.revision).toBe(2)
  })

  it('状态转换-message deliveryState 更新后可读（put 全量替换，同 putRuntimeMessage 模式）', async () => {
    const fx = makeStore()
    await fx.store.putMessage(message('m1', 't1', '2026-10-14T02:00:00.000Z', 'queued'))
    await fx.store.putMessage({ ...message('m1', 't1', '2026-10-14T02:00:00.000Z', 'queued'), deliveryState: 'delivered' })
    expect(fx.store.listMessages('t1')).toHaveLength(1)
    expect(fx.store.listMessages('t1')[0]?.deliveryState).toBe('delivered')
  })

  it('异常-EPERM 写失败被重试包装并告警（假桩注入）', async () => {
    const warn = vi.fn()
    const fx = makeStore({ warn })
    const failingPut = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'EPERM' }))
      .mockResolvedValueOnce(undefined)
    ;(fx.store as unknown as { messagesTable: AnyTable }).messagesTable = { put: failingPut } as unknown as AnyTable
    await fx.store.putMessage(message('m1', 't1', '2026-10-14T02:00:00.000Z'))
    expect(failingPut).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('messages')
    expect(String(warn.mock.calls[0]?.[0])).toContain('m1')
  })

  it('异常-非 EPERM 写失败原样上抛不重试', async () => {
    const warn = vi.fn()
    const fx = makeStore({ warn })
    const failingPut = vi.fn(async () => {
      throw Object.assign(new Error('disk'), { code: 'ENOSPC' })
    })
    const stub = { put: failingPut } as unknown as AnyTable
    ;(fx.store as unknown as { messagesTable: AnyTable }).messagesTable = stub
    await expect(fx.store.putMessage(message('m1', 't1', '2026-10-14T02:00:00.000Z'))).rejects.toMatchObject({ code: 'ENOSPC' })
    expect(failingPut).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('AC-1-被占用文件的链路重试耗尽后显式失败，未被占用链路不受影响', async () => {
    const warn = vi.fn()
    const fx = makeStore({ warn })
    const lockedPut = vi.fn(async () => {
      throw Object.assign(new Error('locked'), { errno: -4048 })
    })
    ;(fx.store as unknown as { teamsTable: AnyTable }).teamsTable = { put: lockedPut } as unknown as AnyTable
    // occupied channel fails explicitly after exhausting retries
    await expect(fx.store.putTeam(team('t1', '2026-10-14T01:00:00.000Z'))).rejects.toMatchObject({ errno: -4048 })
    expect(lockedPut).toHaveBeenCalledTimes(5)
    expect(warn).toHaveBeenCalledTimes(4)
    // unoccupied channel still works
    await fx.store.putMessage(message('m1', 't2', '2026-10-14T02:00:00.000Z'))
    expect(fx.messages.size).toBe(1)
  })

  it('正常-域 spec 路由（teams/operations 走 runtime 域，messages/activities/orphan_marks 走 streams 域）', () => {
    expect(agentTeamRuntimeSpec.name).toBe('agent_team_runtime')
    expect(agentTeamAssistantsSpec.name).toBe('agent_team_assistants')
    expect(agentTeamStreamsSpec.name).toBe('agent_team_streams')
  })

  it('回归-带冒号前缀的消息 id（agent-team:<uuid>）落盘为路径安全键且删除一致（2026-10-14 现网迁移实证）', async () => {
    const fx = makeStore()
    const prefixedId = 'agent-team:063f2d34-9964-4d8b-bf81-38843bdb832b'
    await fx.store.putMessage(message(prefixedId, 't1', '2026-10-14T02:00:00.000Z'))
    // the physical per-record key must be path-safe (no colon)
    expect(fx.messages.has(prefixedId)).toBe(false)
    expect(fx.messages.has('agent-team_063f2d34-9964-4d8b-bf81-38843bdb832b')).toBe(true)
    // reads go through values and are unaffected
    expect(fx.store.listMessages('t1')).toHaveLength(1)
    // deletes address the same sanitized key and report success
    await expect(fx.store.deleteMessage(prefixedId)).resolves.toBe(true)
    expect(fx.messages.size).toBe(0)
  })

  it('回归-safeRecordKey 幂等且仅替换非法字符', async () => {
    const raw = 'agent-team:063f2d34-9964-4d8b-bf81-38843bdb832b'
    expect(safeRecordKey(raw)).toBe('agent-team_063f2d34-9964-4d8b-bf81-38843bdb832b')
    expect(safeRecordKey(safeRecordKey(raw))).toBe(safeRecordKey(raw))
    expect(safeRecordKey('bare-uuid-1234')).toBe('bare-uuid-1234')
  })
})
