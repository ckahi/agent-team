export function sortMembersLeaderFirst<T extends { role: string }>(members: readonly T[]): T[] {
  return [...members].sort((first, second) => Number(second.role === 'leader') - Number(first.role === 'leader'))
}

export function initialVisibleMemberSlots(memberIds: readonly string[], leaderSlotId?: string): string[] {
  if (leaderSlotId !== undefined && memberIds.includes(leaderSlotId)) return [leaderSlotId]
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

const WORKBENCH_VISIBILITY_STORAGE_KEY_PREFIX = 'agent-team:workbench:visible-slots:'

interface SafeStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function workbenchVisibilityStorageKey(teamId: string): string {
  return `${WORKBENCH_VISIBILITY_STORAGE_KEY_PREFIX}${teamId}`
}

function safeLocalStorage(): SafeStorage | undefined {
  try {
    if (typeof window === 'undefined') return undefined
    return window.localStorage
  } catch {
    return undefined
  }
}

/**
 * 读取某团队工作台持久化的聊天框显隐设定。
 * 未存过 / 数据损坏 / 成员已全部离队时回退到默认值（仅 Leader）。
 */
export function loadWorkbenchVisibleSlots(
  teamId: string,
  memberIds: readonly string[],
  leaderSlotId?: string,
): string[] {
  const fallback = initialVisibleMemberSlots(memberIds, leaderSlotId)
  const storage = safeLocalStorage()
  if (storage === undefined) return fallback
  try {
    const raw = storage.getItem(workbenchVisibilityStorageKey(teamId))
    if (raw === null) return fallback
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return fallback
    const available = new Set(memberIds)
    const valid = [...new Set(parsed.filter((value): value is string => typeof value === 'string' && available.has(value)))]
    if (valid.length === 0) return fallback
    return leaderSlotId === undefined
      ? valid
      : [...valid.filter(slotId => slotId === leaderSlotId), ...valid.filter(slotId => slotId !== leaderSlotId)]
  } catch {
    return fallback
  }
}

/** 持久化某团队工作台的聊天框显隐设定；存储失败（如隐私模式配额受限）静默忽略。 */
export function saveWorkbenchVisibleSlots(teamId: string, slotIds: readonly string[]): void {
  const storage = safeLocalStorage()
  if (storage === undefined) return
  try {
    storage.setItem(workbenchVisibilityStorageKey(teamId), JSON.stringify([...slotIds]))
  } catch {
    // 忽略存储写入失败（隐私模式 / 配额限制），显隐设定退化为会话内状态
  }
}
