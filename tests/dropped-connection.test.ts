// The connection to the model drops mid-reply ("terminated") or before replying ("fetch failed"):
// the agent retries and finish with the complete reply; the chat view shows
// "Trying again…" in place of the partial reply and clears it once the reply arrives.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Session } from '../src/engine/engine'
import type { AgentEvent, ChatRequest, Delta, Hooks, ModelAdapter } from '../src/engine/types'
import { applyEvent, settle, type Item } from '../src/renderer/src/state'

const dropped = () => Object.assign(new TypeError('terminated'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) })
const noResponse = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) })
type Step = Delta[] | 'drop-mid-reply' | Error
const say = (t: string): Delta[] => [{ type: 'text', text: t }, { type: 'finish', reason: 'stop' }]

class Flaky implements ModelAdapter {
  calls: ChatRequest[] = []
  constructor(private steps: Step[]) {}
  async *stream(req: ChatRequest): AsyncGenerator<Delta> {
    this.calls.push(structuredClone(req))
    const s = this.steps.shift() ?? say('no more steps')
    if (s instanceof Error) throw s
    if (s === 'drop-mid-reply') { yield { type: 'reasoning', text: 'Planning…' }; yield { type: 'text', text: 'Half an ans' }; throw dropped() }
    yield* s
  }
}

function mk(steps: Step[]) {
  const events: AgentEvent[] = []
  const hooks: Hooks = { onEvent: (e) => events.push(e), requestPermission: async () => 'allow', askUser: async () => '' }
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-'))
  const adapter = new Flaky(steps)
  const s = new Session({ adapter, hooks, cwd, model: 'm', home: path.join(cwd, 'nohome'), autoApprove: true, retryDelaysMs: [1, 1, 1] })
  return { s, events, adapter }
}

describe('dropped connections to the model', () => {
  it('retries a reply cut off mid-stream and keeps only the complete reply', async () => {
    const { s, events, adapter } = mk(['drop-mid-reply', noResponse(), say('The full answer.')])
    expect(await s.send('hi')).toEqual({ status: 'completed', text: 'The full answer.' })
    expect(adapter.calls).toHaveLength(3)
    expect(adapter.calls[2].messages).toEqual(adapter.calls[0].messages)
    const retries = events.filter((e) => e.kind === 'retry') as Extract<AgentEvent, { kind: 'retry' }>[]
    expect(retries.map((e) => [e.attempt, e.of, e.discarded])).toEqual([[2, 4, true], [3, 4, false]])
    expect(retries[0].reason).toBe('terminated (other side closed, UND_ERR_SOCKET)')
    expect(events.some((e) => e.kind === 'error')).toBe(false)
  })

  it('gives up after four tries with the real cause', async () => {
    const { s, adapter } = mk([dropped(), noResponse(), dropped(), dropped()])
    const r = await s.send('hi')
    expect(r).toEqual({ status: 'failed', text: 'Lost the connection to the model 4 times in a row. Last error: terminated (other side closed, UND_ERR_SOCKET)' })
    expect(adapter.calls).toHaveLength(4)
  })

  it('does not retry a request the provider rejected', async () => {
    const { s, adapter } = mk([Object.assign(new Error('HTTP 400: prompt is too long'), { status: 400 }), say('never')])
    expect((await s.send('hi')).status).toBe('failed')
    expect(adapter.calls).toHaveLength(1)
  })
})

describe('chat view during a retry', () => {
  const ev = (e: Partial<AgentEvent> & { kind: AgentEvent['kind'] }) => ({ agentId: 'main', ...e }) as AgentEvent
  it('replaces the partial reply with one "Trying again" line, then clears it', () => {
    let items: Item[] = [{ t: 'user', text: 'hi' }]
    for (const e of [ev({ kind: 'reasoning', text: 'Planning…' }), ev({ kind: 'text', text: 'Half' })]) items = applyEvent(items, e)
    items = applyEvent(items, ev({ kind: 'retry', attempt: 2, of: 4, delayMs: 2000, reason: 'terminated (other side closed)', discarded: true } as any))
    expect(items).toEqual([{ t: 'user', text: 'hi' }, { t: 'retry', agentId: 'main', text: 'terminated (other side closed). Trying again in 2s (try 2 of 4)…' }])
    items = applyEvent(items, ev({ kind: 'retry', attempt: 3, of: 4, delayMs: 5000, reason: 'fetch failed', discarded: false } as any))
    expect(items.filter((i) => i.t === 'retry')).toHaveLength(1)
    expect(settle(items).some((i) => i.t === 'retry')).toBe(false)
    items = applyEvent(applyEvent(items, ev({ kind: 'text', text: 'Full' })), ev({ kind: 'assistant_done', message: { role: 'assistant', content: 'Full' } } as any))
    expect(items).toEqual([{ t: 'user', text: 'hi' }, { t: 'assistant', agentId: 'main', text: 'Full', reasoning: '', closed: true }])
  })
  it('a final error replaces the note', () => {
    let items: Item[] = [{ t: 'retry', agentId: 'main', text: 'x' }]
    items = applyEvent(items, ev({ kind: 'error', message: 'gave up' }))
    expect(items).toEqual([{ t: 'error', text: 'gave up' }])
  })
})
