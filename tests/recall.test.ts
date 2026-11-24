import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../src/main/store'
import { applyCompaction, priorSummary, removedCount, splitHistoryTurns } from '../src/engine/compact'
import { buildUserContent } from '../src/engine/content'
import { coverage, entryOf, formatHints, formatResults, ftsQuery, pickHints, recallTool, stripHints, type RecallHit } from '../src/engine/recall'
import type { Message } from '../src/engine/types'

const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, cwd: '/w', model: 'm', created_at: 1, updated_at: 1, parent_id: null, fork_turn: null, ...extra })
const turn = (user: string, answer: string): Message[] => [{ role: 'user', content: user }, { role: 'assistant', content: answer }]
const hit = (over: Partial<RecallHit> = {}): RecallHit => ({ sessionId: 'a', turn: 0, user: 'pick the retry threshold', answer: 'We chose 7 attempts.', tools: '', ts: 0, title: 'Retry', cwd: '/w', current: true, ...over })

let tmp: string, store: Store
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-')); store = new Store(tmp) })
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('recall: index entries', () => {
  it('keeps the prompt and answer, names attachments without their body, and drops hints', () => {
    const user = buildUserContent('Check the budget', [{ kind: 'text', name: 'plan.csv', text: 'SECRETBODY,1,2' }], formatHints([hit()])) as string
    const [t] = splitHistoryTurns(turn(user, 'Budget is fine.'))
    const e = entryOf(t, 4, 9)!
    expect(e).toMatchObject({ turn: 4, answer: 'Budget is fine.', ts: 9 })
    expect(e.user).toContain('Check the budget')
    expect(e.user).toContain('[attached: plan.csv]')
    expect(e.user).not.toContain('SECRETBODY')
    expect(e.user).not.toContain('recall_hints')
  })
  it('hints are attached after the prompt and attachments, and stripHints removes them', () => {
    const h = formatHints([hit({ inContext: false })])
    const c = buildUserContent('hello', [{ kind: 'text', name: 'a.txt', text: 'x' }], h) as string
    expect(c.endsWith(h)).toBe(true)
    expect(stripHints(c)).toBe(buildUserContent('hello', [{ kind: 'text', name: 'a.txt', text: 'x' }]))
    expect(buildUserContent('hello', [], '')).toBe('hello')
  })
})

describe('recall: hint gate', () => {
  it('attaches nothing when too few of the prompt terms match', () => {
    expect(pickHints('what retry threshold did we choose', [hit()])).toHaveLength(1)
    expect(pickHints('draft an email about the holiday schedule and retry', [hit()])).toHaveLength(0)
    expect(pickHints('threshold', [hit()])).toHaveLength(0)
    expect(formatHints([])).toBe('')
  })
  it('caps the number of hints and matches word forms', () => {
    const many = Array.from({ length: 9 }, (_, i) => hit({ turn: i }))
    expect(pickHints('retry threshold', many)).toHaveLength(4)
    expect(coverage('thresholds picked', hit()).matched).toBe(2)
  })
  it('says whether a turn is still in the conversation', () => {
    expect(formatHints([hit({ inContext: true, turn: 2 })])).toContain('turn 3 (still in the conversation above)')
    expect(formatHints([hit({ inContext: false })])).toContain('removed by compaction')
    expect(formatHints([hit({ current: false, title: 'Other chat' })])).toContain('chat "Other chat", turn 1')
  })
})

describe('recall: store index and search', () => {
  it('finds a turn by keyword, with stemming, and scopes by chat and folder', () => {
    store.createSession(row('a')); store.createSession(row('b')); store.createSession(row('c', { cwd: '/other' }))
    store.saveMessages('a', [...turn('Pick the retry threshold for job 552', 'We chose 7 attempts.'), ...turn('Now plot weekly sales', 'Done.')])
    store.saveMessages('b', turn('Summarise the vendor meeting', 'The vendor agreed to new thresholds in March.'))
    store.saveMessages('c', turn('Threshold tuning for the alert job', 'Set to 40.'))
    for (const id of ['a', 'b', 'c']) store.indexSession(id)
    expect(store.searchTurns('thresholds', 'session', 'a').map((h) => [h.sessionId, h.turn])).toEqual([['a', 0]])
    expect(store.searchTurns('threshold', 'folder', 'a').map((h) => h.sessionId).sort()).toEqual(['a', 'b'])
    expect(store.searchTurns('threshold', 'all', 'a').map((h) => h.sessionId).sort()).toEqual(['a', 'b', 'c'])
    expect(store.searchTurns('threshold', 'all', 'a').find((h) => h.sessionId === 'a')!.current).toBe(true)
    expect(store.searchTurns('the and of', 'all', 'a')).toEqual([])
    expect(store.searchTurns('"quoted" (threshold) AND -x:*', 'all', 'a').length).toBe(3)
  })
  it('fills in turns compacted before recall existed from the saved transcript, without replacing indexed rows', () => {
    store.createSession(row('a', { compact_offset: 2 }))
    store.saveMessages('a', turn('Export the forecast', 'Exported to forecast.csv.'))
    store.saveUiItems('a', [
      { t: 'user', text: 'Pick the warehouse for the pilot' }, { t: 'tool', agentId: 'main', name: 'shell' }, { t: 'assistant', agentId: 'main', text: 'draft' },
      { t: 'assistant', agentId: 'main', text: 'We picked the Laredo warehouse.' },
      { t: 'user', text: 'Plot it' }, { t: 'assistant', agentId: 'sub1', text: 'Laredo subagent chatter' }, { t: 'assistant', agentId: 'main', text: 'Plotted.' },
      { t: 'compact' }, { t: 'user', text: 'Export the forecast' }, { t: 'assistant', agentId: 'main', text: 'transcript copy' },
    ])
    store.indexSession('a')
    expect(store.indexTranscript('a')).toBe(2)
    const hit = store.searchTurns('laredo warehouse', 'session', 'a')
    expect(hit.map((h) => [h.turn, h.answer, h.tools])).toEqual([[0, 'We picked the Laredo warehouse.', 'shell']])
    expect(store.searchTurns('forecast', 'session', 'a')[0].answer).toBe('Exported to forecast.csv.')
    expect(store.indexTranscript('a')).toBe(0)
  })
  it('searches a chat picked by name, in any folder, and says so when no chat has that name', async () => {
    store.createSession(row('a')); store.createSession(row('v', { title: 'desktop - Vertex Model', cwd: '/other' })); store.createSession(row('x', { title: 'Pricing review', cwd: '/other' }))
    store.saveMessages('v', turn('Which credentials for the provider?', 'Use the service account file.'))
    store.saveMessages('x', turn('Provider credentials for pricing', 'Use the vault.'))
    for (const id of ['v', 'x']) store.indexSession(id)
    expect(store.sessionsNamed('vertex model').map((r) => r.id)).toEqual(['v'])
    const search = (q: string, scope: any, limit: number, chat?: string) => {
      if (!chat) return store.searchTurns(q, scope, 'a', limit)
      const named = store.sessionsNamed(chat)
      return named.length ? store.searchTurns(q, scope, 'a', limit, named.map((r) => r.id)) : `No chat is named "${chat}".`
    }
    const tool = recallTool(search)
    expect(await tool.run({ query: 'credentials' }, {} as any)).toContain('No earlier turns')
    const out = await tool.run({ query: 'credentials', chat: 'Vertex Model' }, {} as any)
    expect(out).toContain('service account file'); expect(out).not.toContain('vault')
    expect(await tool.run({ query: 'credentials', chat: 'nope' }, {} as any)).toBe('No chat is named "nope".')
    expect(await tool.run({ query: 'zebra', chat: 'Vertex' }, {} as any)).toContain('No turns in chats named "Vertex"')
  })
  it('keeps compacted turns searchable under their original turn number', () => {
    store.createSession(row('a'))
    const hist = [...turn('Decide the cutoff: use 17 days', 'Cutoff set to 17 days.'), ...turn('Build the chart', 'Built.'), ...turn('Export it', 'Exported.')]
    store.saveMessages('a', hist); store.indexSession('a')
    const next = applyCompaction(hist, 'They set a cutoff and built a chart.', [2], 2)
    store.setTurnMap('a', [2]); store.saveMessages('a', next)
    store.saveMessages('a', [...next, ...turn('Add a legend', 'Legend added.')])
    expect(store.indexSession('a')).toBe(1)
    expect(store.searchTurns('cutoff days', 'session', 'a')[0]).toMatchObject({ turn: 0, answer: 'Cutoff set to 17 days.' })
    expect(store.searchTurns('legend', 'session', 'a')[0].turn).toBe(3)
    expect(store.searchTurns('summary compacted', 'session', 'a')).toEqual([])
  })
  it('re-indexing an unchanged chat writes nothing; a changed answer replaces the row', () => {
    store.createSession(row('a'))
    store.saveMessages('a', turn('Find zebra counts', 'Working'))
    expect(store.indexSession('a')).toBe(1)
    expect(store.indexSession('a')).toBe(0)
    store.saveMessages('a', turn('Find zebra counts', 'There are 12 zebras.'))
    expect(store.indexSession('a')).toBe(1)
    expect(store.searchTurns('zebra', 'session', 'a')).toHaveLength(1)
    expect(store.searchTurns('working', 'session', 'a')).toHaveLength(0)
  })
  it('backfill list, fork copy and delete', () => {
    store.createSession(row('a')); store.createSession(row('empty'))
    store.saveMessages('a', [...turn('alpha topic', 'one'), ...turn('beta topic', 'two')])
    expect(store.unindexedSessions().map((r) => r.id)).toEqual(['a'])
    store.indexSession('a')
    expect(store.unindexedSessions()).toEqual([])
    store.createSession(row('f', { parent_id: 'a', fork_turn: 0 }))
    store.copyTurnIndex('a', 'f', 0)
    expect(store.searchTurns('alpha', 'session', 'f')).toHaveLength(1)
    expect(store.searchTurns('beta', 'session', 'f')).toHaveLength(0)
    store.deleteSession('a')
    expect(store.searchTurns('alpha', 'all', 'f').map((h) => h.sessionId)).toEqual(['f'])
    store.clearTurnIndex('f')
    expect(store.searchTurns('alpha', 'all', 'f')).toEqual([])
  })
})

describe('recall: compaction note and tool', () => {
  it('the summary message notes removed turns; the note is not merged into the next summary', () => {
    const hist = [...turn('one', 'a'), ...turn('two', 'b'), ...turn('three', 'c')]
    const next = applyCompaction(hist, 'SUMMARY', [2], 2)
    expect(next[0].content as string).toContain('2 earlier turns were removed')
    expect(priorSummary(next)).toBe('Summary of the earlier conversation (older turns were compacted):\n\nSUMMARY')
    expect(removedCount(next)).toBe(2)
    expect(removedCount(applyCompaction(hist, 'SUMMARY', [2]))).toBe(0)
    expect(splitHistoryTurns(next)).toHaveLength(1)
  })
  it('the tool validates input, defaults to this chat and formats results', async () => {
    const calls: unknown[] = []
    const t = recallTool((q, scope, limit) => { calls.push([q, scope, limit]); return [hit({ inContext: false }), hit({ turn: 5, inContext: true })] })
    expect(t.permission).toBeUndefined()
    expect(await t.run({ query: ' a ' }, {} as any)).toContain('at least one keyword')
    const out = await t.run({ query: 'retry threshold', limit: 99 }, {} as any)
    expect(calls).toEqual([['retry threshold', 'session', 10]])
    expect(out).toContain('ASSISTANT: We chose 7 attempts.')
    expect(out).toContain('turn 6 (still in the conversation above)')
    expect(formatResults('x', [])).toContain('No earlier turns match')
    expect(ftsQuery('job-552 "x" OR')).toBe('"job" OR "552"')
  })
})
