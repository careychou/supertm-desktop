import { describe, it, expect } from 'vitest'
import { applyBackground, type BgView } from '../src/renderer/src/background'
import type { PushEvent } from '../src/shared/api'

const sid = 's1'
const start: BgView = { items: [{ t: 'user', text: 'hello' } as never], perms: [], asks: [] }

describe('chat running off-screen', () => {
  it('keeps the streamed reply, permission and question cards instead of dropping them', () => {
    const events: PushEvent[] = [
      { type: 'agent', sessionId: sid, event: { kind: 'reasoning', agentId: 'main', text: 'thinking' } },
      { type: 'agent', sessionId: sid, event: { kind: 'text', agentId: 'main', text: 'the answer' } },
      { type: 'tokens', sessionId: sid, tokens: 1234 },
      { type: 'permission', sessionId: sid, requestId: 'p1', agentId: 'main', kind: 'shell', detail: 'ls' },
      { type: 'ask', sessionId: sid, requestId: 'a1', agentId: 'main', question: 'which?', choices: ['x', 'y'] }
    ]
    const v = events.reduce(applyBackground, start)
    expect(v.items[0]).toEqual(start.items[0])
    expect(JSON.stringify(v.items.slice(1))).toContain('the answer')
    expect(v.tokens).toBe(1234)
    expect(v.perms.map((p) => p.requestId)).toEqual(['p1'])
    expect(v.asks[0]).toMatchObject({ requestId: 'a1', choices: ['x', 'y'] })
    const done = applyBackground(v, { type: 'busy', sessionId: sid, busy: false })
    expect(done.perms).toEqual([])
    expect(done.asks).toEqual([])
    expect(done.items).toBe(v.items)
  })
})
