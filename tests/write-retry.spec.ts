import { describe, expect, it, vi } from 'vitest'
import { isEpermError, withWriteRetry } from '../src/storage/write-retry.js'

describe('isEpermError', () => {
  it('边界-errno -4048 无 code 判定为 EPERM', () => {
    expect(isEpermError({ errno: -4048 })).toBe(true)
  })
  it('边界-code EPERM 无 errno 判定为 EPERM', () => {
    expect(isEpermError({ code: 'EPERM' })).toBe(true)
  })
  it('异常-其他错误码不判定为 EPERM', () => {
    expect(isEpermError({ code: 'ENOENT', errno: -2 })).toBe(false)
    expect(isEpermError(new Error('boom'))).toBe(false)
  })
})

describe('withWriteRetry', () => {
  const noDelay = async () => {}

  function makeOptions(overrides: Partial<Parameters<typeof withWriteRetry>[1]> = {}) {
    return { delay: noDelay, ...overrides }
  }

  it('正常-首次成功不重试且无 onRetry', async () => {
    const fn = vi.fn(async () => 'ok')
    const onRetry = vi.fn()
    const result = await withWriteRetry(fn, makeOptions({ onRetry }))
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('异常-EPERM 重试后成功', async () => {
    let calls = 0
    const fn = vi.fn(async () => {
      calls += 1
      if (calls < 3) throw Object.assign(new Error('locked'), { code: 'EPERM' })
      return 'done'
    })
    const onRetry = vi.fn()
    const result = await withWriteRetry(fn, makeOptions({ onRetry }))
    expect(result).toBe('done')
    expect(fn).toHaveBeenCalledTimes(3)
    expect(onRetry).toHaveBeenCalledTimes(2)
    expect(onRetry.mock.calls[0]?.[0]).toMatchObject({ attempt: 1 })
  })

  it('异常-EPERM 耗尽后上抛原始错误对象', async () => {
    const original = Object.assign(new Error('locked'), { errno: -4048 })
    const fn = vi.fn(async () => {
      throw original
    })
    await expect(withWriteRetry(fn, makeOptions({ maxRetries: 2 }))).rejects.toBe(original)
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('异常-非 EPERM 立即上抛不重试', async () => {
    const original = Object.assign(new Error('missing'), { code: 'ENOENT' })
    const fn = vi.fn(async () => {
      throw original
    })
    await expect(withWriteRetry(fn, makeOptions())).rejects.toBe(original)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('边界-仅 code EPERM（无 errno）仍重试', async () => {
    let calls = 0
    const fn = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw Object.assign(new Error('x'), { code: 'EPERM' })
      return 'ok'
    })
    await expect(withWriteRetry(fn, makeOptions())).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('边界-仅 errno -4048（无 code）仍重试', async () => {
    let calls = 0
    const fn = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw Object.assign(new Error('x'), { errno: -4048 })
      return 'ok'
    })
    await expect(withWriteRetry(fn, makeOptions())).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('边界-maxRetries 0 不重试直接抛', async () => {
    const original = Object.assign(new Error('locked'), { code: 'EPERM' })
    const fn = vi.fn(async () => {
      throw original
    })
    await expect(withWriteRetry(fn, makeOptions({ maxRetries: 0 }))).rejects.toBe(original)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('正常-默认退避延时按 50ms 基数指数增长', async () => {
    const delays: number[] = []
    let calls = 0
    const fn = vi.fn(async () => {
      calls += 1
      if (calls < 4) throw Object.assign(new Error('x'), { code: 'EPERM' })
      return 'ok'
    })
    await withWriteRetry(fn, { delay: async ms => { delays.push(ms) } })
    expect(delays).toEqual([50, 100, 200])
  })
})
