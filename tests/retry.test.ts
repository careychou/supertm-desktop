import { describe, it, expect } from 'vitest'
import { describeError, isNetworkError, isTransient, retryDelay, RETRY_DELAYS_MS, MODEL_ATTEMPTS } from '../src/engine/retry'

const withCause = (msg: string, cause: { message: string; code?: string }) => Object.assign(new TypeError(msg), { cause: Object.assign(new Error(cause.message), cause.code ? { code: cause.code } : {}) })

describe('model call retries', () => {
  it('treats dropped connections, timeouts, rate limits and 5xx as worth another try', () => {
    expect(isTransient(withCause('terminated', { message: 'other side closed', code: 'UND_ERR_SOCKET' }))).toBe(true)
    expect(isTransient(withCause('fetch failed', { message: 'connect ETIMEDOUT 20.0.0.1:443', code: 'ETIMEDOUT' }))).toBe(true)
    expect(isTransient(new TypeError('terminated'))).toBe(true)
    expect(isTransient(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true)
    for (const status of [408, 429, 500, 502, 503, 529]) expect(isTransient(Object.assign(new Error('x'), { status }))).toBe(true)
    expect(isTransient(new Error('upstream: Overloaded'))).toBe(true)
  })
  it('does not retry what another try would not fix', () => {
    for (const status of [400, 401, 403, 404, 413]) expect(isTransient(Object.assign(new Error('x'), { status }))).toBe(false)
    expect(isTransient(new Error('upstream: prompt is too long'))).toBe(false)
    expect(isTransient(new Error('no model provider is configured'))).toBe(false)
    expect(isTransient(new Error('Unexpected token < in JSON'))).toBe(false)
    expect(isNetworkError(Object.assign(new Error('bad gateway'), { status: 502 }))).toBe(false)
  })
  it('names the real cause instead of a bare "terminated" or "fetch failed"', () => {
    expect(describeError(withCause('terminated', { message: 'other side closed', code: 'UND_ERR_SOCKET' }))).toBe('terminated (other side closed, UND_ERR_SOCKET)')
    expect(describeError(withCause('fetch failed', { message: 'getaddrinfo ENOTFOUND x', code: 'ENOTFOUND' }))).toBe('fetch failed (getaddrinfo ENOTFOUND x, ENOTFOUND)')
    expect(describeError(new Error('HTTP 502: bad gateway'))).toBe('HTTP 502: bad gateway')
    expect(describeError('plain')).toBe('plain')
  })
  it('waits 2, 5, then 10 seconds, with a little jitter', () => {
    expect(MODEL_ATTEMPTS).toBe(RETRY_DELAYS_MS.length + 1)
    for (const [attempt, base] of [[1, 2000], [2, 5000], [3, 10000], [9, 10000]] as const) {
      const d = retryDelay(attempt)
      expect(d).toBeGreaterThanOrEqual(base * 0.85)
      expect(d).toBeLessThanOrEqual(base * 1.15)
    }
  })
})
