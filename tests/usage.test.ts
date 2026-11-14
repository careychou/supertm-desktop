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
