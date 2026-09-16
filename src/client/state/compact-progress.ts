import { useSyncExternalStore } from 'react'

/** 单个成员在 /team-compact 过程中的压缩进度状态。 */
export type CompactMemberProgressState = 'pending' | 'compacting' | 'done' | 'skipped'

export interface CompactMemberProgress {
  slotId: string
  displayName: string
  state: CompactMemberProgressState
  /** state === 'skipped' 时的跳过原因（busy / 未在线 / 失败信息）。 */
  reason?: string
}

export interface CompactRunProgress {
  /** 本轮压缩所属团队；消费端必须比对 team.id，防止跨团队 slotId 碰撞误显 badge（P-1）。 */
  teamId: string
  /** 发起 /team-compact 的成员（Leader 列）slotId，进度横幅只在该列渲染。 */
  initiatorSlotId: string
  members: CompactMemberProgress[]
}

export interface CompactProgressSummary {
  compacted: number
  skipped: number
  processed: number
  current: CompactMemberProgress | undefined
}

let run: CompactRunProgress | undefined
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

function mutateMember(slotId: string, mutate: (member: CompactMemberProgress) => CompactMemberProgress): void {
  if (run === undefined) return
  const index = run.members.findIndex(member => member.slotId === slotId)
  if (index < 0) return
  const next = mutate(run.members[index]!)
  if (next === run.members[index]) return
  const members = run.members.slice()
  members[index] = next
  run = { ...run, members }
  notify()
}

/** 开始一轮 /team-compact，覆盖可能残留的上一轮状态；roster 顺序即压缩顺序。 */
export function beginCompactRun(
  teamId: string,
  initiatorSlotId: string,
  roster: ReadonlyArray<{ slotId: string; displayName: string }>,
): void {
  run = {
    teamId,
    initiatorSlotId,
    members: roster.map(entry => ({ slotId: entry.slotId, displayName: entry.displayName, state: 'pending' })),
  }
  notify()
}

/** 消费端过滤：run 属于当前团队才视为有效进度（跨团队 slotId 碰撞时丢弃）。 */
export function isRunForTeam(target: CompactRunProgress | undefined, teamId: string): target is CompactRunProgress {
  return target !== undefined && target.teamId === teamId
}

export function markMemberCompacting(slotId: string): void {
  mutateMember(slotId, member => {
    if (member.state === 'compacting') return member
    return { slotId: member.slotId, displayName: member.displayName, state: 'compacting' }
  })
}

export function markMemberSucceeded(slotId: string): void {
  mutateMember(slotId, member => {
    if (member.state === 'done') return member
    return { slotId: member.slotId, displayName: member.displayName, state: 'done' }
  })
}

export function markMemberSkipped(slotId: string, reason: string): void {
  mutateMember(slotId, member => member.state === 'skipped' && member.reason === reason
    ? member
    : { ...member, state: 'skipped', reason })
}

/** 结束并清除本轮压缩状态（徽标与进度横幅随之消失，汇总由调用方以 notice 呈现）。 */
export function endCompactRun(): void {
  if (run === undefined) return
  run = undefined
  notify()
}

export function getCompactRun(): CompactRunProgress | undefined {
  return run
}

export function compactProgressSummary(target: CompactRunProgress): CompactProgressSummary {
  let compacted = 0
  let skipped = 0
  for (const member of target.members) {
    if (member.state === 'done') compacted += 1
    if (member.state === 'skipped') skipped += 1
  }
  return {
    compacted,
    skipped,
    processed: compacted + skipped,
    current: target.members.find(member => member.state === 'compacting'),
  }
}

export function subscribeCompactProgress(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** React 绑定：工作台任意组件订阅当前压缩进度（无进行中轮次时为 undefined）。 */
export function useCompactRun(): CompactRunProgress | undefined {
  return useSyncExternalStore(subscribeCompactProgress, getCompactRun, getCompactRun)
}
