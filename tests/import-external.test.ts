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
  // the log is no newer than workspace.yaml unless a test says so
  const at = new Date('2026-01-04T00:00:00Z')
  fs.utimesSync(path.join(d, 'events.jsonl'), at, at)
  return root
}

/** The GitHub Copilot app's own database: names given in the app, forks, archiving. */
function copilotApp(root: string, rows: Array<[string, string, string, string | null, string | null]>) {
  const db = new DatabaseSync(path.join(root, 'data.db'))
  db.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, session_id TEXT, name_source TEXT, creator_session_id TEXT, archived_at TEXT)')
  const ins = db.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, ?)')
  rows.forEach(([sid, name, src, parent, archived], i) => ins.run(`w${i}`, name, sid, src, parent, archived))
  db.close()
}

describe('Import from GitHub Copilot', () => {
  it('lists sessions from the store index and workspace.yaml without reading event logs', async () => {
    const root = copilotFixture()
    expect(copilotRoot(path.join(root, 'session-state'))).toBe(root)
    const d = path.join(root, 'session-state', 'new1')
    jl(path.join(d, 'events.jsonl'), [{ type: 'user.message', data: { content: 'hi' } }])
    fs.writeFileSync(path.join(d, 'workspace.yaml'), "id: new1\ncwd: /w/new\nname: 'Fresh ''chat'''\nupdated_at: 2026-01-09T00:00:00Z\n")
    fs.mkdirSync(path.join(root, 'session-state', 'nolog'))
    // an unreadable log proves the scan never opens event logs
    fs.chmodSync(path.join(root, 'session-state', 's1', 'events.jsonl'), 0o000)
    const c = await scanCopilot(root)
    fs.chmodSync(path.join(root, 'session-state', 's1', 'events.jsonl'), 0o644)
    expect(c.map((s) => s.id)).toEqual(['new1', 's1', 's2'])
    expect(c[2]).toMatchObject({ title: 'hello two', turns: 2 })
    expect(c[0]).toMatchObject({ title: "Fresh 'chat'", cwd: '/w/new', turns: 0, turnsAtLeast: false })
    expect(c[1]).toMatchObject({ title: 'Named chat', cwd: '/w/one', local: null, group: '/w/one', turns: 0 })
  })

  it('reads the live store read-only and leaves it unchanged', async () => {
    const root = copilotFixture()
    const before = fs.statSync(path.join(root, 'session-store.db')).mtimeMs
    expect((await scanCopilot(root)).length).toBe(2)
    expect(fs.statSync(path.join(root, 'session-store.db')).mtimeMs).toBe(before)
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
    const other = new Store(path.join(tmp, 'other'))
    expect(other.getSession((await importExternal(other, 'copilot', root, ['s1'], 'm1', '/here')).ids[0])!.cwd).toBe('/here')
    // importing again skips by default instead of adding a second copy
    expect(await importExternal(store, 'copilot', root, ['s2'], 'm1')).toMatchObject({ added: 0, skipped: 1 })
  })

  it('takes the name from the Copilot app, the date from the event log and nests forks', async () => {
    const root = copilotFixture()
    // renamed in the app (user) beats workspace.yaml; an automatic app name only fills in when nothing else has one
    copilotApp(root, [['s1', 'Renamed in app', 'user', null, null], ['s2', 'App auto name', 'auto', 's1', '2026-01-09T00:00:00Z']])
    // the log kept growing after the store index and workspace.yaml stopped (s1's index says 0 turns, so no "+")
    const late = new Date('2026-02-01T00:00:00Z')
    fs.utimesSync(path.join(root, 'session-state', 's1', 'events.jsonl'), late, late)
    const c = await scanCopilot(root)
    const s1 = c.find((x) => x.id === 's1')!, s2 = c.find((x) => x.id === 's2')!
    expect(s1).toMatchObject({ title: 'Renamed in app', updated_at: late.getTime(), parent_id: null })
    expect(s2).toMatchObject({ title: 'App auto name', parent_id: 's1', archived: true })
    const r = await importExternal(store, 'copilot', root, ['s1', 's2'], 'm1')
    expect(store.getSession(r.ids[0])).toMatchObject({ title: 'Renamed in app', updated_at: late.getTime(), origin: 'copilot:s1' })
    expect(store.getSession(r.ids[1])!.parent_id).toBe(r.ids[0])
  })

  it('marks a lagging index turn count as a lower bound', async () => {
    const root = copilotFixture()
    const d = path.join(root, 'session-state', 's2')
    fs.mkdirSync(d, { recursive: true })
    jl(path.join(d, 'events.jsonl'), [{ type: 'user.message', data: { content: 'hello two' } }, { type: 'assistant.message', data: { content: 'hi' } }])
    const c = await scanCopilot(root)
    expect(c.find((x) => x.id === 's2')).toMatchObject({ turns: 2, turnsAtLeast: true })
  })

  it('works without the Copilot app database or with a different schema', async () => {
    const root = copilotFixture()
    const db = new DatabaseSync(path.join(root, 'data.db'))
    db.exec('CREATE TABLE workspaces (id TEXT, label TEXT)')
    db.close()
    expect((await scanCopilot(root)).find((x) => x.id === 's1')!.title).toBe('Named chat')
  })

  it('flags chats imported before and lets a re-import skip, overwrite in place or fork', async () => {
    const root = copilotFixture()
    const first = await importExternal(store, 'copilot', root, ['s1'], 'm1', '/mine')
    const id = first.ids[0]
    store.updateSession(id, { title: 'My local title' })
    const c = await scanCopilot(root, undefined, store)
    expect(c.find((x) => x.id === 's1')!.local).toMatchObject({ id, title: 'My local title' })
    expect(c.find((x) => x.id === 's2')!.local).toBeNull()
    expect(await importExternal(store, 'copilot', root, ['s1'], 'm1')).toMatchObject({ skipped: 1, added: 0 })
    const ov = await importExternal(store, 'copilot', root, ['s1'], 'm1', '/elsewhere', undefined, { s1: 'overwrite' })
    expect(ov).toMatchObject({ overwritten: 1, ids: [id] })
    expect(store.getSession(id)).toMatchObject({ title: 'Named chat', cwd: '/mine', origin: 'copilot:s1' })
    const fk = await importExternal(store, 'copilot', root, ['s1'], 'm1', undefined, undefined, { s1: 'fork' })
    expect(fk.forked).toBe(1)
    expect(store.getSession(fk.ids[0])).toMatchObject({ parent_id: id, cwd: '/mine', title: 'Named chat · imported' })
  })

  it('recognizes a chat imported before origins were recorded by its start time', async () => {
    const root = copilotFixture()
    const created = Date.parse('2026-01-01T00:00:00Z')
    store.createSession({ id: 'old', title: 'Old import', cwd: '/w', model: 'm', created_at: created, updated_at: created, parent_id: null, fork_turn: null })
    // two sessions start at the same moment in the fixture, so neither is guessed; give s1 its own start time
    fs.appendFileSync(path.join(root, 'session-state', 's1', 'workspace.yaml'), 'created_at: 2026-01-01T00:00:01Z\n')
    store.createSession({ id: 'old1', title: 'Old s1', cwd: '/w', model: 'm', created_at: created + 1000, updated_at: created, parent_id: null, fork_turn: null })
    const c = await scanCopilot(root, undefined, store)
    expect(c.find((x) => x.id === 's1')!.local).toMatchObject({ id: 'old1' })
  })

  it('reports progress while reading and importing, ending at done = total', async () => {
    const root = copilotFixture()
    const seen: Array<[number, number]> = []
    await scanCopilot(root, (d, t) => seen.push([d, t]))
    expect(seen.at(-1)).toEqual([seen.at(-1)![1], seen.at(-1)![1]])
    expect(seen.every(([d, t]) => d <= t && t >= 2)).toBe(true)
    const imp: Array<[number, number]> = []
    await importExternal(store, 'copilot', root, ['s1', 's2'], 'm1', undefined, (d, t) => imp.push([d, t]))
    expect(imp).toEqual([[0, 2], [1, 2]])
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
    // a big log is listed from its start and end only (turns not counted); import still reads all of it
    const big = path.join(proj, 'big.jsonl')
    jl(big, [
      { type: 'user', message: { role: 'user', content: 'big first ask' }, cwd: '/w/proj', timestamp: '2026-03-01T00:00:00Z' },
      ...Array.from({ length: 400 }, (_, i) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(500) + i }] } })),
      { type: 'user', message: { role: 'user', content: 'middle ask' } },
      ...Array.from({ length: 400 }, (_, i) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'y'.repeat(500) + i }] } })),
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'end' }] }, timestamp: '2026-03-02T00:00:00Z' }
    ])
    const c2 = await scanClaude(path.join(tmp, 'claude'))
    expect(c2[0]).toMatchObject({ id: big, title: 'big first ask', cwd: '/w/proj', turns: 0, updated_at: Date.parse('2026-03-02T00:00:00Z') })
    const rb = await importExternal(store, 'claude', path.join(tmp, 'claude'), [big], 'm2')
    expect((await scanClaude(path.join(tmp, 'claude'), undefined, store)).find((x) => x.id === big)!.local).toMatchObject({ id: rb.ids[0] })
    expect(store.loadMessages(rb.ids[0]).filter((m) => m.role === 'user')).toHaveLength(2)
    fs.rmSync(big)
    const r = await importExternal(store, 'claude', path.join(tmp, 'claude'), [f, '/etc/passwd'], 'm2')
    expect(r).toMatchObject({ added: 1, skipped: 1 })
    const s = store.getSession(r.ids[0])!
    expect(s).toMatchObject({ title: 'My Claude chat', cwd: '/w/proj', updated_at: Date.parse('2026-02-01T00:05:00Z') })
    const items = store.loadUiItems(s.id) as any[]
    expect(items.map((i) => i.t)).toEqual(['user', 'assistant', 'assistant', 'tool', 'assistant'])
    expect(items[3]).toMatchObject({ name: 'Bash', output: 'built', ok: true })
    expect(store.loadMessages(s.id)).toEqual([{ role: 'user', content: 'build it & ship' }, { role: 'assistant', content: 'Running.\n\nBuilt.\n\n(Tools used: Bash)' }])
    // already imported: a fork goes under the earlier copy, in its folder, whatever `dest` says
    const fk = await importExternal(store, 'claude', path.join(tmp, 'claude'), [f], 'm2', '/here', undefined, { [f]: 'fork' })
    expect(fk.forked).toBe(1)
    expect(store.getSession(fk.ids[0])).toMatchObject({ parent_id: s.id, cwd: '/w/proj' })
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
