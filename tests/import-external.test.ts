import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../src/main/store'
import { exportSessions, resolveSyncFile, scanSessions } from '../src/main/sync'
import { copilotRoot, importExternal, scanClaude, scanCopilot } from '../src/main/import-external'

let tmp: string, store: Store
const jl = (f: string, rows: object[]) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n') }
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-')); store = new Store(path.join(tmp, 'home')) })

function copilotFixture() {
  const root = path.join(tmp, 'copilot')
  fs.mkdirSync(path.join(root, 'session-state'), { recursive: true })
  const db = new DatabaseSync(path.join(root, 'session-store.db'))
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, summary TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE turns (session_id TEXT, turn_index INTEGER, user_message TEXT, assistant_response TEXT, timestamp TEXT);
    INSERT INTO sessions VALUES ('s1', '/w/one', 'Summary one', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z');
    INSERT INTO sessions VALUES ('s2', '/w/two', NULL, '2026-01-01T00:00:00Z', '2026-01-03T00:00:00Z');
    INSERT INTO sessions VALUES ('empty', '/w', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    INSERT INTO turns VALUES ('s2', 0, 'hello two', 'hi there', ''), ('s2', 1, 'more', 'ok', '');`)
  db.close()
  // s1 has an event log (preferred over the turns table), with a sub-agent and a notification to filter out
  const d = path.join(root, 'session-state', 's1')
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, 'workspace.yaml'), 'id: s1\ncwd: /w/one\nname: Named chat\nupdated_at: 2026-01-05T00:00:00Z\n')
  jl(path.join(d, 'events.jsonl'), [
    { type: 'session.start', data: {} },
    { type: 'user.message', data: { content: 'first ask', transformedContent: 'INJECTED first ask' } },
    { type: 'assistant.message', data: { content: 'Let me look.', reasoningText: 'thinking…', toolRequests: [{ toolCallId: 'c1', name: 'bash', arguments: { command: 'ls' } }] } },
    { type: 'assistant.message', agentId: 'sub', data: { content: 'sub-agent chatter' } },
    { type: 'tool.execution_complete', data: { toolCallId: 'c1', success: true, result: { content: 'a.txt' } } },
    { type: 'assistant.message', data: { content: 'Found a.txt', toolRequests: [] } },
    { type: 'user.message', data: { content: 'Session "x" finished processing.', source: 'agent-workspace-1' } },
    { type: 'session.compaction_complete', data: { success: true, summaryContent: 'Earlier: listed files.' } },
    { type: 'user.message', data: { content: 'second ask' } },
    { type: 'assistant.message', data: { content: 'Done.' } }
  ])
  return root
}

describe('Import from GitHub Copilot', () => {
  it('lists sessions with turns from the store and event logs, named from workspace.yaml', async () => {
    const root = copilotFixture()
    expect(copilotRoot(path.join(root, 'session-state'))).toBe(root)
    const c = await scanCopilot(root)
    expect(c.map((s) => s.id)).toEqual(['s1', 's2'])
    expect(c[0]).toMatchObject({ title: 'Named chat', cwd: '/w/one', local: null, group: '/w/one', turns: 2 })
    expect(c[1]).toMatchObject({ title: 'hello two', turns: 2 })
  })

  it('imports with new UUIDs, keeps tool detail in the transcript and a compacted text history', async () => {
    const root = copilotFixture()
    const r = await importExternal(store, 'copilot', root, ['s1', 's2'], 'm1')
    expect(r).toMatchObject({ added: 2, skipped: 0 })
    expect(r.ids).not.toContain('s1')
    const s1 = store.getSession(r.ids[0])!
    expect(s1).toMatchObject({ title: 'Named chat', cwd: '/w/one', model: 'm1', compact_offset: 1, updated_at: Date.parse('2026-01-05T00:00:00Z') })
    const items = store.loadUiItems(s1.id) as any[]
    expect(items.map((i) => i.t)).toEqual(['user', 'assistant', 'tool', 'assistant', 'compact', 'user', 'assistant'])
    expect(items[0].text).toBe('first ask')
    expect(items[2]).toMatchObject({ name: 'bash', output: 'a.txt', ok: true })
    const msgs = store.loadMessages(s1.id)
    expect(msgs[0].content).toContain('Earlier: listed files.')
    expect(msgs.slice(2)).toEqual([{ role: 'user', content: 'second ask' }, { role: 'assistant', content: 'Done.' }])
    expect(store.loadMessages(r.ids[1])).toHaveLength(4)
    expect(store.getSession((await importExternal(store, 'copilot', root, ['s1'], 'm1', '/here')).ids[0])!.cwd).toBe('/here')
    // importing again just adds another copy: never a conflict
    expect((await importExternal(store, 'copilot', root, ['s2'], 'm1')).added).toBe(1)
  })
})

describe('Import from Claude Code', () => {
  it('lists project sessions and imports the main thread only', async () => {
    const proj = path.join(tmp, 'claude', 'projects', '-w-proj')
    const f = path.join(proj, 'abc.jsonl')
    jl(f, [
      { type: 'custom-title', customTitle: 'My Claude chat' },
      { type: 'user', isMeta: true, message: { role: 'user', content: '<local-command-caveat>x</local-command-caveat>' }, cwd: '/w/proj', timestamp: '2026-02-01T00:00:00Z' },
      { type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' }, timestamp: '2026-02-01T00:00:01Z' },
      { type: 'user', message: { role: 'user', content: '<wake reason="mention"><thread><message trigger="true" from="human">build it &amp; ship</message></thread></wake>' }, cwd: '/w/proj', timestamp: '2026-02-01T00:00:02Z' },
      { type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: '<relay from="coordinator">note</relay>' } },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Running.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'make' } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'built', is_error: false }] } },
      { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'sidechain' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Built.' }] }, timestamp: '2026-02-01T00:05:00Z' }
    ])
    jl(path.join(proj, 'empty.jsonl'), [{ type: 'summary', summary: 'nothing' }])
    const c = await scanClaude(path.join(tmp, 'claude'))
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ id: f, title: 'My Claude chat', cwd: '/w/proj', turns: 1, local: null })
    const r = await importExternal(store, 'claude', path.join(tmp, 'claude'), [f, '/etc/passwd'], 'm2')
    expect(r).toMatchObject({ added: 1, skipped: 1 })
    const s = store.getSession(r.ids[0])!
    expect(s).toMatchObject({ title: 'My Claude chat', cwd: '/w/proj', updated_at: Date.parse('2026-02-01T00:05:00Z') })
    const items = store.loadUiItems(s.id) as any[]
    expect(items.map((i) => i.t)).toEqual(['user', 'assistant', 'assistant', 'tool', 'assistant'])
    expect(items[3]).toMatchObject({ name: 'Bash', output: 'built', ok: true })
    expect(store.loadMessages(s.id)).toEqual([{ role: 'user', content: 'build it & ship' }, { role: 'assistant', content: 'Running.\n\nBuilt.\n\n(Tools used: Bash)' }])
    expect(store.getSession((await importExternal(store, 'claude', path.join(tmp, 'claude'), [f], 'm2', '/here')).ids[0])!.cwd).toBe('/here')
  })
})

describe('Export selected sessions', () => {
  it('writes only the chosen chats', () => {
    for (const id of ['a', 'b', 'c']) { store.createSession({ id, title: id, cwd: '/w', model: 'm', created_at: 1, updated_at: 1, parent_id: null, fork_turn: null }); store.saveUiItems(id, [{ t: 'user', text: id }]) }
    const m = exportSessions(store, path.join(tmp, 'out'), 'T', 1, ['a', 'c'])
    expect(m.sessions).toBe(2)
    const other = new Store(path.join(tmp, 'other'))
    expect(scanSessions(other, resolveSyncFile(path.join(tmp, 'out'))).sessions.map((s) => s.id).sort()).toEqual(['a', 'c'])
  })
})
