/**
 * When a failed model call is worth trying again, how long to wait, and how to describe the failure.
 *
 * Node's fetch hides the real reason for a dropped connection: a socket the server or a proxy closes
 * mid-reply surfaces as `TypeError: terminated`, a request that never got a response as
 * `TypeError: fetch failed`, and the cause (`other side closed`, `ECONNRESET`, a timeout) sits in `e.cause`.
 */

/** Total tries for one model call, the first included. */
export const MODEL_ATTEMPTS = 4
/** Wait before try 2, 3, 4… (a little jitter is added so parallel sub-agents do not retry in step). */
export const RETRY_DELAYS_MS = [2_000, 5_000, 10_000]

const NETWORK_CODES = /^(ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ETIMEDOUT|ENETUNREACH|ENETDOWN|EHOSTUNREACH|EAI_AGAIN|UND_ERR_[A-Z_]+|ERR_STREAM_PREMATURE_CLOSE)$/
const NETWORK_MESSAGES = /^(terminated|fetch failed|other side closed|socket hang up|network error|premature close)$|ECONNRESET|ETIMEDOUT|UND_ERR_/i
/** Provider errors sent inside a 200 stream that mean "busy, try later". */
const BUSY_MESSAGES = /overloaded|rate.?limit|too many requests|temporarily unavailable|server error|internal error|try again/i

/** The error and its causes, outermost first. */
function chain(e: unknown): any[] {
  const out: any[] = []
  for (let c: any = e; c && out.length < 6 && !out.includes(c); c = c.cause) out.push(c)
  return out
}

/** A dropped or refused connection rather than an answer from the provider. */
export function isNetworkError(e: unknown): boolean {
  return chain(e).some((c) => (typeof c?.code === 'string' && NETWORK_CODES.test(c.code)) || (typeof c?.message === 'string' && NETWORK_MESSAGES.test(c.message.trim())))
}

/**
 * Worth another try: a dropped connection, a timeout, rate limiting, a 5xx, or a provider "overloaded"
 * error. Not a request the provider rejected (4xx) or a setup problem such as a missing key.
 */
export function isTransient(e: unknown): boolean {
  const status = (e as any)?.status
  if (typeof status === 'number') return status === 408 || status === 409 || status === 429 || status >= 500
  if (isNetworkError(e)) return true
  const msg = String((e as any)?.message ?? '')
  return /^upstream:/i.test(msg) && BUSY_MESSAGES.test(msg)
}

/** The message plus whatever its causes add, e.g. "terminated (other side closed, UND_ERR_SOCKET)". */
export function describeError(e: unknown): string {
  const [top, ...causes] = chain(e)
  const base = String(top?.message ?? top ?? 'unknown error')
  const extra: string[] = []
  for (const c of causes) {
    for (const s of [c?.message, c?.code]) {
      if (typeof s === 'string' && s.trim() && !base.includes(s) && !extra.includes(s)) extra.push(s.trim())
    }
  }
  return extra.length ? `${base} (${extra.join(', ')})` : base
}

/** The wait before try `attempt + 1` (attempt counts from 1). */
export function retryDelay(attempt: number, delays: number[] = RETRY_DELAYS_MS): number {
  const d = delays[Math.min(attempt - 1, delays.length - 1)] ?? 0
  return d ? Math.round(d * (0.85 + Math.random() * 0.3)) : 0
}

/** Waits `ms`, or rejects at once when `signal` aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('cancelled'))
    const t = setTimeout(() => { signal.removeEventListener('abort', stop); resolve() }, ms)
    const stop = () => { clearTimeout(t); reject(new Error('cancelled')) }
    signal.addEventListener('abort', stop, { once: true })
  })
}
