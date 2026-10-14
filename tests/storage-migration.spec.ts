import { mkdtemp, readFile, rm, writeFile, rename as fsRename, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import {
  agentTeamAssistantsSpec,
  agentTeamRuntimeSpec,
  agentTeamStreamsSpec,
} from '../src/storage/domain.js'
import {
  migrateLegacyAgentTeamStore,
  resolveStoragesRoot,
} from '../src/storage/migration.js'
import type { Operation, TeamActivity, TeamAggregate, TeamMessage, AssistantTemplate } from '../src/domain/types.js'

const LEGACY_FILE = 'agent_team.json'

interface TableMap { entries(): [string, unknown][]; size: number }

function fakeTable(records: Record<string, unknown>): TableMap & Map<string, unknown> {
  const map = new Map<string, unknown>(Object.entries(records))
  const protoEntries = Map.prototype.entries
  return Object.assign(map, {
    entries: () => [...protoEntries.call(map)],
    put: async (key: string, value: unknown) => { map.set(key, value) },
    get: (key: string) => map.get(key),
  }) as TableMap & Map<string, unknown>
}

function fakeDomain(tables: Record<string, TableMap>): Domain<never> {
  return {
    name: 'legacy',
    global: undefined as never,
    table: ((name: string) => tables[name]) as never,
    close: vi.fn(async () => {}),
  } as never
}

function assistant(id: string): AssistantTemplate {
  return {
    schemaVersion: 1,
    id,
    name: `assistant-${id}`,
    description: '',
    instructions: '',
    provider: 'p',
    model: 'm',
    agentPresetId: 'ap',
    permissionPresetId: 'pp',
    skillAllowlist: [],
    mcpServers: [],
    revision: 1,
    createdAt: '2026-10-14T00:00:00.000Z',
    updatedAt: '2026-10-14T00:00:00.000Z',
  } as AssistantTemplate
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
    content: 'hello',
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
    stage: 'stage',
    createdAt: '2026-10-14T01:00:00.000Z',
    updatedAt: '2026-10-14T01:00:00.000Z',
  } as Operation
}

interface Harness {
  runtime: { teams: Map<string, TeamAggregate>, operations: Map<string, Operation> }
  assistants: Map<string, AssistantTemplate>
  streams: { messages: Map<string, TeamMessage>, activities: Map<string, TeamActivity> }
  domains: { runtime: Domain<never>, assistants: Domain<never>, streams: Domain<never> }
}

function liveTable(map: Map<string, unknown>): unknown {
  const protoEntries = Map.prototype.entries
  return {
    put: async (key: string, value: unknown) => { map.set(key, value) },
    entries: () => [...protoEntries.call(map)],
    get: (key: string) => protoEntries.call(map) && map.get(key),
  }
}

function makeOpenLegacy(fixture: Record<string, Record<string, unknown>>) {
  return async (): Promise<Domain<never>> => fakeDomain({
    assistants: fakeTable(fixture.assistants ?? {}),
    teams: fakeTable(fixture.teams ?? {}),
    messages: fakeTable(fixture.messages ?? {}),
    activities: fakeTable(fixture.activities ?? {}),
    operations: fakeTable(fixture.operations ?? {}),
  }) as never
}

function makeNewDomains(): Harness {
  const runtimeTeams = new Map<string, TeamAggregate>()
  const runtimeOperations = new Map<string, Operation>()
  const assistants = new Map<string, AssistantTemplate>()
  const messages = new Map<string, TeamMessage>()
  const activities = new Map<string, TeamActivity>()
  const domains = {
    runtime: fakeDomain({
      teams: liveTable(runtimeTeams) as TableMap,
      operations: liveTable(runtimeOperations) as TableMap,
    }),
    assistants: fakeDomain({ assistants: liveTable(assistants) as TableMap }),
    streams: fakeDomain({
      messages: liveTable(messages) as TableMap,
      activities: liveTable(activities) as TableMap,
    }),
  }
  return {
    runtime: { teams: runtimeTeams, operations: runtimeOperations },
    assistants,
    streams: { messages, activities },
    domains,
  }
}

async function makeRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'agent-team-migration-'))
}

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function buildDeps(root: string, harness: Harness, overrides: Partial<Parameters<typeof migrateLegacyAgentTeamStore>[0]> = {}) {
  return {
    storageRoot: root,
    runtime: harness.domains.runtime,
    assistants: harness.domains.assistants,
    streams: harness.domains.streams,
    openLegacy: makeOpenLegacy({}),
    ...overrides,
  }
}

describe('migrateLegacyAgentTeamStore', () => {
  it('正常-旧文件存在：五表全量迁入新域，旧文件改名 .bak-时间戳', async () => {
    const root = await makeRoot()
    roots.push(root)
    const legacyPath = join(root, LEGACY_FILE)
    await writeFile(legacyPath, '{}', 'utf8')
    const harness = makeNewDomains()
    const legacyFixture = {
      assistants: { as1: assistant('as1') },
      teams: { t1: team('t1'), t2: team('t2') },
      messages: Object.fromEntries([1, 2, 3].map(i => [`m${i}`, message(`m${i}`, 't1')])),
      activities: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`a${i}`, activity(`a${i}`, 't1')])),
      operations: { op1: operation('op1', 't1'), opGlobal: operation('opGlobal', undefined) },
    }
    const closeLegacy = vi.fn(async () => {})
    const result = await migrateLegacyAgentTeamStore(buildDeps(root, harness, {
      openLegacy: async () => {
        const domain = await makeOpenLegacy(legacyFixture)()
        return { ...domain, close: closeLegacy } as never
      },
    }))
    expect(result.migrated).toBe(true)
    expect(result.counts).toEqual({ assistants: 1, teams: 2, messages: 3, activities: 5, operations: 2 })
    expect(harness.runtime.teams.get('t1')).toEqual(team('t1'))
    expect(harness.streams.messages.size).toBe(3)
    expect(harness.assistants.get('as1')).toBeDefined()
    expect(harness.runtime.operations.get('opGlobal')).toBeDefined()
    expect(closeLegacy).toHaveBeenCalledTimes(1)
    await expect(stat(join(root, LEGACY_FILE))).rejects.toMatchObject({ code: 'ENOENT' })
    const entries = await (await import('node:fs/promises')).readdir(root)
    expect(entries.some(name => name.startsWith('agent_team.json.bak-'))).toBe(true)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('正常-旧文件不存在（首次安装）：跳过迁移，不建 .bak', async () => {
    const root = await makeRoot()
    roots.push(root)
    const openLegacy = vi.fn()
    const result = await migrateLegacyAgentTeamStore(buildDeps(root, makeNewDomains(), { openLegacy: openLegacy as never }))
    expect(result.migrated).toBe(false)
    expect(openLegacy).not.toHaveBeenCalled()
    expect(await (await import('node:fs/promises')).readdir(root)).toEqual([])
  })

  it('回归-冒号前缀消息 id（agent-team:<uuid>）迁移为路径安全键，对账通过（2026-10-14 现网实证）', async () => {
    const root = await makeRoot()
    roots.push(root)
    const legacyPath = join(root, LEGACY_FILE)
    await writeFile(legacyPath, '{}', 'utf8')
    const harness = makeNewDomains()
    const prefixedId = 'agent-team:063f2d34-9964-4d8b-bf81-38843bdb832b'
    const legacyFixture = {
      teams: { t1: team('t1') },
      messages: { [prefixedId]: message(prefixedId, 't1') },
      activities: {},
      operations: {},
    }
    const result = await migrateLegacyAgentTeamStore(buildDeps(root, harness, {
      openLegacy: makeOpenLegacy(legacyFixture),
    }))
    expect(result.migrated).toBe(true)
    // physical key sanitized (no colon); value.id preserved
    expect(harness.streams.messages.has(prefixedId)).toBe(false)
    expect(harness.streams.messages.has('agent-team_063f2d34-9964-4d8b-bf81-38843bdb832b')).toBe(true)
    expect(result.backupPending).toBeUndefined()
  })

  it('重入-写入新域中途失败：旧文件保留，重跑收敛且无双份', async () => {
    const root = await makeRoot()
    roots.push(root)
    const legacyPath = join(root, LEGACY_FILE)
    await writeFile(legacyPath, '{}', 'utf8')
    const harness = makeNewDomains()
    const legacyFixture = {
      teams: { t1: team('t1') },
      messages: { m1: message('m1', 't1'), m2: message('m2', 't1') },
    }

    // first attempt: the streams messages table throws once mid-drain
    let failNext = true
    const messagesTable = {
      put: async (key: string, value: TeamMessage) => {
        if (failNext) {
          failNext = false
          throw Object.assign(new Error('crash mid-migration'), { code: 'EPERM' })
        }
        harness.streams.messages.set(key, value)
      },
      entries: () => [...harness.streams.messages.entries()],
    }
    const streamsWithFailure = {
      name: 'streams',
      global: undefined as never,
      table: (name: string) => (name === 'messages' ? messagesTable : fakeTable({})),
      close: async () => {},
    } as never
    const runtimeDomain = fakeDomain({ teams: fakeTable({}), operations: fakeTable({}) })
    const assistantsDomain = fakeDomain({ assistants: fakeTable({}) })
    await expect(migrateLegacyAgentTeamStore({
      storageRoot: root,
      runtime: runtimeDomain,
      assistants: assistantsDomain,
      streams: streamsWithFailure,
      openLegacy: makeOpenLegacy(legacyFixture),
    })).rejects.toSatisfy((error: Error) => {
      const cause = error.cause as { code?: string } | undefined
      return cause?.code === 'EPERM' && error.message.includes('迁移失败')
    })
    expect(await stat(legacyPath)).toBeDefined()
    expect(await (await import('node:fs/promises')).readdir(root)).toEqual([LEGACY_FILE])

    // rerun converges with no duplicates
    const result = await migrateLegacyAgentTeamStore(buildDeps(root, harness, {
      openLegacy: makeOpenLegacy(legacyFixture),
    }))
    expect(result.migrated).toBe(true)
    expect(result.counts?.messages).toBe(2)
    expect(harness.streams.messages.size).toBe(2)
    expect(harness.runtime.teams.size).toBe(1)
    await expect(stat(legacyPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('异常-legacy open 抛 invalid-record：fail-closed，错误含旧文件绝对路径与人工恢复指引', async () => {
    const root = await makeRoot()
    roots.push(root)
    const legacyPath = join(root, LEGACY_FILE)
    await writeFile(legacyPath, '{}', 'utf8')
    await expect(migrateLegacyAgentTeamStore(buildDeps(root, makeNewDomains(), {
      openLegacy: async () => {
        throw Object.assign(new Error('invalid-record: teams/t1'), { code: 'INVALID_RECORD' })
      },
    }))).rejects.toSatisfy((error: Error) => {
      const text = `${error.message}`
      return text.includes(legacyPath) && text.includes('改名') && text.includes('跳过迁移')
    })
    expect(await readFile(legacyPath, 'utf8')).toBe('{}')
  })

  it('A-2-rename EPERM 耗尽：对账已通过，迁移判定成功、不触发 fail-closed，旧文件保留待下轮重试', async () => {
    const root = await makeRoot()
    roots.push(root)
    const legacyPath = join(root, LEGACY_FILE)
    await writeFile(legacyPath, '{}', 'utf8')
    const harness = makeNewDomains()
    const lockedRename = vi.fn(async () => {
      throw Object.assign(new Error('locked'), { code: 'EPERM' })
    })
    const result = await migrateLegacyAgentTeamStore(buildDeps(root, harness, {
      openLegacy: makeOpenLegacy({ teams: { t1: team('t1') } }),
      renameFile: lockedRename,
      retry: { maxRetries: 1, delay: async () => {} },
    }))
    expect(result.migrated).toBe(true)
    expect(result.backupPending).toBe(true)
    expect(harness.runtime.teams.size).toBe(1)
    expect(await readFile(legacyPath, 'utf8')).toBe('{}')
    expect(lockedRename).toHaveBeenCalledTimes(2)
  })

  it('A-1-回读对账失败（表计数不符）：迁移失败 + fail-closed，旧文件保留', async () => {
    const root = await makeRoot()
    roots.push(root)
    const legacyPath = join(root, LEGACY_FILE)
    await writeFile(legacyPath, '{}', 'utf8')
    const harness = makeNewDomains()
    // teams table drops one record silently after put (reconciliation mismatch)
    const teamsTable = {
      put: async (key: string, value: TeamAggregate) => {
        if (key === 't2') return
        harness.runtime.teams.set(key, value)
      },
      entries: () => [...harness.runtime.teams.entries()],
      get: (key: string) => harness.runtime.teams.get(key),
    }
    const runtimeDomain = {
      name: 'runtime',
      global: undefined as never,
      table: (name: string) => (name === 'teams' ? teamsTable : fakeTable({})),
      close: async () => {},
    } as never
    await expect(migrateLegacyAgentTeamStore({
      storageRoot: root,
      runtime: runtimeDomain,
      assistants: harness.domains.assistants,
      streams: harness.domains.streams,
      openLegacy: makeOpenLegacy({ teams: { t1: team('t1'), t2: team('t2') } }),
    })).rejects.toSatisfy((error: Error) => error.message.includes('对账') && error.message.includes(legacyPath))
    expect(await readFile(legacyPath, 'utf8')).toBe('{}')
    await expect(stat(legacyPath)).resolves.toBeDefined()
  })

  it('A-1-回读对账失败（内容不符）：迁移失败，旧文件保留', async () => {
    const root = await makeRoot()
    roots.push(root)
    const legacyPath = join(root, LEGACY_FILE)
    await writeFile(legacyPath, '{}', 'utf8')
    const harness = makeNewDomains()
    const tampered = { ...message('m1', 't1'), content: 'tampered' }
    const messagesTable = {
      put: async (key: string, value: TeamMessage) => {
        harness.streams.messages.set(key, key === 'm1' ? tampered : value)
      },
      entries: () => [...harness.streams.messages.entries()],
      get: (key: string) => harness.streams.messages.get(key),
    }
    const streamsDomain = {
      name: 'streams',
      global: undefined as never,
      table: (name: string) => (name === 'messages' ? messagesTable : fakeTable({})),
      close: async () => {},
    } as never
    await expect(migrateLegacyAgentTeamStore({
      storageRoot: root,
      runtime: harness.domains.runtime,
      assistants: harness.domains.assistants,
      streams: streamsDomain,
      openLegacy: makeOpenLegacy({ messages: { m1: message('m1', 't1') } }),
    })).rejects.toSatisfy((error: Error) => error.message.includes('对账') && error.message.includes(legacyPath))
    expect(await readFile(legacyPath, 'utf8')).toBe('{}')
  })

  it('B-1-stat 非 ENOENT（EACCES）：fail-closed 显式抛错（含旧文件绝对路径），不静默跳过', async () => {
    const root = await makeRoot()
    roots.push(root)
    const legacyPath = join(root, LEGACY_FILE)
    await writeFile(legacyPath, '{}', 'utf8')
    const fileExists = vi.fn(async () => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    })
    const openLegacy = vi.fn()
    await expect(migrateLegacyAgentTeamStore(buildDeps(root, makeNewDomains(), {
      fileExists: fileExists as never,
      openLegacy: openLegacy as never,
    }))).rejects.toSatisfy((error: Error) => {
      const cause = error.cause as { code?: string } | undefined
      return cause?.code === 'EACCES' && error.message.includes(legacyPath) && error.message.includes('迁移失败')
    })
    expect(openLegacy).not.toHaveBeenCalled()
    expect(await readFile(legacyPath, 'utf8')).toBe('{}')
  })

  it('边界-旧文件缺表/空对象：按空表迁移成功', async () => {
    const root = await makeRoot()
    roots.push(root)
    await writeFile(join(root, LEGACY_FILE), '{}', 'utf8')
    const harness = makeNewDomains()
    const result = await migrateLegacyAgentTeamStore(buildDeps(root, harness, {
      openLegacy: makeOpenLegacy({}),
    }))
    expect(result.migrated).toBe(true)
    expect(result.counts).toEqual({ assistants: 0, teams: 0, messages: 0, activities: 0, operations: 0 })
    expect(harness.runtime.teams.size).toBe(0)
  })

  it('正常-resolveStoragesRoot 尊重 $DSH_HOME 优先级', () => {
    const previous = process.env.DSH_HOME
    try {
      process.env.DSH_HOME = 'C:/custom-dsh'
      expect(resolveStoragesRoot().replace(/\\/g, '/')).toBe('C:/custom-dsh/storages')
      process.env.DSH_HOME = '   '
      expect(resolveStoragesRoot().replace(/\\/g, '/')).toContain('/.dsh/storages')
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  it('正常-使用真实 fs rename（EPERM 重试包装默认路径）', async () => {
    const root = await makeRoot()
    roots.push(root)
    await writeFile(join(root, LEGACY_FILE), '{}', 'utf8')
    const harness = makeNewDomains()
    const result = await migrateLegacyAgentTeamStore(buildDeps(root, harness, {
      openLegacy: makeOpenLegacy({ teams: { t1: team('t1') } }),
    }))
    expect(result.migrated).toBe(true)
    const entries = await (await import('node:fs/promises')).readdir(root)
    expect(entries.filter(name => name.startsWith('agent_team.json.bak-'))).toHaveLength(1)
  })
})
