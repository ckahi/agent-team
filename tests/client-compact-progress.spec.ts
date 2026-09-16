import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  beginCompactRun,
  compactProgressSummary,
  endCompactRun,
  getCompactRun,
  isRunForTeam,
  markMemberCompacting,
  markMemberSkipped,
  markMemberSucceeded,
  subscribeCompactProgress,
} from '../src/client/state/compact-progress.js'

const ROSTER = [
  { slotId: 'leader-1', displayName: '队长' },
  { slotId: 'dev-1', displayName: '研发' },
  { slotId: 'qa-1', displayName: '测试' },
]

describe('compact-progress 状态存储', () => {
  beforeEach(() => {
    endCompactRun()
  })

  afterEach(() => {
    endCompactRun()
  })

  it('正常路径-beginCompactRun 后全员 pending，可推进到 compacting/done', () => {
    beginCompactRun('team-1', 'leader-1', ROSTER)
    const run = getCompactRun()
    expect(run).not.toBeNull()
    expect(run?.teamId).toBe('team-1')
    expect(run?.initiatorSlotId).toBe('leader-1')
    expect(run?.members.map(member => member.state)).toEqual(['pending', 'pending', 'pending'])

    markMemberCompacting('dev-1')
    expect(getCompactRun()?.members[1]).toMatchObject({ slotId: 'dev-1', state: 'compacting' })

    markMemberSucceeded('dev-1')
    expect(getCompactRun()?.members[1]).toMatchObject({ slotId: 'dev-1', state: 'done' })
  })

  it('边界-重复 beginCompactRun 覆盖上一轮且成员顺序保持 roster 原序', () => {
    beginCompactRun('team-1', 'leader-1', ROSTER)
    markMemberSucceeded('leader-1')
    beginCompactRun('team-1', 'leader-1', [...ROSTER].reverse())
    const run = getCompactRun()
    expect(run?.members.map(member => member.slotId)).toEqual(['qa-1', 'dev-1', 'leader-1'])
    expect(run?.members.every(member => member.state === 'pending')).toBe(true)
  })

  it('异常-未知 slotId 的推进调用不生效', () => {
    beginCompactRun('team-1', 'leader-1', ROSTER)
    markMemberCompacting('ghost')
    markMemberSucceeded('ghost')
    markMemberSkipped('ghost', '成员未在线')
    expect(getCompactRun()?.members.every(member => member.state === 'pending')).toBe(true)
  })

  it('异常-未开始时推进调用安全无副作用', () => {
    expect(getCompactRun()).toBeUndefined()
    expect(() => markMemberCompacting('dev-1')).not.toThrow()
    expect(() => markMemberSucceeded('dev-1')).not.toThrow()
    expect(() => markMemberSkipped('dev-1', 'busy')).not.toThrow()
    expect(getCompactRun()).toBeUndefined()
  })

  it('skip 原因被记录', () => {
    beginCompactRun('team-1', 'leader-1', ROSTER)
    markMemberSkipped('qa-1', '成员未在线')
    expect(getCompactRun()?.members[2]).toMatchObject({ slotId: 'qa-1', state: 'skipped', reason: '成员未在线' })
  })

  it('endCompactRun 清除全部状态，不留残留', () => {
    beginCompactRun('team-1', 'leader-1', ROSTER)
    markMemberSucceeded('leader-1')
    endCompactRun()
    expect(getCompactRun()).toBeUndefined()
  })

  it('汇总-compactProgressSummary 统计完成/跳过/当前成员', () => {
    beginCompactRun('team-1', 'leader-1', ROSTER)
    markMemberSucceeded('leader-1')
    markMemberSkipped('dev-1', '成员忙碌')
    markMemberCompacting('qa-1')
    const run = getCompactRun()
    expect(compactProgressSummary(run!)).toEqual({
      compacted: 1,
      skipped: 1,
      processed: 2,
      current: { slotId: 'qa-1', displayName: '测试', state: 'compacting', reason: undefined },
    })
  })

  it('汇总-空 roster 的 current 为 undefined', () => {
    beginCompactRun('team-1', 'leader-1', [])
    expect(compactProgressSummary(getCompactRun()!)).toEqual({
      compacted: 0,
      skipped: 0,
      processed: 0,
      current: undefined,
    })
  })

  it('订阅-每次变更通知订阅者，endCompactRun 后停止通知', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeCompactProgress(listener)
    beginCompactRun('team-1', 'leader-1', ROSTER)
    markMemberCompacting('dev-1')
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    endCompactRun()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('幂等-同一成员重复推进不产生多余通知', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeCompactProgress(listener)
    beginCompactRun('team-1', 'leader-1', ROSTER)
    listener.mockClear()
    markMemberCompacting('dev-1')
    markMemberCompacting('dev-1')
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('并行-允许多个成员同时处于 compacting，互不覆盖', () => {
    beginCompactRun('team-1', 'leader-1', ROSTER)
    // 并行语义：全员同时标记 compacting，不需要等前一成员 settle
    for (const entry of ROSTER) markMemberCompacting(entry.slotId)
    const states = getCompactRun()?.members.map(member => member.state)
    expect(states).toEqual(['compacting', 'compacting', 'compacting'])
    // 单成员先完成不影响其他成员的 compacting 状态
    markMemberSucceeded('dev-1')
    expect(getCompactRun()?.members.map(member => member.state)).toEqual(['compacting', 'done', 'compacting'])
  })

  it('隔离-isRunForTeam 对 teamId 不匹配的 run 返回 false（P-1 跨团队隔离）', () => {
    beginCompactRun('team-1', 'leader-1', ROSTER)
    const run = getCompactRun()
    expect(isRunForTeam(run, 'team-1')).toBe(true)
    expect(isRunForTeam(run, 'team-2')).toBe(false)
    expect(isRunForTeam(undefined, 'team-1')).toBe(false)
  })

  it('隔离-切换团队重开 run 后 teamId 随之更新', () => {
    beginCompactRun('team-1', 'leader-1', [{ slotId: 'leader-1', displayName: '甲队队长' }])
    beginCompactRun('team-2', 'leader-1', [{ slotId: 'leader-1', displayName: '乙队队长' }])
    const run = getCompactRun()
    expect(run?.teamId).toBe('team-2')
    expect(isRunForTeam(run, 'team-1')).toBe(false)
    expect(isRunForTeam(run, 'team-2')).toBe(true)
  })
})
