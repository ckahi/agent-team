import { describe, expect, it } from 'vitest'
import {
  agentTeamAssistantsSpec,
  agentTeamRuntimeSpec,
  agentTeamStreamsSpec,
  legacyAgentTeamSpec,
} from '../src/storage/domain.js'

const UNIT_NAME_RE = /^[a-zA-Z0-9_-]+$/

/** defineDomain's projected type omits the optional layout; read it loosely. */
const layoutOf = (spec: unknown): string | undefined =>
  (spec as { layout?: string }).layout

describe('storage domain split specs', () => {
  it('正常-runtime 域声明（per-record：teams+operations）', () => {
    expect(agentTeamRuntimeSpec.name).toBe('agent_team_runtime')
    expect(agentTeamRuntimeSpec.version).toBe(1)
    expect(layoutOf(agentTeamRuntimeSpec)).toBe('per-record')
    expect(Object.keys(agentTeamRuntimeSpec.tables).sort()).toEqual(['operations', 'teams'])
  })

  it('正常-assistants 域声明（single）', () => {
    expect(agentTeamAssistantsSpec.name).toBe('agent_team_assistants')
    expect(agentTeamAssistantsSpec.version).toBe(1)
    expect(layoutOf(agentTeamAssistantsSpec)).toBeUndefined()
    expect(Object.keys(agentTeamAssistantsSpec.tables)).toEqual(['assistants'])
  })

  it('正常-streams 域声明（per-record：messages+activities+orphanMarks）', () => {
    expect(agentTeamStreamsSpec.name).toBe('agent_team_streams')
    expect(agentTeamStreamsSpec.version).toBe(1)
    expect(layoutOf(agentTeamStreamsSpec)).toBe('per-record')
    expect(Object.keys(agentTeamStreamsSpec.tables).sort()).toEqual([
      'activities',
      'messages',
      'orphan_marks',
    ])
  })

  it('正常-per-record 单元声明 invalidRecords=backup-and-skip；single 单元不声明（single 无 backupRecord，声明即 open 抛错）', () => {
    const invalidRecordsOf = (spec: unknown): string | undefined =>
      (spec as { invalidRecords?: string }).invalidRecords
    for (const spec of [agentTeamRuntimeSpec, agentTeamStreamsSpec]) {
      expect(invalidRecordsOf(spec), spec.name).toBe('backup-and-skip')
    }
    expect(invalidRecordsOf(agentTeamAssistantsSpec)).toBeUndefined()
    expect(invalidRecordsOf(legacyAgentTeamSpec)).toBeUndefined()
  })

  it('边界-新域名匹配 UNIT_NAME_RE', () => {
    for (const spec of [agentTeamRuntimeSpec, agentTeamAssistantsSpec, agentTeamStreamsSpec]) {
      expect(spec.name, spec.name).toMatch(UNIT_NAME_RE)
    }
  })

  it('正常-legacy spec 与现网逐项等价（防手滑改 schema）', () => {
    expect(legacyAgentTeamSpec.name).toBe('agent_team')
    expect(legacyAgentTeamSpec.version).toBe(1)
    expect(layoutOf(legacyAgentTeamSpec)).toBeUndefined()
    expect(legacyAgentTeamSpec).not.toHaveProperty('invalidRecords')
    expect(Object.keys(legacyAgentTeamSpec.tables).sort()).toEqual([
      'activities',
      'assistants',
      'messages',
      'operations',
      'teams',
    ])
  })
})
