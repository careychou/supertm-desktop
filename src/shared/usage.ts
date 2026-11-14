import { BRAND } from './brand'
/** Token usage + estimated cost, shared by the local ledger and the Vertex project report. */

export interface PriceEntry { from: string; input?: number; output?: number; cache_read_input?: number; cache_write_input?: number; cache_write_1h_input?: number }
export interface Pricing { as_of?: string; models: Record<string, { label?: string; prices: PriceEntry[] }> }

export interface Tokens { input: number; cached: number; cacheWrite: number; output: number }
export interface UsageBucket extends Tokens { key: string; label?: string; requests: number; cost: number | null }
export interface UsageReport {
  source: 'local' | 'project'
  start: string
  end: string
  total: UsageBucket
  byDay: UsageBucket[]
  byModel: UsageBucket[]
  byChat?: UsageBucket[]
  pricingAsOf?: string
  warnings: string[]
  project?: string
  error?: string
}

/** Local ledger row: prompt tokens INCLUDE cached + cache-write tokens (OpenAI convention). */
export interface LedgerRow { ts: number; session_id: string; title: string | null; model: string; prompt: number; cached: number; cache_write: number; completion: number }

/** "anthropic/claude-opus-5-5" → the pricing key ("claude-opus-5-5", or "glm-5.2-maas" for "glm-5.2"). */
export function pricingKey(model: string, pricing: Pricing | null): string {
  const base = model.replace(/^.*::/, '').split('/').pop()!.toLowerCase().replace(/@.*$/, '')
  if (!pricing) return base
  for (const k of [base, `${base}-maas`, base.replace(/-maas$/, '')]) if (pricing.models[k]) return k
  return base
}

export function priceFor(pricing: Pricing | null, key: string, day: string): PriceEntry | null {
  const e = pricing?.models[key]
  if (!e) return null
  let best: PriceEntry | null = null
  for (const p of [...e.prices].sort((a, b) => a.from.localeCompare(b.from))) if (p.from <= day) best = p
  return best
}

/** USD for one model-day of tokens; null when the model has no price. */
export function costOf(t: Tokens, p: PriceEntry | null): number | null {
  if (!p) return null
  const inp = p.input ?? 0
  return (t.input * inp + t.output * (p.output ?? 0) + t.cached * (p.cache_read_input ?? 0) + t.cacheWrite * (p.cache_write_input ?? inp)) / 1e6
}

export const localDay = (ts: number) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

const blank = (key: string, label?: string): UsageBucket => ({ key, label, input: 0, cached: 0, cacheWrite: 0, output: 0, requests: 0, cost: 0 })

function add(b: UsageBucket, t: Tokens, cost: number | null, requests: number) {
  b.input += t.input; b.cached += t.cached; b.cacheWrite += t.cacheWrite; b.output += t.output; b.requests += requests
  b.cost = (b.cost ?? 0) + (cost ?? 0)
}

/** Group tokens/cost into total, per day, per model and (optionally) per chat. */
export function buildReport(
  entries: Array<{ day: string; model: string; chat?: string; chatLabel?: string; t: Tokens; requests: number }>,
  pricing: Pricing | null, meta: { source: 'local' | 'project'; start: string; end: string; project?: string; warnings?: string[] }
): UsageReport {
  const total = blank('total')
  const byDay = new Map<string, UsageBucket>(), byModel = new Map<string, UsageBucket>(), byChat = new Map<string, UsageBucket>()
  const warnings = new Set(meta.warnings ?? [])
  let unpriced = false
  for (const e of entries) {
    const key = pricingKey(e.model, pricing)
    const cost = costOf(e.t, priceFor(pricing, key, e.day))
    if (cost === null) { unpriced = true; if (pricing) warnings.add(`${key}: no price in pricing.json (tokens counted, cost excluded)`) }
    const c = cost ?? 0
    const put = (m: Map<string, UsageBucket>, k: string, label?: string) => { let b = m.get(k); if (!b) m.set(k, (b = blank(k, label))); add(b, e.t, c, e.requests) }
    add(total, e.t, c, e.requests)
    put(byDay, e.day)
    put(byModel, key, pricing?.models[key]?.label)
    if (e.chat) put(byChat, e.chat, e.chatLabel)
  }
  if (!pricing) warnings.add('No pricing.json found: showing tokens only. Put one at ~/' + BRAND.homeDir + '/pricing.json or set it in Settings → Usage.')
  const desc = (m: Map<string, UsageBucket>) => [...m.values()].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || b.output - a.output)
  return {
    ...meta, total: { ...total, cost: !pricing && unpriced ? null : total.cost },
    byDay: [...byDay.values()].sort((a, b) => a.key.localeCompare(b.key)), byModel: desc(byModel),
    byChat: meta.source === 'local' ? desc(byChat) : undefined, pricingAsOf: pricing?.as_of, warnings: [...warnings]
  }
}

/** Ledger rows → report. Input tokens are the uncached part of the prompt. */
export function localReport(rows: LedgerRow[], pricing: Pricing | null, start: number, end: number): UsageReport {
  return buildReport(rows.map((r) => ({
    day: localDay(r.ts), model: r.model, chat: r.session_id, chatLabel: r.title ?? '(deleted chat)', requests: 1,
    t: { input: Math.max(0, r.prompt - r.cached - r.cache_write), cached: r.cached, cacheWrite: r.cache_write, output: r.completion }
  })), pricing, { source: 'local', start: new Date(start).toISOString(), end: new Date(end).toISOString() })
}

const TOKEN_TYPES = ['input', 'output', 'cache_read_input', 'cache_write_input', 'cache_write_1h_input'] as const

/**
 * Cloud Monitoring `token_count` time series (hourly ALIGN_SUM, grouped by model + token type)
 * → per-(day, model) token rows. Each hourly point is attributed to the local day of its START,
 * so a 23:00–00:00 bucket lands on the right day.
 */
export function monitoringRows(series: any[]): { rows: any[]; warnings: string[] } {
  const rows = new Map<string, any>()
  const warns = new Set<string>()
  for (const s of series) {
    const model = s?.resource?.labels?.model_user_id ?? '?'
    const type = s?.metric?.labels?.type ?? '?'
    for (const pt of s?.points ?? []) {
      const n = Number(pt?.value?.int64Value ?? pt?.value?.doubleValue ?? 0)
      if (!n) continue
      const day = localDay(Date.parse(pt.interval.startTime))
      const k = `${day}\u0000${model}`
      const r = rows.get(k) ?? { day, model, ...Object.fromEntries(TOKEN_TYPES.map((t) => [t, 0])) }
      rows.set(k, r)
      if ((TOKEN_TYPES as readonly string[]).includes(type)) r[type] += n
      else warns.add(`${model}: unpriced token type '${type}' (${n.toLocaleString()} tokens).`)
    }
  }
  return { rows: [...rows.values()].sort((a, b) => (a.day + a.model).localeCompare(b.day + b.model)), warnings: [...warns] }
}

/** Per-(day, model) token rows (see `monitoringRows`) → report (cost from pricing.json; `est_cost_usd` used when there is none). */
export function projectReport(j: any, pricing: Pricing | null): UsageReport {
  const rows: any[] = j.rows ?? []
  const r = buildReport(rows.map((x) => ({
    day: x.day, model: x.model, requests: 0,
    t: { input: x.input ?? 0, cached: x.cache_read_input ?? 0, cacheWrite: (x.cache_write_input ?? 0) + (x.cache_write_1h_input ?? 0), output: x.output ?? 0 }
  })), pricing, { source: 'project', start: j.start, end: j.end, project: j.project, warnings: j.warnings })
  // without a local pricing file, trust the command's own estimate
  if (!pricing && rows.some((x) => x.est_cost_usd != null)) {
    const sum = (pick: (x: any) => boolean) => rows.filter(pick).reduce((s, x) => s + (x.est_cost_usd ?? 0), 0)
    r.total.cost = sum(() => true)
    for (const b of r.byDay) b.cost = sum((x) => x.day === b.key)
    for (const b of r.byModel) b.cost = sum((x) => x.model === b.key)
    r.warnings = r.warnings.filter((w) => !w.startsWith('No pricing.json'))
    r.pricingAsOf = j.pricing_as_of
  }
  return r
}
