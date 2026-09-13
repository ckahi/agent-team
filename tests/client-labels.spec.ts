import { describe, expect, it } from 'vitest'
import { PERMISSION_LABELS, TASK_STATE_LABELS, taskStatusLabel, teamStartErrorHint } from '../src/client/labels.js'
import { teamTaskSchema } from '../src/domain/schemas.js'

describe('taskStatusLabel', () => {
  it.each([
    ['pending', '待处理'],
    ['assigned', '已分配'],
    ['running', '进行中'],
    ['blocked', '受阻'],
    ['completed', '已完成'],
    ['failed', '失败'],
    ['cancelled', '已取消'],
  ])('maps %s to its Chinese label', (status, label) => {
    expect(taskStatusLabel(status)).toBe(label)
  })

  it.each(['paused', 'unknown_state', ''])('returns an unknown status %j as-is', status => {
    expect(taskStatusLabel(status)).toBe(status)
  })

  it('keeps TASK_STATE_LABELS intact', () => {
    expect(TASK_STATE_LABELS).toEqual({
      pending: '待处理',
      assigned: '已分配',
      running: '进行中',
      blocked: '受阻',
      completed: '已完成',
      failed: '失败',
      cancelled: '已取消',
    })
  })

  it('keeps TASK_STATE_LABELS keys in sync with the domain schema status enum', () => {
    const schemaStatuses = [...teamTaskSchema.shape.status.options].sort()
    expect(Object.keys(TASK_STATE_LABELS).sort()).toEqual(schemaStatuses)
  })

  it('keeps PERMISSION_LABELS intact', () => {
    expect(PERMISSION_LABELS).toEqual({
      'read-only': '只读',
      'workspace-write': '工作区可写',
      'danger-full-access': '完全访问',
    })
  })
})

describe('teamStartErrorHint', () => {
  it('returns the preset-specific guidance for PRESET_PROMPT_INCOMPATIBLE', () => {
    const hint = teamStartErrorHint('PRESET_PROMPT_INCOMPATIBLE')
    expect(hint).toContain('Agent Preset')
    expect(hint).toContain('重试')
    expect(hint).toContain('最新配置')
  })

  it.each([undefined, 'WORKSPACE_UNAVAILABLE', 'SOME_FUTURE_CODE'])(
    'falls back to the generic guidance for %j',
    code => {
      expect(teamStartErrorHint(code)).toBe(teamStartErrorHint(undefined))
      expect(teamStartErrorHint(code)).toContain('重试')
    },
  )
})
