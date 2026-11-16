import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile, type ChildProcess } from 'node:child_process'
import { azureCostRows, azureMonitorRows, azureReport, localDay, localReport, monitoringRows, projectReport, type Pricing, type UsageReport } from '../shared/usage'
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

// ── Azure: Azure Monitor token metrics + Cost Management billed $ ───────────────────────────────

const ARM = 'https://management.azure.com'
/** Azure Monitor keeps platform metrics ~93 days. */
const AZURE_RETENTION_DAYS = 93

/** The Azure provider the Azure usage tab reads (first enabled one). */
export function azureUsageProvider(providers: ProviderEntry[]): ProviderEntry | null {
  return providers.find((p) => p.kind === 'azure' && p.enabled !== false && p.baseUrl?.trim()) ?? null
}

/** ARM token: the provider's Entra service principal when set, else the signed-in Azure CLI. */
export async function azureArmToken(p: ProviderEntry, f: typeof fetch = fetch): Promise<string> {
  if (p.tenantId?.trim() && p.clientId?.trim() && p.clientSecret) {
    const r = await f(`https://login.microsoftonline.com/${encodeURIComponent(p.tenantId.trim())}/oauth2/v2.0/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: p.clientId.trim(), client_secret: p.clientSecret, scope: `${ARM}/.default` }).toString()
    })
    const j: any = await r.json().catch(() => ({}))
    if (!r.ok || !j.access_token) throw new Error(`Entra sign-in failed (${r.status}): ${j.error_description ?? j.error ?? ''}`.trim())
    return j.access_token
  }
  const args = ['account', 'get-access-token', '--resource', ARM, '--query', 'accessToken', '-o', 'tsv']
  if (p.tenantId?.trim()) args.push('--tenant', p.tenantId.trim())
  return new Promise((resolve, reject) => execFile('az', args, { timeout: 30000 }, (err, out, errOut) => {
    if (!err) return resolve(out.trim())
    if ((err as any).code === 'ENOENT') return reject(new Error('Azure CLI (az) not found. Install it and run `az login`, or set a service principal on the Azure provider.'))
    const e: any = new Error(`Sign in to Azure to read usage for this resource.\n${azErr(errOut)}`.trim())
    e.needsAzLogin = true
    reject(e)
  }))
}

const azErr = (errOut: unknown) => String(errOut ?? '').split('\n').filter((l) => l.trim() && !/Warning/.test(l)).join('\n').trim().slice(0, 300)

let azLoginProc: ChildProcess | null = null
/** Runs `az login` (browser sign-in) for the Azure usage provider's tenant. Tokens stay in the Azure CLI cache; nothing is returned. */
export function azureLogin(p: ProviderEntry | null): Promise<{ ok: boolean; error?: string; cancelled?: boolean }> {
  if (azLoginProc) return Promise.resolve({ ok: false, error: 'An Azure sign-in is already in progress — finish it in the browser.' })
  const args = ['login', '--only-show-errors', '-o', 'none']
  if (p?.tenantId?.trim()) args.push('--tenant', p.tenantId.trim())
  // Non-interactive: skip the subscription picker (it would wait on stdin) and keep the CLI's default subscription.
  const env = { ...process.env, AZURE_CORE_LOGIN_EXPERIENCE_V2: 'off' }
  return new Promise((resolve) => {
    let cancelled = false
    const proc = execFile('az', args, { timeout: 300_000, env }, (err, _out, errOut) => {
      azLoginProc = null
      if (!err) return resolve({ ok: true })
      if (cancelled) return resolve({ ok: false, cancelled: true })
      if ((err as any).code === 'ENOENT') return resolve({ ok: false, error: 'Azure CLI (az) not found. Install it first.' })
      if ((err as any).killed) return resolve({ ok: false, error: 'Sign-in timed out after 5 minutes. Try again.' })
      resolve({ ok: false, error: azErr(errOut) || String(err.message) })
    })
    proc.stdin?.end()
    ;(proc as any).cancel = () => { cancelled = true; proc.kill() }
    azLoginProc = proc
  })
}
/** Stops a pending `az login` (the user closed the browser or changed their mind). */
export function cancelAzureLogin(): boolean {
  if (!azLoginProc) return false
  ;(azLoginProc as any).cancel()
  return true
}

async function arm(f: typeof fetch, token: string, url: string, init?: { method?: string; body?: unknown }): Promise<any> {
  const r = await f(url.startsWith('http') ? url : ARM + url, {
    method: init?.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, ...(init?.body ? { 'content-type': 'application/json' } : {}) },
    body: init?.body ? JSON.stringify(init.body) : undefined
  })
  if (!r.ok) { const e: any = new Error(`${r.status}: ${(await r.text()).slice(0, 300)}`); e.status = r.status; throw e }
  return r.json()
}

/** The provider's ARM resource id: as configured, else looked up by the host's resource name via Resource Graph. */
export async function azureResourceId(p: ProviderEntry, token: string, f: typeof fetch = fetch): Promise<string> {
  if (p.armResourceId?.trim()) return p.armResourceId.trim().replace(/\/$/, '')
  const name = (() => { try { return new URL(p.baseUrl.trim()).hostname.split('.')[0] } catch { return '' } })()
  if (!name) throw new Error('Set the Azure provider\'s resource host (https://<resource>.openai.azure.com).')
  const j = await arm(f, token, '/providers/Microsoft.ResourceGraph/resources?api-version=2021-03-01', {
    method: 'POST', body: { query: `resources | where type =~ 'microsoft.cognitiveservices/accounts' and name =~ '${name.replace(/'/g, '')}' | project id` }
  })
  const id = j?.data?.[0]?.id
  if (!id) throw new Error(`No Azure resource named '${name}' is visible to this identity. Paste its ARM resource id on the provider (Azure portal → resource → JSON view).`)
  return id
}

/** Hourly token metrics split by model (ModelName). */
export async function fetchAzureMetrics(resourceId: string, token: string, start: Date, end: Date, f: typeof fetch = fetch): Promise<any> {
  const q = (names: string, agg: string) => new URLSearchParams({
    'api-version': '2023-10-01', metricnames: names, timespan: `${start.toISOString()}/${end.toISOString()}`,
    interval: 'PT1H', aggregation: agg, $filter: "ModelName eq '*'", top: '100'
  })
  const base = `${resourceId}/providers/microsoft.insights/metrics?`
  const tokens = await arm(f, token, base + q('InputTokens,OutputTokens,cacheReadInputTokens', 'Total'))
  let rate: any = { value: [] }
  try { rate = await arm(f, token, base + q('AzureOpenAIContextTokensCacheMatchRate', 'Average')) } catch { /* optional */ }
  return { value: [...(tokens.value ?? []), ...(rate.value ?? [])] }
}

/** Actual cost per day + meter for the resource (paged). Queried at the resource group scope, filtered to the resource. */
export async function fetchAzureCost(resourceId: string, token: string, start: Date, end: Date, f: typeof fetch = fetch): Promise<any> {
  const scope = resourceId.split('/providers/')[0]
  const body = {
    type: 'ActualCost', timeframe: 'Custom',
    timePeriod: { from: `${localDay(start.getTime())}T00:00:00Z`, to: `${localDay(end.getTime())}T23:59:59Z` },
    dataset: {
      granularity: 'Daily', aggregation: { c: { name: 'Cost', function: 'Sum' } },
      filter: { dimensions: { name: 'ResourceId', operator: 'In', values: [resourceId] } },
      grouping: [{ type: 'Dimension', name: 'Meter' }]
    }
  }
  let j = await arm(f, token, `${scope}/providers/Microsoft.CostManagement/query?api-version=2023-11-01`, { method: 'POST', body })
  const out = { properties: { columns: j?.properties?.columns ?? [], rows: [...(j?.properties?.rows ?? [])] } }
  while (j?.properties?.nextLink) {
    j = await arm(f, token, j.properties.nextLink, { method: 'POST', body })
    out.properties.rows.push(...(j?.properties?.rows ?? []))
  }
  return out
}

/** Whole-resource Azure OpenAI usage: tokens from Azure Monitor, priced locally, plus billed $ from Cost Management. */
export async function getAzureUsage(providers: ProviderEntry[], days: number, pricingPath: string, dataHome: string, f: typeof fetch = fetch, tokenFn?: () => Promise<string>): Promise<UsageReport> {
  const empty = (error: string): UsageReport => ({ source: 'azure', start: '', end: '', total: { key: 'total', input: 0, cached: 0, cacheWrite: 0, output: 0, requests: 0, cost: 0 }, byDay: [], byModel: [], warnings: [], error })
  const p = azureUsageProvider(providers)
  if (!p) return empty('Azure usage reads Azure Monitor through an Azure OpenAI provider. Add one in Settings → Model providers.')
  const end = new Date()
  const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - (days - 1))
  const warnings: string[] = []
  const oldest = new Date(end.getTime() - AZURE_RETENTION_DAYS * 86400_000)
  if (start < oldest) { start.setTime(oldest.getTime()); warnings.push(`Azure Monitor keeps about ${AZURE_RETENTION_DAYS} days; older usage is not shown.`) }
  try {
    const token = await (tokenFn ?? (() => azureArmToken(p, f)))()
    const resource = await azureResourceId(p, token, f)
    let metrics: any
    try { metrics = await fetchAzureMetrics(resource, token, start, end, f) } catch (e: any) {
      throw new Error(e?.status === 403 ? `Permission denied — the identity needs the Monitoring Reader role on ${resource}.\n${e.message}` : `Azure Monitor ${e?.message ?? e}`)
    }
    const { rows, warnings: w } = azureMonitorRows(metrics)
    let billed: ReturnType<typeof azureCostRows> | null = null, billedError: string | undefined
    try { billed = azureCostRows(await fetchAzureCost(resource, token, start, end, f)) } catch (e: any) {
      billedError = e?.status === 403 || e?.status === 401
        ? 'Billed cost unavailable — the identity needs the Cost Management Reader role on the resource group or subscription.'
        : `Billed cost unavailable: Cost Management ${e?.message ?? e}`
    }
    return azureReport({ rows, billed, billedError, start: start.toISOString(), end: end.toISOString(), resource, warnings: [...warnings, ...w] }, loadPricing(pricingPath, dataHome).pricing)
  } catch (e: any) {
    return { ...empty(String(e?.message ?? e)), ...(e?.needsAzLogin ? { needsAzLogin: true } : {}) }
  }
}
