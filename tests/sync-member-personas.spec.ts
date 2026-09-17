import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { Config } from '../src/config.js'
import { AgentTeamError } from '../src/domain/errors.js'
import {
  isTeamBusy,
  snapshotAssistant,
  type AssistantTemplate,
  type TeamActivity,
  type TeamAggregate,
  type TeamMemberSlot,
  type TeamMessage,
  type TeamTask,
} from '../src/domain/types.js'
import { AgentTeamService } from '../src/service/agent-team-service.js'
import type { AgentTeamStore } from '../src/storage/store.js'
import { countDriftedMembers } from '../src/client/team-persona.js'

const config: Config = {
  maxRequestBytes: 128 * 1024,
  sseHeartbeatMs: 20_000,
  runtimeConcurrency: 4,
  directMemberChatDefault: true,
  assistantBuilderProvider: '',
  assistantBuilderModel: '',
  assistantBuilderAgentPresetId: '',
  assistantBuilderPermissionPresetId: '',
}

function assistantFixture(id: string, name: string, overrides: Partial<AssistantTemplate> = {}): AssistantTemplate {
  return {
    schemaVersion: 1,
    id,
    name,
    instructions: `instructions of ${name}`,
    provider: 'openai',
    model: 'codex',
    agentPresetId: 'default',
    permissionPresetId: 'standard',
    skillAllowlist: ['code-review'],
    mcpServers: [],
    revision: 1,
    createdAt: '2026-09-17T00:00:00.000Z',
    updatedAt: '2026-09-17T00:00:00.000Z',
    ...overrides,
  }
}

function memberFixture(
  id: string,
  assistant: AssistantTemplate,
  overrides: Partial<TeamMemberSlot> = {},
): TeamMemberSlot {
  return {
    id,
    assistantId: assistant.id,
    displayName: assistant.name,
    role: 'member',
    assistantSnapshot: snapshotAssistant(assistant),
    permissionPresetId: assistant.permissionPresetId,
    sessionId: `agent-team:${id}`,
    desiredState: 'online',
    lastRuntimeState: 'idle',
    joinedAt: '2026-09-17T00:00:00.000Z',
    ...overrides,
  }
}

function teamFixture(members: Record<string, TeamMemberSlot>, overrides: Partial<TeamAggregate> = {}): TeamAggregate {
  return {
    schemaVersion: 1,
    id: 'team-1',
    name: 'Sync Team',
    workspaceId: 'workspace-1',
    workspacePath: '/tmp/agent-team-workspace',
    leaderSlotId: 'slot-leader',
    state: 'active',
    directMemberChat: true,
    members,
    retiredSessions: {},
    tasks: {},
    leases: {},
    outbox: {},
    revision: 7,
    createdAt: '2026-09-17T00:00:00.000Z',
    updatedAt: '2026-09-17T00:00:00.000Z',
    ...overrides,
  }
}

function taskFixture(id: string, status: TeamTask['status']): TeamTask {
  return {
    id,
    title: `task ${id}`,
    description: '',
    status,
    dependencyIds: [],
    fileScopes: [],
    revision: 1,
    createdAt: '2026-09-17T00:00:00.000Z',
    updatedAt: '2026-09-17T00:00:00.000Z',
  }
}

class MemoryStore implements AgentTeamStore {
  readonly assistants = new Map<string, AssistantTemplate>()
  readonly teams = new Map<string, TeamAggregate>()
  readonly activities: TeamActivity[] = []
  readonly messages = new Map<string, TeamMessage>()
  readonly operations = new Map<string, TeamAggregate extends never ? never : never>()

  getAssistant(id: string): AssistantTemplate | undefined {
    return this.assistants.get(id)
  }

  listAssistants(): AssistantTemplate[] {
    return [...this.assistants.values()]
  }

  putAssistant(value: AssistantTemplate): Promise<void> {
    this.assistants.set(value.id, value)
    return Promise.resolve()
  }

  updateAssistant(id: string, update: (current: AssistantTemplate) => AssistantTemplate): Promise<AssistantTemplate> {
    const current = this.assistants.get(id)
    if (current === undefined) return Promise.reject(new Error(`assistant '${id}' not found`))
    const next = update(current)
    this.assistants.set(id, next)
    return Promise.resolve(next)
  }

  deleteAssistant(id: string): Promise<boolean> {
    return Promise.resolve(this.assistants.delete(id))
  }

  getTeam(id: string): TeamAggregate | undefined {
    return this.teams.get(id)
  }

  listTeams(): TeamAggregate[] {
    return [...this.teams.values()]
  }

  putTeam(value: TeamAggregate): Promise<void> {
    this.teams.set(value.id, value)
    return Promise.resolve()
  }

  updateTeam(id: string, update: (current: TeamAggregate) => TeamAggregate): Promise<TeamAggregate> {
    const current = this.teams.get(id)
    if (current === undefined) return Promise.reject(new Error(`team '${id}' not found`))
    const next = update(current)
    this.teams.set(id, next)
    return Promise.resolve(next)
  }

  deleteTeam(id: string): Promise<boolean> {
    return Promise.resolve(this.teams.delete(id))
  }

  listMessages(teamId: string): TeamMessage[] {
    return [...this.messages.values()].filter(message => message.teamId === teamId)
  }

  putMessage(value: TeamMessage): Promise<void> {
    this.messages.set(value.id, value)
    return Promise.resolve()
  }

  deleteMessage(id: string): Promise<boolean> {
    return Promise.resolve(this.messages.delete(id))
  }

  listActivities(teamId: string): TeamActivity[] {
    return this.activities.filter(activity => activity.teamId === teamId)
  }

  putActivity(value: TeamActivity): Promise<void> {
    this.activities.push(value)
    return Promise.resolve()
  }

  deleteActivity(id: string): Promise<boolean> {
    const before = this.activities.length
    const index = this.activities.findIndex(activity => activity.id === id)
    if (index >= 0) this.activities.splice(index, 1)
    return Promise.resolve(this.activities.length < before)
  }

  getOperation(): undefined {
    return undefined
  }

  listOperations(): never[] {
    return []
  }

  putOperation(): Promise<void> {
    return Promise.resolve()
  }

  updateOperation(): never {
    throw new Error('not implemented')
  }

  deleteOperation(): Promise<boolean> {
    return Promise.resolve(false)
  }
}

function createHarness(): { service: AgentTeamService; store: MemoryStore } {
  const ctx = new Context()
  const store = new MemoryStore()
  return { service: new AgentTeamService(ctx, config, store), store }
}

async function seedActiveTeam(store: MemoryStore): Promise<TeamAggregate> {
  const leader = assistantFixture('assistant-leader', 'Alice')
  const member = assistantFixture('assistant-member', 'Bob')
  await store.putAssistant(leader)
  await store.putAssistant(member)
  const team = teamFixture({
    'slot-leader': memberFixture('slot-leader', leader, { role: 'leader' }),
    'slot-member': memberFixture('slot-member', member),
  })
  await store.putTeam(team)
  return team
}

describe('isTeamBusy', () => {
  it('正常-全员空闲且无运行任务时判定为空闲', () => {
    const leader = assistantFixture('a1', 'Alice')
    const team = teamFixture({ 'slot-1': memberFixture('slot-1', leader, { role: 'leader' }) })
    expect(isTeamBusy(team)).toBe(false)
  })

  it('异常-任一成员 running/waiting_approval 即忙碌', () => {
    const leader = assistantFixture('a1', 'Alice')
    const base = { role: 'leader' as const }
    expect(isTeamBusy(teamFixture({
      'slot-1': memberFixture('slot-1', leader, { ...base, lastRuntimeState: 'running' }),
    }))).toBe(true)
    expect(isTeamBusy(teamFixture({
      'slot-1': memberFixture('slot-1', leader, { ...base, lastRuntimeState: 'waiting_approval' }),
    }))).toBe(true)
  })

  it('异常-任一任务 running 即忙碌', () => {
    const leader = assistantFixture('a1', 'Alice')
    expect(isTeamBusy(teamFixture(
      { 'slot-1': memberFixture('slot-1', leader, { role: 'leader' }) },
      { tasks: { 'task-1': taskFixture('task-1', 'running') } },
    ))).toBe(true)
  })

  it('边界-移除中成员 running 仍视为忙碌（运行时状态与 desiredState 独立）', () => {
    const leader = assistantFixture('a1', 'Alice')
    expect(isTeamBusy(teamFixture({
      'slot-1': memberFixture('slot-1', leader, { role: 'leader', desiredState: 'removing', lastRuntimeState: 'running' }),
    }))).toBe(true)
  })
})

describe('AgentTeamService.syncMemberPersonas', () => {
  it('正常-AC4 有漂移时整套覆盖快照且会话保留', async () => {
    const { service, store } = createHarness()
    const team = await seedActiveTeam(store)
    await store.updateAssistant('assistant-member', current => ({
      ...current,
      name: 'Bobby',
      instructions: 'updated instructions',
      model: 'codex-2',
      revision: 2,
      updatedAt: '2026-09-17T01:00:00.000Z',
    }))

    const before = store.getTeam('team-1')!
    const result = await service.syncMemberPersonas('team-1')

    expect(result.refreshedCount).toBe(1)
    const refreshed = result.team.members['slot-member']!
    expect(refreshed.displayName).toBe('Bobby')
    expect(refreshed.assistantSnapshot.instructions).toBe('updated instructions')
    expect(refreshed.assistantSnapshot.model).toBe('codex-2')
    expect(refreshed.assistantSnapshot.revision).toBe(2)
    expect(refreshed.sessionId).toBe(before.members['slot-member']!.sessionId)
    expect(result.team.members['slot-leader']!.assistantSnapshot).toEqual(before.members['slot-leader']!.assistantSnapshot)
    expect(store.getTeam('team-1')!.members['slot-member']!.displayName).toBe('Bobby')
    expect(result.team.revision).toBe(before.revision + 1)
    expect(store.listActivities('team-1').some(activity => activity.kind === 'team.snapshots_refreshed')).toBe(true)
  })

  it('边界-AC5 无漂移时 no-op：revision 不变且无 activity', async () => {
    const { service, store } = createHarness()
    await seedActiveTeam(store)
    const before = store.getTeam('team-1')!

    const result = await service.syncMemberPersonas('team-1')

    expect(result.refreshedCount).toBe(0)
    expect(result.team.revision).toBe(before.revision)
    expect(store.getTeam('team-1')!.revision).toBe(before.revision)
    expect(store.listActivities('team-1')).toEqual([])
  })

  it('异常-AC6 模板缺失时 ASSISTANT_NOT_FOUND 含成员名且全队快照不变', async () => {
    const { service, store } = createHarness()
    const team = await seedActiveTeam(store)
    await store.updateAssistant('assistant-member', current => ({
      ...current,
      name: 'Bobby',
      revision: 2,
      updatedAt: '2026-09-17T01:00:00.000Z',
    }))
    const leaderTemplate = store.getAssistant('assistant-leader')!
    await store.updateAssistant('assistant-leader', current => ({
      ...current,
      name: 'Alice Prime',
      revision: 3,
      updatedAt: '2026-09-17T01:00:00.000Z',
    }))
    await store.deleteAssistant('assistant-member')

    const before = store.getTeam('team-1')!
    await expect(service.syncMemberPersonas('team-1')).rejects.toMatchObject({
      code: 'ASSISTANT_NOT_FOUND',
      message: expect.stringContaining('Bob'),
    })
    expect(store.getTeam('team-1')).toEqual(before)
    expect(leaderTemplate.name).toBe('Alice')
  })

  it('异常-AC8 成员忙碌时 MEMBER_BUSY 且快照与 revision 不变', async () => {
    const { service, store } = createHarness()
    const team = await seedActiveTeam(store)
    await store.updateAssistant('assistant-member', current => ({
      ...current,
      name: 'Bobby',
      revision: 2,
      updatedAt: '2026-09-17T01:00:00.000Z',
    }))
    await store.updateTeam('team-1', current => ({
      ...current,
      members: {
        ...current.members,
        'slot-member': { ...current.members['slot-member']!, lastRuntimeState: 'running' },
      },
    }))
    const before = store.getTeam('team-1')!

    await expect(service.syncMemberPersonas('team-1')).rejects.toMatchObject({ code: 'MEMBER_BUSY' })
    expect(store.getTeam('team-1')).toEqual(before)
  })

  it('异常-任务 running 时 MEMBER_BUSY', async () => {
    const { service, store } = createHarness()
    await seedActiveTeam(store)
    await store.updateTeam('team-1', current => ({
      ...current,
      tasks: { 'task-1': taskFixture('task-1', 'running') },
    }))

    await expect(service.syncMemberPersonas('team-1')).rejects.toMatchObject({ code: 'MEMBER_BUSY' })
  })

  it('边界-AC10 移除中成员不参与同步', async () => {
    const { service, store } = createHarness()
    await seedActiveTeam(store)
    await store.updateAssistant('assistant-member', current => ({
      ...current,
      name: 'Bobby',
      revision: 2,
      updatedAt: '2026-09-17T01:00:00.000Z',
    }))
    await store.updateTeam('team-1', current => ({
      ...current,
      members: {
        ...current.members,
        'slot-member': { ...current.members['slot-member']!, desiredState: 'removing' },
      },
    }))

    const result = await service.syncMemberPersonas('team-1')

    expect(result.refreshedCount).toBe(0)
    expect(result.team.members['slot-member']!.displayName).toBe('Bob')
  })

  it('异常-非 active 团队返回 TEAM_NOT_ACTIVE', async () => {
    const { service, store } = createHarness()
    await seedActiveTeam(store)
    await store.updateTeam('team-1', current => ({ ...current, state: 'draft' }))

    await expect(service.syncMemberPersonas('team-1')).rejects.toMatchObject({ code: 'TEAM_NOT_ACTIVE' })
  })

  it('异常-团队不存在返回 TEAM_NOT_FOUND', async () => {
    const { service } = createHarness()
    await expect(service.syncMemberPersonas('missing')).rejects.toMatchObject({ code: 'TEAM_NOT_FOUND' })
  })

  it('幂等-重复同步第二次为 no-op', async () => {
    const { service, store } = createHarness()
    const team = await seedActiveTeam(store)
    await store.updateAssistant('assistant-member', current => ({
      ...current,
      name: 'Bobby',
      revision: 2,
      updatedAt: '2026-09-17T01:00:00.000Z',
    }))

    const first = await service.syncMemberPersonas('team-1')
    const afterFirst = store.getTeam('team-1')!
    const second = await service.syncMemberPersonas('team-1')

    expect(first.refreshedCount).toBe(1)
    expect(second.refreshedCount).toBe(0)
    expect(store.getTeam('team-1')!.revision).toBe(afterFirst.revision)
  })
})

describe('countDriftedMembers', () => {
  it('正常-按最新模板逐成员计数漂移', async () => {
    const { store } = createHarness()
    const team = await seedActiveTeam(store)
    await store.updateAssistant('assistant-member', current => ({
      ...current,
      name: 'Bobby',
      revision: 2,
      updatedAt: '2026-09-17T01:00:00.000Z',
    }))
    const assistants = store.listAssistants()

    expect(countDriftedMembers(team, assistants)).toBe(1)
  })

  it('边界-无漂移/移除中成员/模板已删除时不计入', async () => {
    const { store } = createHarness()
    const team = await seedActiveTeam(store)
    expect(countDriftedMembers(team, store.listAssistants())).toBe(0)

    const removing = {
      ...team,
      members: {
        ...team.members,
        'slot-member': { ...team.members['slot-member']!, desiredState: 'removing' as const },
      },
    }
    expect(countDriftedMembers(removing, store.listAssistants())).toBe(0)

    await store.deleteAssistant('assistant-member')
    expect(countDriftedMembers(team, store.listAssistants())).toBe(0)
  })
})

describe('AgentTeamService.refreshMemberSnapshots（回归：运行时既有路径行为不变）', () => {
  it('异常-F1 回调内重算：requireTeam 与写入之间成员状态并发变更不被旧值回退', async () => {
    const { store } = createHarness()
    await seedActiveTeam(store)
    await store.updateAssistant('assistant-member', current => ({
      ...current,
      name: 'Bobby',
      revision: 2,
      updatedAt: '2026-09-17T01:00:00.000Z',
    }))

    const base = store
    // 模拟并发写者：在 refresh 的 update 回调执行前，成员已转为 running（真实存储中
    // 该变更与刷新写入经同一 KvTable.update 串行，回调看到的 current 必含并发变更）。
    const guardedStore = Object.assign(Object.create(base), {
      updateTeam(id: string, update: (current: TeamAggregate) => TeamAggregate): Promise<TeamAggregate> {
        const current = base.getTeam(id)
        if (current === undefined) return Promise.reject(new Error(`team '${id}' not found`))
        const concurrent = {
          ...current,
          members: {
            ...current.members,
            'slot-member': { ...current.members['slot-member']!, lastRuntimeState: 'running' as const },
          },
        }
        void base.putTeam(concurrent)
        const next = update(concurrent)
        void base.putTeam(next)
        return Promise.resolve(next)
      },
    })
    const service = new AgentTeamService(new Context(), config, guardedStore)

    const refreshed = await service.refreshMemberSnapshots('team-1')

    expect(refreshed.members['slot-member']!.displayName).toBe('Bobby')
    expect(refreshed.members['slot-member']!.lastRuntimeState).toBe('running')
  })

  it('有漂移时刷新并返回聚合，no-op 时原样返回', async () => {
    const { service, store } = createHarness()
    await seedActiveTeam(store)
    await store.updateAssistant('assistant-member', current => ({
      ...current,
      name: 'Bobby',
      revision: 2,
      updatedAt: '2026-09-17T01:00:00.000Z',
    }))

    const refreshed = await service.refreshMemberSnapshots('team-1')
    expect(refreshed.members['slot-member']!.displayName).toBe('Bobby')

    const after = await service.refreshMemberSnapshots('team-1')
    expect(after.revision).toBe(refreshed.revision)
  })

  it('模板缺失时抛 ASSISTANT_NOT_FOUND（启动路径既有行为）', async () => {
    const { service, store } = createHarness()
    await seedActiveTeam(store)
    await store.deleteAssistant('assistant-member')

    await expect(service.refreshMemberSnapshots('team-1')).rejects.toBeInstanceOf(AgentTeamError)
  })
})
