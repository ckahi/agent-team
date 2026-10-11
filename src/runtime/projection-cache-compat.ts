/**
 * 宿主 session_projcache per-record 键兼容层。
 *
 * 宿主 `@deepseek-ai/dsh-session-projection-cache` 以 sessionId 直接作为
 * per-record 存储键（write → put(session.id) → table.put(id)），键必须匹配
 * `/^[a-zA-Z0-9_-]+$/`，否则写入 fail-soft 失败。插件 0.2.24 起新会话键为
 * path-safe 的 `agent-team-<uuid>`；存量会话键 `agent-team:<uuid>`（含冒号）
 * 无法迁移（会孤儿化可恢复的会话历史），因此在该服务实例上做键映射包装：
 * 写入时把键 sanitize 为 path-safe（单向 ':' → '_'），读取时按
 * 「原始键 → sanitized 键」回退命中，使存量会话也能成功写入且可读回。
 *
 * 无碰撞论证：插件命名空间内 id 仅两种形态——legacy `agent-team:<uuid>` 与
 * 新格式 `agent-team-<uuid>`（uuid 字符 ∈ [0-9a-f-]），sanitize 后分别为
 * `agent-team_<uuid>` 与原样；宿主侧会话 id 为 uuid 形态不含冒号。命名空间
 * 内没有任何 id 在 `agent-team` 前缀后含下划线，映射在其并集上单射。
 */

const SAFE_KEY_PATTERN = /^[a-zA-Z0-9_-]+$/

export function sanitizeProjectionCacheKey(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/** 宿主投影缓存服务的最小结构面（避免引入宿主包类型依赖）。 */
export interface ProjectionCacheLike {
  put(id: string, identity: unknown, rows: unknown): Promise<void>
  recordFor(id: string, expected: unknown): unknown
  cachedSnapshot(meta: { id: string }, keys?: readonly string[]): unknown
  cachedPredecessorTitle(meta: { id: string }): unknown
}

type Disposer = () => void

export function installProjectionCacheKeyCompat(
  cache: ProjectionCacheLike | undefined,
): Disposer {
  if (cache === undefined || typeof cache.put !== 'function') return () => {}
  if (!isPatchable(cache)) return () => {}

  const originalPut = cache.put
  const originalRecordFor = cache.recordFor
  const originalCachedSnapshot = cache.cachedSnapshot
  const originalCachedPredecessorTitle = cache.cachedPredecessorTitle

  cache.put = function putSanitized(this: unknown, id: string, identity: unknown, rows: unknown) {
    return originalPut.call(this, sanitizeProjectionCacheKey(id), identity, rows)
  }

  cache.recordFor = function recordForWithFallback(this: unknown, id: string, expected: unknown) {
    const direct = originalRecordFor.call(this, id, expected)
    if (direct !== undefined) return direct
    const sanitizedId = sanitizeProjectionCacheKey(id)
    return sanitizedId === id ? undefined : originalRecordFor.call(this, sanitizedId, expected)
  }

  cache.cachedSnapshot = function cachedSnapshotWithFallback(
    this: unknown,
    meta: { id: string },
    keys?: readonly string[],
  ) {
    const direct = originalCachedSnapshot.call(this, meta, keys)
    if (direct !== undefined) return direct
    const sanitizedId = sanitizeProjectionCacheKey(meta.id)
    if (sanitizedId === meta.id) return undefined
    return originalCachedSnapshot.call(this, { ...meta, id: sanitizedId }, keys)
  }

  cache.cachedPredecessorTitle = function cachedPredecessorTitleWithFallback(
    this: unknown,
    meta: { id: string },
  ) {
    const direct = originalCachedPredecessorTitle.call(this, meta)
    if (direct !== undefined) return direct
    const sanitizedId = sanitizeProjectionCacheKey(meta.id)
    if (sanitizedId === meta.id) return undefined
    return originalCachedPredecessorTitle.call(this, { ...meta, id: sanitizedId })
  }

  return () => {
    cache.put = originalPut
    cache.recordFor = originalRecordFor
    cache.cachedSnapshot = originalCachedSnapshot
    cache.cachedPredecessorTitle = originalCachedPredecessorTitle
  }
}

function isPatchable(cache: ProjectionCacheLike): boolean {
  return typeof cache.recordFor === 'function'
    && typeof cache.cachedSnapshot === 'function'
    && typeof cache.cachedPredecessorTitle === 'function'
}
