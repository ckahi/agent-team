import { describe, expect, it } from 'vitest'
import {
  initialVisibleMemberSlots,
  reconcileVisibleMemberSlots,
  sortMembersLeaderFirst,
  toggleVisibleMemberSlot,
} from '../src/client/member-visibility.js'

describe('team member visibility', () => {
  it('opens every team member without a three-column cap', () => {
    expect(initialVisibleMemberSlots(['leader', 'member-1', 'member-2', 'member-3'])).toEqual([
      'leader',
      'member-1',
      'member-2',
      'member-3',
    ])
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
