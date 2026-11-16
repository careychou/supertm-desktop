import { describe, it, expect } from 'vitest'
import { localReport, pricingKey, projectReport, type Pricing } from '../src/shared/usage'

const pricing: Pricing = {
  as_of: '2026-11-01',
  models: {
    'claude-sonnet-5': { prices: [{ from: '2025-01-01', input: 3, output: 15, cache_read_input: 0.3, cache_write_input: 3.75 }, { from: '2026-12-01', input: 1, output: 5 }] },
    'glm-5.2-maas': { prices: [{ from: '2025-01-01', input: 1, output: 2 }] }
  }
}
const ts = (d: string) => new Date(`${d}T12:00:00`).getTime()

describe('usage', () => {
  it('maps provider-prefixed model ids to pricing keys', () => {
    expect(pricingKey('anthropic/claude-sonnet-5', pricing)).toBe('claude-sonnet-5')
    expect(pricingKey('zai-org/glm-5.2', pricing)).toBe('glm-5.2-maas')
  })

  it('prices local calls with cached tokens split out, by the price in effect that day', () => {
    const r = localReport([
      // 1M prompt of which 600K cached + 100K cache write -> 300K uncached input
      { ts: ts('2026-11-10'), session_id: 'a', title: 'Chat A', model: 'anthropic/claude-sonnet-5', prompt: 1_000_000, cached: 600_000, cache_write: 100_000, completion: 100_000 },
      { ts: ts('2026-12-02'), session_id: 'b', title: null, model: 'anthropic/claude-sonnet-5', prompt: 1_000_000, cached: 0, cache_write: 0, completion: 0 }
    ], pricing, 0, Date.now())
    // 0.3*3 + 0.6*0.3 + 0.1*3.75 + 0.1*15 = 2.955 ; second day uses the new $1 input price
    expect(r.byDay.map((d) => [d.key, +d.cost!.toFixed(3)])).toEqual([['2026-11-10', 2.955], ['2026-12-02', 1]])
    expect(r.total.requests).toBe(2)
    expect(r.byChat!.map((c) => c.label)).toEqual(['Chat A', '(deleted chat)'])
  })

  it('counts tokens but flags models without a price', () => {
    const r = localReport([{ ts: ts('2026-11-10'), session_id: 'a', title: 'x', model: 'mystery', prompt: 10, cached: 0, cache_write: 0, completion: 5 }], pricing, 0, Date.now())
    expect(r.total.output).toBe(5)
    expect(r.total.cost).toBe(0)
    expect(r.warnings[0]).toMatch(/mystery: no price/)
  })

  it('falls back to the command estimate when there is no local pricing file', () => {
    const r = projectReport({ project: 'p', start: 's', end: 'e', pricing_as_of: '2026-10-01', warnings: [], rows: [
      { day: '2026-11-10', model: 'claude-sonnet-5', input: 10, output: 20, cache_read_input: 0, cache_write_input: 0, est_cost_usd: 1.5 },
      { day: '2026-11-11', model: 'glm-5.2-maas', input: 10, output: 20, est_cost_usd: 0.5 }
    ] }, null)
    expect(r.total.cost).toBe(2)
    expect(r.byModel.find((m) => m.key === 'glm-5.2-maas')!.cost).toBe(0.5)
    expect(r.warnings).toEqual([])
    expect(r.pricingAsOf).toBe('2026-10-01')
  })
})

describe('project usage (Cloud Monitoring)', () => {
  const pt = (start: string, n: number) => ({ interval: { startTime: start }, value: { int64Value: String(n) } })
  const series = [
    { resource: { labels: { model_user_id: 'claude-sonnet-5' } }, metric: { labels: { type: 'input' } }, points: [pt('2026-11-10T10:00:00', 1000), pt('2026-11-10T11:00:00', 500)] },
    { resource: { labels: { model_user_id: 'claude-sonnet-5' } }, metric: { labels: { type: 'cache_write_1h_input' } }, points: [pt('2026-11-10T10:00:00', 40)] },
    { resource: { labels: { model_user_id: 'claude-sonnet-5' } }, metric: { labels: { type: 'mystery' } }, points: [pt('2026-11-11T09:00:00', 7)] }
  ]

  it('sums hourly points per local day and model, flagging unknown token types', async () => {
    const { monitoringRows } = await import('../src/shared/usage')
    const { rows, warnings } = monitoringRows(series)
    expect(rows[0]).toMatchObject({ day: '2026-11-10', model: 'claude-sonnet-5', input: 1500, cache_write_1h_input: 40 })
    expect(rows[1]).toMatchObject({ day: '2026-11-11', input: 0 })
    expect(warnings[0]).toMatch(/mystery/)
  })

  it('pages through timeSeries with the provider credentials and prices the result', async () => {
    const { getProjectUsage } = await import('../src/main/usage')
    const urls: string[] = []
    const f: any = async (u: string, init: any) => {
      urls.push(u); expect(init.headers.authorization).toBe('Bearer tok')
      const first = !u.includes('pageToken')
      return new Response(JSON.stringify(first ? { timeSeries: series.slice(0, 1), nextPageToken: 'p2' } : { timeSeries: series.slice(1, 2) }))
    }
    const prov = [{ id: 'v', name: 'V', kind: 'vertex' as const, baseUrl: '', apiKey: '', project: 'proj-1', credentialsPath: '' }]
    const r = await getProjectUsage(prov, 7, '', '/nonexistent', f, { token: async () => 'tok' })
    expect(urls).toHaveLength(2)
    expect(urls[0]).toContain('/projects/proj-1/timeSeries?')
    expect(decodeURIComponent(urls[0])).toContain('aggregation.groupByFields=metric.label.type')
    expect(r.project).toBe('proj-1')
    expect(r.total.input).toBe(1500)
    expect(r.total.cacheWrite).toBe(40)
  })

  it('explains 403 and a missing Vertex provider', async () => {
    const { getProjectUsage } = await import('../src/main/usage')
    expect((await getProjectUsage([], 7, '', '/x')).error).toMatch(/Vertex AI provider/)
    const prov = [{ id: 'v', name: 'V', kind: 'vertex' as const, baseUrl: '', apiKey: '', project: 'p' }]
    const r = await getProjectUsage(prov, 7, '', '/x', (async () => new Response('denied', { status: 403 })) as any, { token: async () => 't' })
    expect(r.error).toMatch(/roles\/monitoring\.viewer/)
  })
})

describe('azure usage (Azure Monitor + Cost Management)', () => {
  const az: Pricing = { models: { 'gpt-4o': { prices: [{ from: '2024-01-01', input: 2.75, output: 11, cache_read_input: 1.375 }] }, 'gpt-4.1-mini': { prices: [{ from: '2024-01-01', input: 0.44, output: 1.76 }] } } }
  const md = (m: string) => [{ name: { value: 'modelname' }, value: m }]
  const h = (iso: string) => new Date(iso).toISOString()
  const metrics = { value: [
    { name: { value: 'InputTokens' }, timeseries: [{ metadatavalues: md('gpt-4o'), data: [{ timeStamp: h('2026-11-10T10:00:00'), total: 1_000_000 }, { timeStamp: h('2026-11-10T11:00:00'), total: 1_000_000 }] }] },
    { name: { value: 'OutputTokens' }, timeseries: [{ metadatavalues: md('gpt-4o'), data: [{ timeStamp: h('2026-11-10T10:00:00'), total: 100_000 }] }] },
    // 10:00 reports cached tokens; 11:00 does not, so the 50% match rate estimates them
    { name: { value: 'cacheReadInputTokens' }, timeseries: [{ metadatavalues: md('gpt-4o'), data: [{ timeStamp: h('2026-11-10T10:00:00'), total: 200_000 }] }] },
    { name: { value: 'AzureOpenAIContextTokensCacheMatchRate' }, timeseries: [{ metadatavalues: md('gpt-4o'), data: [{ timeStamp: h('2026-11-10T11:00:00'), average: 50 }] }] }
  ] }

  it('splits cached out of InputTokens, estimating it from the match rate when missing', async () => {
    const { azureMonitorRows } = await import('../src/shared/usage')
    const { rows, warnings } = azureMonitorRows(metrics)
    expect(rows).toEqual([{ day: '2026-11-10', model: 'gpt-4o', input: 800_000 + 500_000, cached: 200_000 + 500_000, output: 100_000 }])
    expect(warnings[0]).toMatch(/gpt-4o: .*estimated/)
  })

  it('maps Cost Management meters to model lines', async () => {
    const { meterModel } = await import('../src/shared/usage')
    expect(meterModel('gpt 4o 1120 cached Inp regnl Tokens')).toBe('gpt-4o')
    expect(meterModel('gpt 4o 1120 Outp regnl Tokens')).toBe('gpt-4o')
    expect(meterModel('o3 mini 0131 input glbl Tokens')).toBe('o3-mini')
    expect(meterModel('gpt 4.1 mini Inp Data Zone Tokens')).toBe('gpt-4.1-mini')
    expect(meterModel('gpt 4o mini0718 BatchOutp DataZone Tokens')).toBe('gpt-4o-mini0718')
  })

  it('prices Azure usage locally and adds billed $ per day and model', async () => {
    const { getAzureUsage } = await import('../src/main/usage')
    const calls: string[] = []
    const f = (async (url: string, init?: any) => {
      calls.push(`${init?.method ?? 'GET'} ${url.split('?')[0]}`)
      const json = (j: any) => ({ ok: true, status: 200, json: async () => j, text: async () => '' })
      if (url.includes('ResourceGraph')) return json({ data: [{ id: '/subscriptions/s/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/res' }] })
      if (url.includes('metricnames=AzureOpenAI')) return json({ value: [] })
      if (url.includes('/metrics')) return json(metrics)
      if (url.includes('CostManagement')) return json({ properties: { columns: [{ name: 'Cost' }, { name: 'UsageDate' }, { name: 'Meter' }, { name: 'Currency' }], rows: [
        [3, 20261110, 'gpt 4o 1120 Inp regnl Tokens', 'USD'], [1.1, 20261110, 'gpt 4o 1120 Outp regnl Tokens', 'USD'], [0.5, 20261111, 'gpt 4o 1120 cached Inp regnl Tokens', 'USD']
      ] } })
      throw new Error('unexpected ' + url)
    }) as any
    const pricingFile = require('node:path').join(require('node:os').tmpdir(), `az-pricing-${process.pid}.json`)
    require('node:fs').writeFileSync(pricingFile, JSON.stringify(az))
    const r = await getAzureUsage([{ id: 'az', name: 'Azure', kind: 'azure', baseUrl: 'https://res.openai.azure.com', apiKey: 'k' }], 3650, pricingFile, '/nonexistent', f, async () => 'tok')
    expect(r.error).toBeUndefined()
    expect(calls[0]).toBe('POST https://management.azure.com/providers/Microsoft.ResourceGraph/resources')
    expect(calls).toContain('POST https://management.azure.com/subscriptions/s/resourceGroups/rg/providers/Microsoft.CostManagement/query')
    expect(r.resource).toMatch(/accounts\/res$/)
    // 1.3M uncached + 0.7M cached (see above) + 0.1M output
    expect(+r.total.cost!.toFixed(4)).toBe(+(1.3 * 2.75 + 0.7 * 1.375 + 0.1 * 11).toFixed(4))
    expect(+r.total.billed!.toFixed(2)).toBe(4.6)
    expect(r.byModel.find((m) => m.key === 'gpt-4o')!.billed).toBeCloseTo(4.6)
    expect(r.byDay.map((d) => [d.key, +(d.billed ?? 0).toFixed(2)])).toEqual([['2026-11-10', 4.1], ['2026-11-11', 0.5]])
    expect(r.warnings.some((w) => /93 days/.test(w))).toBe(true)
  })

  it('offers az login when the Azure CLI is installed but not signed in, and runs it', async () => {
    const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path')
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-az-'))
    const log = path.join(bin, 'calls')
    fs.writeFileSync(path.join(bin, 'az'), `#!/bin/sh\necho "$@" >> ${log}\nif [ "$1" = login ]; then touch ${bin}/ok; exit 0; fi\n[ -f ${bin}/ok ] && { echo tok; exit 0; }\necho "ERROR: Please run 'az login' to setup account." >&2; exit 1\n`, { mode: 0o755 })
    const oldPath = process.env.PATH
    process.env.PATH = `${bin}:${oldPath}`
    try {
      const { getAzureUsage, azureLogin, azureArmToken } = await import('../src/main/usage')
      const prov = { id: 'az', name: 'Azure', kind: 'azure' as const, baseUrl: 'https://res.openai.azure.com', apiKey: 'k', tenantId: 't1' }
      const r = await getAzureUsage([prov], 7, '', '/nonexistent')
      expect(r.needsAzLogin).toBe(true)
      expect(r.error).toMatch(/Sign in to Azure[\s\S]*az login/)
      expect(await azureLogin(prov)).toEqual({ ok: true })
      expect(fs.readFileSync(log, 'utf8')).toMatch(/^login .*--tenant t1/m)
      expect(await azureArmToken(prov)).toBe('tok')
    } finally { process.env.PATH = oldPath; fs.rmSync(bin, { recursive: true, force: true }) }
  })

  it('reports a missing Azure CLI without offering sign-in', async () => {
    const oldPath = process.env.PATH
    process.env.PATH = '/nonexistent'
    try {
      const { getAzureUsage } = await import('../src/main/usage')
      const r = await getAzureUsage([{ id: 'az', name: 'Azure', kind: 'azure', baseUrl: 'https://res.openai.azure.com', apiKey: 'k' }], 7, '', '/nonexistent')
      expect(r.needsAzLogin).toBeUndefined()
      expect(r.error).toMatch(/not found/)
    } finally { process.env.PATH = oldPath }
  })

  it('keeps the token report when Cost Management is forbidden', async () => {
    const { getAzureUsage } = await import('../src/main/usage')
    const f = (async (url: string) => url.includes('CostManagement')
      ? { ok: false, status: 403, json: async () => ({}), text: async () => 'AuthorizationFailed' }
      : { ok: true, status: 200, json: async () => (url.includes('metricnames=Input') ? metrics : { value: [] }), text: async () => '' }) as any
    const r = await getAzureUsage([{ id: 'az', name: 'Azure', kind: 'azure', baseUrl: 'https://res.openai.azure.com', apiKey: 'k', armResourceId: '/subscriptions/s/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/res' }], 7, '', '/nonexistent', f, async () => 'tok')
    expect(r.error).toBeUndefined()
    expect(r.total.billed).toBeUndefined()
    expect(r.billedError).toMatch(/Cost Management Reader/)
  })

  it('prices dated Azure model versions by their model line', () => {
    expect(pricingKey('azure::gpt-4.1-mini-2025-04-14', az)).toBe('gpt-4.1-mini')
  })
})
