import { describe, expect, it } from 'vitest'
import {
  createAgentTeamSessionId,
  isPathSafeSessionId,
} from '../src/runtime/session-id.js'

const PATH_SAFE_PATTERN = /^[a-zA-Z0-9_-]+$/

describe('createAgentTeamSessionId', () => {
  it('正常-生成 path-safe 会话键（满足宿主 per-record 域键约束）', () => {
    const sessionId = createAgentTeamSessionId()
    expect(PATH_SAFE_PATTERN.test(sessionId)).toBe(true)
    expect(sessionId.startsWith('agent-team-')).toBe(true)
  })

  it('正常-前缀后携带 UUID 主体，可用于区分会话', () => {
    const sessionId = createAgentTeamSessionId()
    const body = sessionId.slice('agent-team-'.length)
    expect(body).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('幂等性-连续生成不重复', () => {
    const ids = new Set(Array.from({ length: 64 }, () => createAgentTeamSessionId()))
    expect(ids.size).toBe(64)
  })

  it('边界-不含冒号等路径不安全字符', () => {
    for (let index = 0; index < 16; index += 1) {
      expect(createAgentTeamSessionId()).not.toContain(':')
    }
  })
})

describe('isPathSafeSessionId', () => {
  it.each([
    ['正常-纯字母数字', 'agent-team-abc123', true],
    ['正常-连字符下划线', 'agent-team_a-b_0', true],
    ['边界-空串', '', false],
    ['边界-仅前缀', 'agent-team-', true],
    ['异常-含冒号（legacy 形态）', 'agent-team:9f0c6f9a-1b2c-3d4e-5f60-7a8b9c0d1e2f', false],
    ['异常-含斜杠', 'agent-team/../etc', false],
    ['异常-含点号', 'agent-team.1', false],
    ['异常-含空白', 'agent-team 1', false],
  ])('%s', (_name, input, expected) => {
    expect(isPathSafeSessionId(input)).toBe(expected)
  })
})
