import { describe, expect, it } from 'vitest'
import { canRetryTeamStart, isTeamExecuting } from '../src/client/team-status.js'

describe('team execution status', () => {
  it('does not treat an idle or merely available team as executing', () => {
    expect(isTeamExecuting({
      members: { leader: { lastRuntimeState: 'idle' } },
      tasks: { task: { status: 'assigned' } },
    })).toBe(false)
  })

  it.each(['running', 'waiting_approval'])('treats a %s member as executing', lastRuntimeState => {
    expect(isTeamExecuting({
      members: { leader: { lastRuntimeState } },
      tasks: {},
    })).toBe(true)
  })

  it('treats a running task as executing even before the member projection refreshes', () => {
    expect(isTeamExecuting({
      members: { leader: { lastRuntimeState: 'idle' } },
      tasks: { task: { status: 'running' } },
    })).toBe(true)
  })
})

describe('canRetryTeamStart', () => {
  it('offers the retry entry only for a team in the error state', () => {
    expect(canRetryTeamStart('error')).toBe(true)
  })

  it.each(['draft', 'starting', 'active', 'deleting', 'delete_blocked', 'ownership_conflict'])(
    'does not offer the retry entry for a %s team',
    state => {
      expect(canRetryTeamStart(state)).toBe(false)
    },
  )
})
