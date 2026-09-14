export function sortMembersLeaderFirst<T extends { role: string }>(members: readonly T[]): T[] {
  return [...members].sort((first, second) => Number(second.role === 'leader') - Number(first.role === 'leader'))
}

export function initialVisibleMemberSlots(memberIds: readonly string[]): string[] {
  return [...memberIds]
}

export function reconcileVisibleMemberSlots(
  current: readonly string[],
  previousMemberIds: readonly string[],
  memberIds: readonly string[],
  leaderSlotId?: string,
): string[] {
  const available = new Set(memberIds)
  const previous = new Set(previousMemberIds)
  const valid = current.filter(slotId => available.has(slotId))
  const added = memberIds.filter(slotId => !previous.has(slotId))
  const next = [...new Set([...valid, ...added])]
  const ordered = leaderSlotId === undefined
    ? next
    : [...next.filter(slotId => slotId === leaderSlotId), ...next.filter(slotId => slotId !== leaderSlotId)]
  return ordered.length > 0 ? ordered : [...memberIds]
}

export function toggleVisibleMemberSlot(current: readonly string[], slotId: string): string[] {
  if (!current.includes(slotId)) return [...current, slotId]
  return current.length === 1 ? [...current] : current.filter(value => value !== slotId)
}
