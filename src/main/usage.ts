import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { localReport, monitoringRows, projectReport, type Pricing, type UsageReport } from '../shared/usage'
import type { ProviderEntry } from '../shared/providers'
import { VertexAuth } from '../engine/adapter/vertex-auth'
import type { Store } from './store'
import { BRAND } from '../shared/brand'

/** First readable pricing.json: the explicit setting, then the data home, then the brand's built-in table. */
export function loadPricing(explicit: string, dataHome: string): { pricing: Pricing | null; path: string | null } {
  const cands = [explicit, path.join(dataHome, 'pricing.json')].filter(Boolean)
  for (const p of cands) {
    try { const j = JSON.parse(fs.readFileSync(p.replace(/^~(?=\/)/, os.homedir()), 'utf8')); if (j?.models) return { pricing: j, path: p } } catch { /* next */ }
  }
  return BRAND.pricing ? { pricing: BRAND.pricing, path: 'built-in' } : { pricing: null, path: null }
}

/** The Vertex provider whose project and credentials the Project usage tab uses (first enabled one). */
export function usageProvider(providers: ProviderEntry[]): ProviderEntry | null {
  return providers.find((p) => p.kind === 'vertex' && p.enabled !== false && p.project?.trim()) ?? null
}

export function getLocalUsage(store: Store, days: number, pricingPath: string, dataHome: string): UsageReport {
  const now = Date.now()
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (days - 1))
  const { pricing } = loadPricing(pricingPath, dataHome)
  return localReport(store.usageSince(d.getTime()) as any, pricing, d.getTime(), now)
}

const METRIC = 'aiplatform.googleapis.com/publisher/online_serving/token_count'
/** Cloud Monitoring keeps ~6 weeks of this metric. */
const RETENTION_DAYS = 42

/** Hourly token counts for the whole project, grouped by model + token type (paged). */
export async function fetchTokenSeries(project: string, token: string, start: Date, end: Date, f: typeof fetch = fetch): Promise<any[]> {
  const q = new URLSearchParams({
    filter: `metric.type="${METRIC}"`,
    'interval.startTime': start.toISOString(),
    'interval.endTime': end.toISOString(),
    'aggregation.alignmentPeriod': '3600s',
    'aggregation.perSeriesAligner': 'ALIGN_SUM',
    'aggregation.crossSeriesReducer': 'REDUCE_SUM',
    view: 'FULL',
    pageSize: '1000'
  })
  for (const g of ['resource.label.model_user_id', 'resource.label.publisher', 'metric.label.type', 'metric.label.request_type']) q.append('aggregation.groupByFields', g)
  const out: any[] = []
  let page = ''
  do {
    if (page) q.set('pageToken', page)
    const r = await f(`https://monitoring.googleapis.com/v3/projects/${encodeURIComponent(project)}/timeSeries?${q}`, { headers: { authorization: `Bearer ${token}` } })
    if (!r.ok) {
      const body = (await r.text()).slice(0, 300)
      throw new Error(r.status === 403 ? `Permission denied — the credential needs roles/monitoring.viewer on ${project}.\n${body}` : `Cloud Monitoring ${r.status}: ${body}`)
    }
    const j: any = await r.json()
    out.push(...(j.timeSeries ?? []))
    page = j.nextPageToken ?? ''
  } while (page)
  return out
}

/** Whole-project token usage straight from Cloud Monitoring, signed in with the Vertex provider's credentials. */
export async function getProjectUsage(providers: ProviderEntry[], days: number, pricingPath: string, dataHome: string, f: typeof fetch = fetch, auth?: { token(): Promise<string> }): Promise<UsageReport> {
  const empty = (error: string): UsageReport => ({ source: 'project', start: '', end: '', total: { key: 'total', input: 0, cached: 0, cacheWrite: 0, output: 0, requests: 0, cost: 0 }, byDay: [], byModel: [], warnings: [], error })
  const p = usageProvider(providers)
  if (!p) return empty('Project usage reads Cloud Monitoring through a Google Vertex AI provider. Add one in Settings → Model providers.')
  const end = new Date()
  const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - (days - 1))
  const warnings: string[] = []
  const oldest = new Date(end.getTime() - RETENTION_DAYS * 86400_000)
  if (start < oldest) { start.setTime(oldest.getTime()); warnings.push(`Cloud Monitoring keeps about ${RETENTION_DAYS} days; older usage is not shown.`) }
  try {
    const token = await (auth ?? new VertexAuth(p.credentialsPath ?? '')).token()
    const { rows, warnings: w } = monitoringRows(await fetchTokenSeries(p.project!.trim(), token, start, end, f))
    return projectReport({ rows, start: start.toISOString(), end: end.toISOString(), project: p.project!.trim(), warnings: [...warnings, ...w] }, loadPricing(pricingPath, dataHome).pricing)
  } catch (e: any) {
    return empty(String(e?.message ?? e))
  }
}
