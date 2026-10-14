/**
 * QA E2E 验证（06 报告证据，不属 dev 测试面）：
 * 用「安装版宿主」的 dsh-storage / dsh-storage-json / dsh-storage-domain 真实装配
 * BackendRegistry + JsonStorageBackend(root) + DomainFacility，对迁移全链路、
 * fail-closed、per-record 坏文档行为做实证。全部介质在 os.tmpdir()，
 * 绝不触碰真实 %USERPROFILE%\.dsh\storages。
 *
 * 宿主包不在插件依赖内（dsh-storage-json 仅存在于安装版 app），路径可被
 * DSH_HOST_APP 覆盖；缺失时整组用例 skip（CI/非 Windows 桌面环境）。
 */
import { mkdtemp, readdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import {
  agentTeamAssistantsSpec,
  agentTeamRuntimeSpec,
  agentTeamStreamsSpec,
  legacyAgentTeamSpec,
} from '../src/storage/domain.js'
import { migrateLegacyAgentTeamStore } from '../src/storage/migration.js'
import type { Operation, TeamActivity, TeamAggregate, TeamMessage, AssistantTemplate } from '../src/domain/types.js'

const HOST_APP = process.env.DSH_HOST_APP ?? 'H:\\Program Files\\DSH Desktop\\resources\\app'
const HOST_MODULES = join(HOST_APP, 'node_modules', '@deepseek-ai')

let hostAvailable: boolean | undefined
async function hostModules(): Promise<boolean> {
  if (hostAvailable !== undefined) return hostAvailable
  try {
    await import(pathToFileURL(join(HOST_MODULES, 'dsh-storage-json', 'lib', 'index.js')).href)
    hostAvailable = true
  } catch {
    hostAvailable = false
  }
  return hostAvailable
}

interface HostKit {
  registry: { register(name: string, backend: unknown): () => void, get(name: string): unknown }
  JsonStorageBackend: new (root: string) => { kv: { open(descriptor: unknown): Promise<unknown> }, close(): Promise<void> }
  DomainFacility: new (ctx: unknown, config: unknown) => { open(spec: unknown): Promise<unknown> }
}

type Facility = { open(spec: unknown): Promise<unknown> }

async function loadHost(): Promise<HostKit> {
  const storage = await import(pathToFileURL(join(HOST_MODULES, 'dsh-storage', 'lib', 'index.js')).href) as {
    BackendRegistry: new () => HostKit['registry']
  }
  const json = await import(pathToFileURL(join(HOST_MODULES, 'dsh-storage-json', 'lib', 'index.js')).href) as {
    JsonStorageBackend: HostKit['JsonStorageBackend']
  }
  const domain = await import(pathToFileURL(join(HOST_MODULES, 'dsh-storage-domain', 'lib', 'index.js')).href) as {
    DomainFacility: HostKit['DomainFacility']
  }
  return { registry: new storage.BackendRegistry(), JsonStorageBackend: json.JsonStorageBackend, DomainFacility: domain.DomainFacility }
}

/** 真实宿主链路装配：backend(root) + facility(backend:'json')。 */
async function makeKit(root: string): Promise<{ facility: Facility }> {
  const kit = await loadHost()
  const backend = new kit.JsonStorageBackend(root)
  kit.registry.register('json', backend)
  const facility = new kit.DomainFacility(
    { storage: { backend: kit.registry }, logger: { error() {}, warn() {}, info() {} } },
    { backend: 'json' },
  )
  return { facility }
}

async function openDomain(facility: Facility, spec: unknown): Promise<Domain<never>> {
  return await facility.open(spec) as Domain<never>
}

// ---- fixtures（与 05/迁移测试同构的最小合法记录）----

function assistant(id: string): AssistantTemplate {
  return {
    schemaVersion: 1, id, name: `assistant-${id}`, description: '', instructions: '',
    provider: 'p', model: 'm', agentPresetId: 'ap', permissionPresetId: 'pp',
    skillAllowlist: [], mcpServers: [], revision: 1,
    createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z',
  } as AssistantTemplate
}

function team(id: string): TeamAggregate {
  return {
    schemaVersion: 1, id, name: `team-${id}`, workspaceId: 'ws', workspacePath: 'C:/tmp',
    leaderSlotId: 'lead', state: 'active', directMemberChat: false,
    members: {}, retiredSessions: {}, tasks: {}, leases: {}, outbox: {}, revision: 1,
    createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z',
  } as TeamAggregate
}

function message(id: string, teamId: string): TeamMessage {
  return {
    schemaVersion: 1, id, teamId, sender: { kind: 'member', id: 'a' }, recipient: { kind: 'leader' },
    type: 'instruction', content: 'hello', attachments: [], deliveryState: 'delivered',
    idempotencyKey: `k-${id}`, createdAt: '2026-10-14T01:00:00.000Z',
  } as TeamMessage
}

function activity(id: string, teamId: string): TeamActivity {
  return {
    schemaVersion: 1, id, teamId, kind: 'team.message', summary: 's', revision: 1,
    createdAt: '2026-10-14T01:00:00.000Z',
  } as TeamActivity
}

function operation(id: string, teamId: string | undefined): Operation {
  return {
    schemaVersion: 1, id, teamId, kind: 'dissolve_team', state: 'completed', stage: 'stage',
    createdAt: '2026-10-14T01:00:00.000Z', updatedAt: '2026-10-14T01:00:00.000Z',
  } as Operation
}

async function allFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await allFiles(full))
    else out.push(full)
  }
  return out
}

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('QA E2E（安装版宿主真实链路）', () => {
  it('全链路：真实 json 后端 legacy 落盘 → 插件迁移 → 新域回读对账 + .bak', async () => {
    if (!await hostModules()) return
    const root = await mkdtemp(join(tmpdir(), 'qa-e2e-migration-'))
    roots.push(root)

    // 阶段1：真实宿主 single unit 写入存量数据（模拟现网 agent_team.json）
    const seedFacility = (await makeKit(root)).facility
    const seed = await openDomain(seedFacility, legacyAgentTeamSpec)
    await seed.table('teams').put('t1', team('t1'))
    await seed.table('teams').put('t2', team('t2'))
    await seed.table('messages').put('m1', message('m1', 't1'))
    await seed.table('messages').put('m2', message('m2', 't1'))
    await seed.table('activities').put('a1', activity('a1', 't1'))
    await seed.table('assistants').put('as1', assistant('as1'))
    await seed.table('operations').put('op1', operation('op1', 't1'))
    await seed.table('operations').put('opG', operation('opG', undefined))
    await seed.close()
    expect(await stat(join(root, 'agent_team.json'))).toBeDefined()

    // 阶段2：与 index.ts 相同顺序打开三新域 + 运行迁移
    const { facility } = await makeKit(root)
    const runtimeDomain = await openDomain(facility, agentTeamRuntimeSpec)
    const assistantsDomain = await openDomain(facility, agentTeamAssistantsSpec)
    const streamsDomain = await openDomain(facility, agentTeamStreamsSpec)
    const result = await migrateLegacyAgentTeamStore({
      storageRoot: root,
      runtime: runtimeDomain,
      assistants: assistantsDomain,
      streams: streamsDomain,
      openLegacy: () => openDomain(facility, legacyAgentTeamSpec),
    })
    expect(result.migrated).toBe(true)
    expect(result.counts).toEqual({ assistants: 1, teams: 2, messages: 2, activities: 1, operations: 2 })

    // 阶段3：QA 独立回读对账（源键集合与内容逐一比对，AC-2 口径）
    expect([...runtimeDomain.table('teams').entries()]).toEqual([
      ['t1', team('t1')], ['t2', team('t2')],
    ])
    expect([...streamsDomain.table('messages').entries()]).toEqual([
      ['m1', message('m1', 't1')], ['m2', message('m2', 't1')],
    ])
    expect([...streamsDomain.table('activities').entries()]).toEqual([['a1', activity('a1', 't1')]])
    expect([...assistantsDomain.table('assistants').entries()]).toEqual([['as1', assistant('as1')]])
    expect([...runtimeDomain.table('operations').entries()]).toEqual([['op1', operation('op1', 't1')], ['opG', operation('opG', undefined)]])

    // 阶段4：旧文件改名 .bak，磁盘可见；关闭后重开（模拟重启）数据仍在
    await expect(stat(join(root, 'agent_team.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    const rootFiles = await readdir(root)
    expect(rootFiles.filter(name => name.startsWith('agent_team.json.bak-'))).toHaveLength(1)
    await runtimeDomain.close()
    await assistantsDomain.close()
    await streamsDomain.close()
    const reopenedRuntime = await openDomain(facility, agentTeamRuntimeSpec)
    expect(reopenedRuntime.table('teams').get('t1')).toEqual(team('t1'))
  })

  it('fail-closed：畸形 legacy 文件 → open 抛错，错误含绝对路径与人工恢复指引，原文件原样', async () => {
    if (!await hostModules()) return
    const root = await mkdtemp(join(tmpdir(), 'qa-e2e-bad-'))
    roots.push(root)
    const legacyPath = join(root, 'agent_team.json')
    await writeFile(legacyPath, '{ not valid json !!!', 'utf8')
    const { facility } = await makeKit(root)
    const runtimeDomain = await openDomain(facility, agentTeamRuntimeSpec)
    const assistantsDomain = await openDomain(facility, agentTeamAssistantsSpec)
    const streamsDomain = await openDomain(facility, agentTeamStreamsSpec)
    await expect(migrateLegacyAgentTeamStore({
      storageRoot: root,
      runtime: runtimeDomain,
      assistants: assistantsDomain,
      streams: streamsDomain,
      openLegacy: () => openDomain(facility, legacyAgentTeamSpec),
    })).rejects.toSatisfy((error: Error) => {
      const text = `${error.message}`
      return text.includes(legacyPath) && text.includes('改名') && text.includes('跳过迁移')
    })
    expect(await readFile(legacyPath, 'utf8')).toBe('{ not valid json !!!')
  })

  it('坏文档实证：runtime spec 声明 backup-and-skip → schema-invalid 记录挪移 .bak、open 成功、其余记录完好', async () => {
    if (!await hostModules()) return
    const root = await mkdtemp(join(tmpdir(), 'qa-e2e-skip-'))
    roots.push(root)
    const { facility } = await makeKit(root)
    const runtime = await openDomain(facility, agentTeamRuntimeSpec)
    await runtime.table('teams').put('tGood', team('tGood'))
    await runtime.close()
    const badPath = join(root, 'agent_team_runtime', 'teams', 'tBad.json')
    // 宿主 per-record 物理格式：{version:1, record:{...}} 包装层；
    // 包装层合法 + record 内容 schema-invalid 才命中 domain 层 zod 解析（invalid-record 路径）
    await writeFile(badPath, JSON.stringify({ version: 1, record: { schemaVersion: 1, id: 'tBad', totallyWrong: true } }), 'utf8')
    // shipped spec（runtime）已声明 invalidRecords:'backup-and-skip' → open 不失败
    const domain = await openDomain(facility, agentTeamRuntimeSpec)
    expect(domain.table('teams').get('tBad')).toBeUndefined()
    expect(domain.table('teams').get('tGood')).toEqual(team('tGood'))
    const leftovers = (await allFiles(join(root, 'agent_team_runtime'))).filter(path => path.includes('tBad'))
    expect(leftovers.length).toBeGreaterThanOrEqual(1)
  })

  it('约束断言（01 v4.1 §6）：runtime/streams 声明 invalidRecords，assistants（single）不声明', () => {
    expect((agentTeamRuntimeSpec as { invalidRecords?: string }).invalidRecords).toBe('backup-and-skip')
    expect((agentTeamStreamsSpec as { invalidRecords?: string }).invalidRecords).toBe('backup-and-skip')
    expect((agentTeamAssistantsSpec as { invalidRecords?: string }).invalidRecords).toBeUndefined()
  })

  it('坏文档实证-malformed：per-record 文件非法 JSON → 静默读作 absent，原文件留存，open 不失败', async () => {
    if (!await hostModules()) return
    const root = await mkdtemp(join(tmpdir(), 'qa-e2e-malformed-'))
    roots.push(root)
    const { facility } = await makeKit(root)
    const runtime = await openDomain(facility, agentTeamRuntimeSpec)
    await runtime.table('teams').put('tGood', team('tGood'))
    await runtime.close()
    await writeFile(join(root, 'agent_team_runtime', 'teams', 'tCorrupt.json'), 'not-json{{', 'utf8')
    const domain = await openDomain(facility, agentTeamRuntimeSpec)
    expect(domain.table('teams').get('tCorrupt')).toBeUndefined()
    expect(domain.table('teams').get('tGood')).toEqual(team('tGood'))
    expect(await stat(join(root, 'agent_team_runtime', 'teams', 'tCorrupt.json'))).toBeDefined()
  })
})
