const EPERM_ERRNO = -4048

export function isEpermError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { code?: unknown, errno?: unknown }
  if (candidate.code === 'EPERM') return true
  return candidate.errno === EPERM_ERRNO
}

export interface WriteRetryInfo {
  attempt: number
  error: unknown
  elapsedMs: number
}

export interface WriteRetryOptions {
  /** Retry attempts after the first failure; 0 disables retrying. Default 4. */
  maxRetries?: number
  /** Base backoff delay in ms; doubled exponentially per attempt. Default 50. */
  baseDelayMs?: number
  /** Injectable delay so tests can avoid real waiting. */
  delay?: (ms: number) => Promise<void>
  /** Called on every retry with attempt context for logging. */
  onRetry?: (info: WriteRetryInfo) => void
}

const defaultDelay = (ms: number): Promise<void> =>
  new Promise(resolve => { setTimeout(resolve, ms) })

/**
 * Retry a storage write only on Windows rename EPERM (-4048) failures, with
 * exponential backoff. Safe to retry because the domain write chain leaves
 * memory untouched when the backend rejects, and puts are idempotent full
 * snapshots. Any other error — or an exhausted retry budget — rethrows the
 * original error untouched.
 */
export async function withWriteRetry<T>(
  operation: () => Promise<T>,
  options: WriteRetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 4
  const baseDelayMs = options.baseDelayMs ?? 50
  const delay = options.delay ?? defaultDelay
  const startedAt = Date.now()
  let attempt = 0
  for (;;) {
    try {
      return await operation()
    } catch (error) {
      if (!isEpermError(error) || attempt >= maxRetries) throw error
      attempt += 1
      options.onRetry?.({
        attempt,
        error,
        elapsedMs: Date.now() - startedAt,
      })
      await delay(baseDelayMs * 2 ** (attempt - 1))
    }
  }
}
