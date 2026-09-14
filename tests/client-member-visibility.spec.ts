import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  initialVisibleMemberSlots,
  loadWorkbenchVisibleSlots,
  reconcileVisibleMemberSlots,
  saveWorkbenchVisibleSlots,
  sortMembersLeaderFirst,
  toggleVisibleMemberSlot,
} from '../src/client/member-visibility.js'

describe('team member visibility', () => {
  it('defaults to the leader chat column only on first entry', () => {
    expect(initialVisibleMemberSlots(['leader', 'member-1', 'member-2', 'member-3'], 'leader')).toEqual(['leader'])
  })

  it('falls back to every member when no leader slot id is given', () => {
    expect(initialVisibleMemberSlots(['leader', 'member-1', 'member-2'])).toEqual([
      'leader',
      'member-1',
      'member-2',
    ])
  })

  it('falls back to every member when the leader slot id is not part of the team', () => {
    expect(initialVisibleMemberSlots(['leader', 'member-1'], 'someone-else')).toEqual(['leader', 'member-1'])
  })

  it('keeps every selected member when another member is shown', () => {
    expect(toggleVisibleMemberSlot(['leader', 'member-1', 'member-2'], 'member-3')).toEqual([
      'leader',
      'member-1',
      'member-2',
      'member-3',
    ])
  })

  it('automatically shows a newly added member without restoring intentionally hidden members', () => {
    expect(reconcileVisibleMemberSlots(
      ['leader', 'member-2'],
      ['leader', 'member-1', 'member-2'],
      ['leader', 'member-1', 'member-2', 'member-3'],
    )).toEqual(['leader', 'member-2', 'member-3'])
  })
})

describe('sortMembersLeaderFirst', () => {
  it('places the leader first while keeping the other members in their original order', () => {
    expect(sortMembersLeaderFirst([
      { id: 'm1', role: 'member' },
      { id: 'leader', role: 'leader' },
      { id: 'm2', role: 'member' },
    ]).map(member => member.id)).toEqual(['leader', 'm1', 'm2'])
  })

  it('keeps the original order when no member is a leader', () => {
    expect(sortMembersLeaderFirst([
      { id: 'm2', role: 'member' },
      { id: 'm1', role: 'member' },
    ]).map(member => member.id)).toEqual(['m2', 'm1'])
  })

  it('keeps the order when the leader is already first', () => {
    expect(sortMembersLeaderFirst([
      { id: 'leader', role: 'leader' },
      { id: 'm1', role: 'member' },
    ]).map(member => member.id)).toEqual(['leader', 'm1'])
  })

  it('does not mutate the input array', () => {
    const members = [{ id: 'm1', role: 'member' }, { id: 'leader', role: 'leader' }]
    sortMembersLeaderFirst(members)
    expect(members.map(member => member.id)).toEqual(['m1', 'leader'])
  })
})

describe('reconcileVisibleMemberSlots with a leader', () => {
  it('reorders the visible columns after a leader change while keeping the other members in order', () => {
    expect(reconcileVisibleMemberSlots(
      ['old-leader', 'm1', 'm2'],
      ['old-leader', 'm1', 'm2'],
      ['m1', 'old-leader', 'm2'],
      'm1',
    )).toEqual(['m1', 'old-leader', 'm2'])
  })

  it('keeps intentionally hidden members hidden when the leader changes', () => {
    expect(reconcileVisibleMemberSlots(
      ['old-leader', 'm1'],
      ['old-leader', 'm1', 'm2'],
      ['m1', 'old-leader', 'm2'],
      'm1',
    )).toEqual(['m1', 'old-leader'])
  })

  it('appends a newly added member after the existing ones behind the leader', () => {
    expect(reconcileVisibleMemberSlots(
      ['leader', 'm1'],
      ['leader', 'm1'],
      ['leader', 'm1', 'm2'],
      'leader',
    )).toEqual(['leader', 'm1', 'm2'])
  })

  it('keeps the order untouched when the leader is not among the visible members', () => {
    expect(reconcileVisibleMemberSlots(
      ['m1', 'm2'],
      ['leader', 'm1', 'm2'],
      ['leader', 'm1', 'm2'],
      'leader',
    )).toEqual(['m1', 'm2'])
  })

  it('falls back to the leader-first full member list when nothing is visible', () => {
    expect(reconcileVisibleMemberSlots(
      [],
      ['leader', 'm1'],
      ['leader', 'm1'],
      'leader',
    )).toEqual(['leader', 'm1'])
  })
})

describe('workbench visible-slot persistence', () => {
  const store = new Map<string, string>()

  function stubWindowLocalStorage(): void {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => { store.set(key, value) },
      },
    })
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    store.clear()
  })

  it('returns the leader-only default when nothing has been stored yet', () => {
    stubWindowLocalStorage()
    expect(loadWorkbenchVisibleSlots('team-1', ['leader', 'm1', 'm2'], 'leader')).toEqual(['leader'])
  })

  it('returns the leader-only default when localStorage is unavailable', () => {
    expect(loadWorkbenchVisibleSlots('team-1', ['leader', 'm1'], 'leader')).toEqual(['leader'])
  })

  it('restores stored slots filtered to current members with the leader first', () => {
    stubWindowLocalStorage()
    store.set('agent-team:workbench:visible-slots:team-1', JSON.stringify(['m2', 'gone', 'leader', 'm1']))
    expect(loadWorkbenchVisibleSlots('team-1', ['leader', 'm1', 'm2'], 'leader')).toEqual(['leader', 'm2', 'm1'])
  })

  it('falls back to the default when the stored value is not a slot array', () => {
    stubWindowLocalStorage()
    store.set('agent-team:workbench:visible-slots:team-1', '{"broken": true}')
    expect(loadWorkbenchVisibleSlots('team-1', ['leader', 'm1'], 'leader')).toEqual(['leader'])
  })

  it('falls back to the default when every stored slot has left the team', () => {
    stubWindowLocalStorage()
    store.set('agent-team:workbench:visible-slots:team-1', JSON.stringify(['gone-1', 'gone-2']))
    expect(loadWorkbenchVisibleSlots('team-1', ['leader', 'm1'], 'leader')).toEqual(['leader'])
  })

  it('deduplicates stored slots so corrupted data cannot render duplicate columns', () => {
    stubWindowLocalStorage()
    store.set('agent-team:workbench:visible-slots:team-1', JSON.stringify(['m1', 'm1', 'leader', 'leader', 'm1']))
    expect(loadWorkbenchVisibleSlots('team-1', ['leader', 'm1'], 'leader')).toEqual(['leader', 'm1'])
  })

  it('round-trips a customized selection through save and load', () => {
    stubWindowLocalStorage()
    saveWorkbenchVisibleSlots('team-1', ['m1', 'leader'])
    expect(loadWorkbenchVisibleSlots('team-1', ['leader', 'm1', 'm2'], 'leader')).toEqual(['leader', 'm1'])
  })

  it('keeps separate selections per team', () => {
    stubWindowLocalStorage()
    saveWorkbenchVisibleSlots('team-1', ['m1'])
    saveWorkbenchVisibleSlots('team-2', ['leader', 'm2'])
    expect(loadWorkbenchVisibleSlots('team-1', ['leader', 'm1', 'm2'], 'leader')).toEqual(['m1'])
    expect(loadWorkbenchVisibleSlots('team-2', ['leader', 'm1', 'm2'], 'leader')).toEqual(['leader', 'm2'])
  })

  it('ignores storage write failures when saving', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => null,
        setItem: () => { throw new Error('quota exceeded') },
      },
    })
    expect(() => saveWorkbenchVisibleSlots('team-1', ['leader'])).not.toThrow()
  })

  it('falls back to the default when stored JSON cannot be parsed at all', () => {
    stubWindowLocalStorage()
    store.set('agent-team:workbench:visible-slots:team-1', 'not-json')
    expect(loadWorkbenchVisibleSlots('team-1', ['leader', 'm1'], 'leader')).toEqual(['leader'])
  })
})
