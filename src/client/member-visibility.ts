export function sortMembersLeaderFirst<T extends { role: string }>(members: readonly T[]): T[] {
  return [...members].sort((first, second) => Number(second.role === 'leader') - Number(first.role === 'leader'))
}

export function initialVisibleMemberSlots(memberIds: readonly string[], leaderSlotId?: string): string[] {
  if (leaderSlotId !== undefined && memberIds.includes(leaderSlotId)) return [leaderSlotId]
  return [...memberIds]
}

/** 新建团队默认视图：全员展开，Leader 置顶（成员声明序保持不变）。 */
export function initialAllMemberSlots(memberIds: readonly string[], leaderSlotId?: string): string[] {
  if (leaderSlotId === undefined) return [...memberIds]
  return [...memberIds.filter(slotId => slotId === leaderSlotId), ...memberIds.filter(slotId => slotId !== leaderSlotId)]
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
const NEW_TEAM_DEFAULTS_STORAGE_KEY_PREFIX = 'agent-team:workbench:new-team-defaults:'
const ONLY_ACTIVE_TEAM_STORAGE_KEY_PREFIX = 'agent-team:workbench:only-active:'
const ONLY_ACTIVE_LEGACY_STORAGE_KEY = 'agent-team:workbench:only-active'

interface SafeStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem?(key: string): void
}

function workbenchVisibilityStorageKey(teamId: string): string {
  return `${WORKBENCH_VISIBILITY_STORAGE_KEY_PREFIX}${teamId}`
}

function workbenchOnlyActiveStorageKey(teamId: string): string {
  return `${ONLY_ACTIVE_TEAM_STORAGE_KEY_PREFIX}${teamId}`
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

function removeStorageItem(storage: SafeStorage, key: string): void {
  try {
    storage.removeItem?.(key)
  } catch {
    // 忽略移除失败：残留标记只会让默认值再应用一次，无害
  }
}

/** 标记一个刚创建的团队：首次打开工作台时应用「全员展开 + 只看活跃」默认值。 */
export function markNewTeamWorkbenchDefaults(teamId: string): void {
  const storage = safeLocalStorage()
  if (storage === undefined) return
  try {
    storage.setItem(`${NEW_TEAM_DEFAULTS_STORAGE_KEY_PREFIX}${teamId}`, 'true')
  } catch {
    // 标记写入失败时退化为旧默认值（仅 Leader），不阻塞建队流程
  }
}

export interface WorkbenchDefaults {
  visibleSlots: string[]
  onlyActive: boolean
}

/**
 * 计算某团队工作台的初始显隐与「只看活跃」偏好。
 * 新建团队（带标记）：消费标记并持久化全员展开 + 只看活跃勾选；其余团队（存量）行为不变。
 */
export function initializeWorkbenchNewTeamDefaults(
  teamId: string,
  memberIds: readonly string[],
  leaderSlotId?: string,
): WorkbenchDefaults {
  const storage = safeLocalStorage()
  const markerKey = `${NEW_TEAM_DEFAULTS_STORAGE_KEY_PREFIX}${teamId}`
  const isNewTeam = storage !== undefined && (() => {
    try {
      return storage.getItem(markerKey) === 'true'
    } catch {
      return false
    }
  })()
  if (!isNewTeam) {
    return {
      visibleSlots: loadWorkbenchVisibleSlots(teamId, memberIds, leaderSlotId),
      onlyActive: loadOnlyActivePreference(teamId),
    }
  }
  if (storage !== undefined) removeStorageItem(storage, markerKey)
  // 默认值只填空白：若该团队已有持久化偏好（异常时序下标记残留），以已存偏好为准，不做覆盖
  const hasSavedSlots = (() => {
    try {
      return storage?.getItem(workbenchVisibilityStorageKey(teamId)) !== null
    } catch {
      return false
    }
  })()
  const hasSavedOnlyActive = (() => {
    try {
      return storage?.getItem(workbenchOnlyActiveStorageKey(teamId)) !== null
    } catch {
      return false
    }
  })()
  if (!hasSavedSlots) {
    const visibleSlots = initialAllMemberSlots(memberIds, leaderSlotId)
    saveWorkbenchVisibleSlots(teamId, visibleSlots)
  }
  if (!hasSavedOnlyActive) saveOnlyActivePreference(teamId, true)
  return {
    visibleSlots: loadWorkbenchVisibleSlots(teamId, memberIds, leaderSlotId),
    onlyActive: loadOnlyActivePreference(teamId),
  }
}

/** 读取「只看活跃」偏好：按团队优先，其次历史全局偏好（存量团队保持原行为），缺省 false。 */
export function loadOnlyActivePreference(teamId: string): boolean {
  const storage = safeLocalStorage()
  if (storage === undefined) return false
  try {
    const teamRaw = storage.getItem(workbenchOnlyActiveStorageKey(teamId))
    if (teamRaw !== null) return teamRaw === 'true'
    return storage.getItem(ONLY_ACTIVE_LEGACY_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

/** 持久化某团队「只看活跃」偏好（按团队隔离）；存储失败静默忽略。 */
export function saveOnlyActivePreference(teamId: string, value: boolean): void {
  const storage = safeLocalStorage()
  if (storage === undefined) return
  try {
    storage.setItem(workbenchOnlyActiveStorageKey(teamId), value ? 'true' : 'false')
  } catch {
    // 忽略存储写入失败（隐私模式 / 配额限制），偏好退化为会话内状态
  }
}
