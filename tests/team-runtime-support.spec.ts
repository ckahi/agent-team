import { describe, expect, it } from 'vitest'
import { AgentTeamError } from '../src/domain/errors.js'
import type { TeamAggregate, TeamMemberSlot } from '../src/domain/types.js'
import {
  assertCompactCaller,
  compactTeamMembers,
} from '../src/runtime/team-runtime.js'
import {
  assignmentContent,
  requireMessageContent,
  taskMessageType,
  teamMessageHeader,
} from '../src/runtime/team-messages.js'
import { memberPrompt, rosterPrompt } from '../src/runtime/team-prompts.js'

describe('team runtime support', () => {
  it('builds identity and roster prompts with stable member ids', () => {
    const leader = member('leader-slot', 'Code Leader', 'leader')
    const coder = member('coder-slot', 'Coder', 'member')
    const team = {
      id: 'team-1',
      name: 'Compiler Team',
      leaderSlotId: leader.id,
      members: { [leader.id]: leader, [coder.id]: coder },
    } as unknown as TeamAggregate

    expect(memberPrompt(team, coder)).toContain('You are Coder')
    expect(memberPrompt(team, coder)).toContain('Implement assigned code.')
    expect(rosterPrompt(team)).toContain('Code Leader (leader), slotId=leader-slot')
    expect(rosterPrompt(team)).toContain('Coder (member), slotId=coder-slot')
  })

  it('normalizes messages and maps task states to message types', () => {
    expect(requireMessageContent('  ready  ')).toBe('ready')
    expect(() => requireMessageContent('   ')).toThrow(AgentTeamError)
    expect(teamMessageHeader('Coder', 'coder-slot')).toBe(
      '[Team message from Coder; slotId=coder-slot]',
    )
    expect(assignmentContent('Parser', 'Implement it.', ['src/parser.ts'])).toContain(
      'File scopes: src/parser.ts',
    )
    expect(taskMessageType('completed')).toBe('result')
    expect(taskMessageType('blocked')).toBe('question')
    expect(taskMessageType('failed')).toBe('warning')
    expect(taskMessageType('running')).toBe('progress')
  })
})

describe('/team-compact caller validation', () => {
  const team = {
    name: 'Compiler Team',
    leaderSlotId: 'leader-slot',
  } as unknown as TeamAggregate

  it('accepts the leader slot', () => {
    expect(() => assertCompactCaller(team, 'leader-slot')).not.toThrow()
  })

  it('rejects non-leader slots', () => {
    expect(() => assertCompactCaller(team, 'coder-slot')).toThrow(AgentTeamError)
    expect(() => assertCompactCaller(team, '')).toThrow(/仅队长/)
  })
})

describe('compactTeamMembers', () => {
  const members = [
    member('leader-slot', 'Code Leader', 'leader'),
    member('coder-slot', 'Coder', 'member'),
    member('writer-slot', 'Writer', 'member'),
  ] as unknown as TeamMemberSlot[]

  it('separates compacted members from skipped busy members without throwing', async () => {
    const summary = await compactTeamMembers(members, async current => {
      if (current.id === 'coder-slot') return { ok: false, reason: 'busy' }
      if (current.id === 'writer-slot') throw new Error('command exploded')
      return { ok: true }
    })

    expect(summary.compacted).toEqual([
      { slotId: 'leader-slot', displayName: 'Code Leader' },
    ])
    expect(summary.skipped).toEqual([
      { slotId: 'coder-slot', displayName: 'Coder', reason: 'busy' },
      { slotId: 'writer-slot', displayName: 'Writer', reason: 'command exploded' },
    ])
  })

  it('continues after a skipped member and defaults missing reasons', async () => {
    const summary = await compactTeamMembers(members, async current =>
      current.id === 'leader-slot' ? { ok: false } : { ok: true })

    expect(summary.compacted.map(entry => entry.slotId)).toEqual(['coder-slot', 'writer-slot'])
    expect(summary.skipped).toEqual([
      { slotId: 'leader-slot', displayName: 'Code Leader', reason: '未知原因' },
    ])
  })
})

function member(id: string, displayName: string, role: 'leader' | 'member'): TeamMemberSlot {
  return {
    id,
    displayName,
    role,
    assistantSnapshot: {
      instructions: 'Implement assigned code.',
    },
  } as unknown as TeamMemberSlot
}
