import { randomUUID } from 'node:crypto'

/**
 * 插件生成的 Session 键必须满足宿主 per-record 存储域的 path-safe 约束
 * （`/^[a-zA-Z0-9_-]+$/`，见 @deepseek-ai/dsh-storage-json per-record 写入校验）。
 * `session_projcache` 的记录键就是 sessionId，含冒号的旧格式（`agent-team:<uuid>`）
 * 会导致该域全部写入失败（fail-soft 警告刷屏）。历史格式仅保留读取兼容，
 * 新会话一律使用连字符前缀。
 */
export const PATH_SAFE_SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]+$/

export function isPathSafeSessionId(sessionId: string): boolean {
  return PATH_SAFE_SESSION_ID_PATTERN.test(sessionId)
}

export function createAgentTeamSessionId(): string {
  return `agent-team-${randomUUID()}`
}
