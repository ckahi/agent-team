import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  AGENT_TEAM_METHODS,
  type AgentTeamPayload,
  type AgentTeamResult,
  type WorkspaceEntryView,
  type WorkspaceGitDiffView,
} from '../src/transport/contracts.js'
import { teamAggregateSchema } from '../src/domain/schemas.js'

const baseAggregate = {
  schemaVersion: 1,
  id: 'team-1',
  name: 'Compat Team',
  workspaceId: 'workspace-1',
  workspacePath: '/tmp/agent-team-workspace',
  leaderSlotId: 'slot-1',
  state: 'error',
  directMemberChat: true,
  members: {},
  retiredSessions: {},
  tasks: {},
  leases: {},
  outbox: {},
  revision: 1,
  createdAt: '2026-09-13T00:00:00.000Z',
  updatedAt: '2026-09-13T00:00:00.000Z',
}

describe('Agent Team transport contracts', () => {
  it('keeps API method names unique', () => {
    expect(new Set(AGENT_TEAM_METHODS).size).toBe(AGENT_TEAM_METHODS.length)
  })

  it('associates Workspace methods with their payload and result types', () => {
    expectTypeOf<AgentTeamPayload<'team.workspace.diff'>>().toEqualTypeOf<{
      teamId: string
      path: string
      scope: 'staged' | 'unstaged'
      layout: 'unified' | 'split'
      theme: 'light' | 'dark'
    }>()
    expectTypeOf<AgentTeamResult<'team.workspace.diff'>>().toEqualTypeOf<WorkspaceGitDiffView>()
    expectTypeOf<AgentTeamResult<'team.workspace.list'>>().toEqualTypeOf<WorkspaceEntryView[]>()
  })

  it('parses a legacy aggregate without lastError', () => {
    expect(() => teamAggregateSchema.parse(baseAggregate)).not.toThrow()
  })

  it('parses lastError with a code while keeping schemaVersion 1', () => {
    const parsed = teamAggregateSchema.parse({
      ...baseAggregate,
      lastError: {
        code: 'PRESET_PROMPT_INCOMPATIBLE',
        message: 'Preset replaced Agent Team prompt sections',
        failedAt: '2026-09-13T00:00:00.000Z',
      },
    })
    expect(parsed.lastError).toMatchObject({ code: 'PRESET_PROMPT_INCOMPATIBLE' })
    expect(parsed.schemaVersion).toBe(1)
  })

  it('parses lastError without the optional code', () => {
    const parsed = teamAggregateSchema.parse({
      ...baseAggregate,
      lastError: { message: 'boom', failedAt: '2026-09-13T00:00:00.000Z' },
    })
    expect(parsed.lastError?.code).toBeUndefined()
    expect(parsed.lastError?.message).toBe('boom')
  })
})
