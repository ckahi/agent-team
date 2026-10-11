import { describe, expect, it, vi } from 'vitest'
import {
  installProjectionCacheKeyCompat,
  sanitizeProjectionCacheKey,
  type ProjectionCacheLike,
} from '../src/runtime/projection-cache-compat.js'

const SAFE_KEY_PATTERN = /^[a-zA-Z0-9_-]+$/

interface FakeTable extends Map<string, unknown> {}

function createFakeCache(): ProjectionCacheLike & { table: FakeTable; originalPut: ReturnType<typeof vi.fn> } {
  const table: FakeTable = new Map()
  const originalPut = vi.fn(async (id: string, identity: unknown, rows: unknown) => {
    if (!SAFE_KEY_PATTERN.test(id)) {
      throw new Error(`per-record key '${id}' is not path-safe`)
    }
    table.set(id, { identity, rows })
  })
  const cache = {
    table,
    originalPut,
    put: originalPut,
    recordFor: vi.fn((id: string) => table.get(id)),
    cachedSnapshot: vi.fn((meta: { id: string }) => table.get(meta.id)),
    cachedPredecessorTitle: vi.fn((meta: { id: string }) => table.get(meta.id)),
  }
  return cache as unknown as ProjectionCacheLike & typeof cache
}

describe('sanitizeProjectionCacheKey', () => {
  it.each([
    ['正常-新格式连键不变形', 'agent-team-9f0c6f9a-1b2c-3d4e-5f60-7a8b9c0d1e2f', 'agent-team-9f0c6f9a-1b2c-3d4e-5f60-7a8b9c0d1e2f'],
    ['正常-宿主 uuid 键不变形', '4f8a2b1c-3d4e-4f50-6a7b-8c9d0e1f2a3b', '4f8a2b1c-3d4e-4f50-6a7b-8c9d0e1f2a3b'],
    ['异常-legacy 冒号键映射为下划线', 'agent-team:9f0c6f9a-1b2c-3d4e-5f60-7a8b9c0d1e2f', 'agent-team_9f0c6f9a-1b2c-3d4e-5f60-7a8b9c0d1e2f'],
    ['异常-小助手 legacy 键映射', 'agent-team:assistant-builder:history-1', 'agent-team_assistant-builder_history-1'],
    ['边界-混合非法字符全替换', 'a:b/c.d e', 'a_b_c_d_e'],
    ['边界-空串', '', ''],
  ])('%s', (_name, input, expected) => {
    expect(sanitizeProjectionCacheKey(input)).toBe(expected)
  })

  it('幂等性-sanitize 输出再 sanitize 不变', () => {
    const once = sanitizeProjectionCacheKey('agent-team:9f0c6f9a')
    expect(sanitizeProjectionCacheKey(once)).toBe(once)
  })

  it('无碰撞论证-插件命名空间内 sanitize 单射（legacy ∪ 新格式 200 样例）', () => {
    const ids = new Set<string>()
    for (let index = 0; index < 100; index += 1) {
      const uuid = `${index.toString().padStart(3, '0')}-aaaa-bbbb-cccc-dddddddddddd`
      ids.add(`agent-team:${uuid}`)
      ids.add(`agent-team-${uuid}`)
    }
    const sanitized = new Set([...ids].map(sanitizeProjectionCacheKey))
    expect(sanitized.size).toBe(ids.size)
    expect([...sanitized].every(id => SAFE_KEY_PATTERN.test(id))).toBe(true)
  })
})

describe('installProjectionCacheKeyCompat', () => {
  it('正常-legacy 冒号 id 经包装后成功写入且键为 path-safe', async () => {
    const cache = createFakeCache()
    const dispose = installProjectionCacheKeyCompat(cache)
    const legacyId = 'agent-team:9f0c6f9a-1b2c-3d4e-5f60-7a8b9c0d1e2f'

    await expect(cache.put(legacyId, { createdAt: 'x' }, { title: { seq: 1 } })).resolves.toBeUndefined()
    const storedKey = 'agent-team_9f0c6f9a-1b2c-3d4e-5f60-7a8b9c0d1e2f'
    expect(cache.table.has(storedKey)).toBe(true)
    expect(cache.table.has(legacyId)).toBe(false)
    dispose()
  })

  it('正常-新格式 id 原样透传写入', async () => {
    const cache = createFakeCache()
    const dispose = installProjectionCacheKeyCompat(cache)
    const newId = 'agent-team-9f0c6f9a-1b2c-3d4e-5f60-7a8b9c0d1e2f'

    await cache.put(newId, {}, {})
    expect(cache.table.has(newId)).toBe(true)
    dispose()
  })

  it('读取-还原映射：recordFor 用原始 legacy id 命中 sanitized 记录', async () => {
    const cache = createFakeCache()
    const dispose = installProjectionCacheKeyCompat(cache)
    const legacyId = 'agent-team:assistant-builder:history-1'
    const identity = { createdAt: 'x' }

    await cache.put(legacyId, identity, { title: { seq: 3 } })
    expect(cache.recordFor(legacyId, identity)).toMatchObject({ identity })
    dispose()
  })

  it('读取-还原映射：cachedSnapshot / cachedPredecessorTitle 回退命中', async () => {
    const cache = createFakeCache()
    const dispose = installProjectionCacheKeyCompat(cache)
    const legacyId = 'agent-team:assistant-builder'

    await cache.put(legacyId, {}, {})
    expect(cache.cachedSnapshot({ id: legacyId })).toBeDefined()
    expect(cache.cachedPredecessorTitle({ id: legacyId })).toBeDefined()
    dispose()
  })

  it('还原-dispose 恢复原始方法（写非法键重新被原实现拒绝）', async () => {
    const cache = createFakeCache()
    const original = cache.put
    const dispose = installProjectionCacheKeyCompat(cache)
    dispose()

    expect(cache.put).toBe(original)
    await expect(cache.put('agent-team:x', {}, {})).rejects.toThrow(/not path-safe/)
  })

  it('异常-服务缺失或无 put 方法时返回 noop 不抛错', () => {
    expect(() => installProjectionCacheKeyCompat(undefined)).not.toThrow()
    expect(() => installProjectionCacheKeyCompat({} as ProjectionCacheLike)).not.toThrow()
  })
})
