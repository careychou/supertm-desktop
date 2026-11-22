import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { SessionRow, Store } from './store'
import type { Message } from '../engine/types'
import { COMPACT_TAG } from '../shared/fork'
import { COMPACT_ACK } from '../engine/compact'
import type { ExternalSource, SyncCandidate, SyncImportResult } from '../shared/sync'

/** Imported tool output is clipped so one huge log can't bloat the chat. */
const MAX_OUT = 20_000
const CONTINUED = '(conversation continued)'
const clip = (s: string, n = MAX_OUT) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters not imported)` : s)
const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v))
const ms = (v: unknown, fallback = 0) => { const t = typeof v === 'number' ? v : Date.parse(String(v ?? '')); return Number.isFinite(t) ? t : fallback }

type UiItem =
  | { t: 'user'; text: string }
  | { t: 'assistant'; agentId: 'main'; text: string; reasoning: string; closed: true }
  | { t: 'tool'; agentId: 'main'; callId: string; name: string; args: string; output?: string; ok?: boolean }
  | { t: 'compact'; auto: true; model: string; summarized: number; dropped: number; before: number; after: number; summary: string }

/** A converted chat: full detail for the transcript, and a provider-neutral text history for the model. */
export interface Converted { messages: Message[]; items: UiItem[]; compactOffset: number; turns: number }

/**
 * Accumulates turns from another tool's log. Tool calls stay detailed in the UI log, but the model history keeps one
 * plain assistant message per turn (text plus a tool tally) so it works with any provider and needs no tool replay.
 */
export class Converter {
  private items: UiItem[] = []
  private turns: Array<{ user: string; texts: string[]; tools: string[] }> = []
  private summary = ''
  private summaryAt = 0
  private tools = new Map<string, Extract<UiItem, { t: 'tool' }>>()
  constructor(private model: string) {}

  user(text: string) {
    text = text.trim()
    if (!text) return
    this.turns.push({ user: text, texts: [], tools: [] })
    this.items.push({ t: 'user', text })
  }
  private cur() { if (!this.turns.length) this.user(CONTINUED); return this.turns[this.turns.length - 1] }
  assistant(text: string, reasoning = '') {
    if (!text.trim() && !reasoning.trim()) return
    const t = this.cur()
    if (text.trim()) t.texts.push(text.trim())
    this.items.push({ t: 'assistant', agentId: 'main', text, reasoning, closed: true })
  }
  toolCall(callId: string, name: string, args: unknown) {
    this.cur().tools.push(name)
    const it: Extract<UiItem, { t: 'tool' }> = { t: 'tool', agentId: 'main', callId: callId || randomUUID(), name, args: clip(str(args), 4000) }
    this.items.push(it)
    if (callId) this.tools.set(callId, it)
  }
  toolResult(callId: string, output: unknown, ok: boolean) {
    const it = this.tools.get(callId)
    if (it) { it.output = clip(str(output)); it.ok = ok }
  }
  /** The other tool summarized its history here: earlier turns drop out of the model history but stay in the transcript. */
  compaction(summary: string) {
    if (!summary.trim()) return
    const before = this.turns.length
    this.summary = summary.trim()
    this.summaryAt = before
    this.items.push({ t: 'compact', auto: true, model: this.model, summarized: before, dropped: 0, before, after: 0, summary: this.summary })
  }

  done(): Converted {
    for (const it of this.tools.values()) if (it.output === undefined) { it.output = '(no result recorded)'; it.ok = false }
    const live = this.turns.slice(this.summaryAt)
    const messages: Message[] = this.summary
      ? [{ role: 'user', content: `${COMPACT_TAG}\nSummary of the earlier conversation (older turns were compacted):\n\n${this.summary}\n</compacted_history>` }, { role: 'assistant', content: COMPACT_ACK }]
      : []
    for (const t of live) {
      messages.push({ role: 'user', content: t.user })
      const tally = [...new Set(t.tools)].map((n) => { const k = t.tools.filter((x) => x === n).length; return k > 1 ? `${n} ×${k}` : n })
      const body = [t.texts.join('\n\n'), tally.length ? `(Tools used: ${tally.join(', ')})` : ''].filter(Boolean).join('\n\n')
      messages.push({ role: 'assistant', content: body || '(no response recorded)' })
    }
    return { messages, items: this.items, compactOffset: this.summaryAt, turns: this.turns.length }
  }
}

async function* lines(file: string): AsyncGenerator<any> {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const l of rl) {
    if (!l.trim()) continue
    try { yield JSON.parse(l) } catch { /* torn last line */ }
  }
}

// ── GitHub Copilot ────────────────────────────────────────────────────────────────────────────────────────────────
// <root>/session-store.db (sessions + turns) and <root>/session-state/<id>/{workspace.yaml, events.jsonl}

/** Accepts ~/.copilot, a copy of it, or its session-state folder. */
export function copilotRoot(p: string): string {
  const has = (d: string) => fs.existsSync(path.join(d, 'session-store.db')) || fs.existsSync(path.join(d, 'session-state'))
  if (has(p)) return p
  if (path.basename(p) === 'session-state' && has(path.dirname(p))) return path.dirname(p)
  throw new Error(`No GitHub Copilot sessions in ${p}. Pick the folder that holds session-store.db and session-state (usually ~/.copilot).`)
}

function parseYaml(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const l of text.split('\n')) {
    const m = /^(\w+):\s*(.*)$/.exec(l)
    if (m) out[m[1]] = m[2].replace(/^'(.*)'$/, (_, v) => v.replace(/''/g, "'")).replace(/^"(.*)"$/, '$1')
  }
  return out
}
function yaml(file: string): Record<string, string> {
  try { return parseYaml(fs.readFileSync(file, 'utf8')) } catch { return {} }
}
const yamlAsync = (file: string) => fs.promises.readFile(file, 'utf8').then(parseYaml, () => ({} as Record<string, string>))

/** Runs `fn` over `items` with at most `n` in flight. */
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]) }))
}

/** Opens the live store read-only (one quick query, no copy). If that fails (locked, or no -shm on a read-only share), reads a temp copy. */
function withCopilotDb<T>(root: string, fn: (db: DatabaseSync | null) => T): T {
  const src = path.join(root, 'session-store.db')
  if (!fs.existsSync(src)) return fn(null)
  const run = (file: string, opts: { readOnly?: boolean }) => {
    const db = new DatabaseSync(file, opts)
    try {
      const ok = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get()
      return { v: fn(ok ? db : null) }
    } finally { db.close() }
  }
  let opened: { v: T } | null = null
  try { opened = run(src, { readOnly: true }) } catch { /* fall back to a copy */ }
  if (opened) return opened.v
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-import-'))
  try {
    for (const ext of ['', '-wal']) if (fs.existsSync(src + ext)) fs.copyFileSync(src + ext, path.join(tmp, 'session-store.db' + ext))
    return run(path.join(tmp, 'session-store.db'), {}).v
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
}

/** Reports done / total as sessions are read or imported, for a progress bar. */
export type Progress = (done: number, total: number) => void

/**
 * Lists sessions from the store's index plus each small workspace.yaml (for renamed chats), so it stays quick when
 * ~/.copilot is on a network drive (OneDrive): event logs are never read here. `turns` is 0 when not counted (event
 * log only); the full chat, and any empty one, is read at import for the picked chats only.
 */
export async function scanCopilot(root: string, onProgress?: Progress): Promise<SyncCandidate[]> {
  const stateDir = path.join(root, 'session-state')
  const rows = withCopilotDb(root, (db) => {
    if (!db) return []
    const hasTurns = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'turns'").get()
    const sql = hasTurns
      ? `SELECT s.id, s.cwd, s.summary, s.created_at, s.updated_at, COUNT(t.turn_index) AS n,
           (SELECT user_message FROM turns f WHERE f.session_id = s.id ORDER BY turn_index LIMIT 1) AS first
         FROM sessions s LEFT JOIN turns t ON t.session_id = s.id GROUP BY s.id`
      : 'SELECT id, cwd, summary, created_at, updated_at, 0 AS n, NULL AS first FROM sessions'
    return db.prepare(sql).all() as Array<{ id: string; cwd: string | null; summary: string | null; created_at: string; updated_at: string; n: number; first: string | null }>
  })
  const dirs = fs.existsSync(stateDir) ? await fs.promises.readdir(stateDir) : []
  const inDb = new Map(rows.map((r) => [r.id, r]))
  const ids = [...new Set([...rows.map((r) => r.id), ...dirs])]
  const out: SyncCandidate[] = []
  let done = 0
  // only small files are touched (a stat and workspace.yaml), many at a time: on a network drive the wait is per file, not per byte
  await pool(ids, 16, async (id) => {
    const r = inDb.get(id)
    const dir = path.join(stateDir, id)
    const events = await fs.promises.access(path.join(dir, 'events.jsonl')).then(() => true, () => false)
    if (r?.n || events) {
      const w = await yamlAsync(path.join(dir, 'workspace.yaml'))
      const cwd = w.cwd || r?.cwd || ''
      const firstLine = (r?.first ?? '').trim().split('\n')[0].slice(0, 80)
      out.push({ id, title: w.name || r?.summary || w.summary || firstLine || 'Copilot session', cwd, model: '', updated_at: ms(w.updated_at, ms(r?.updated_at, ms(w.created_at))), parent_id: null, turns: r?.n ?? 0, local: null, group: cwd || '(no folder)' })
    }
    onProgress?.(++done, ids.length)
  })
  onProgress?.(ids.length, ids.length)
  return out.sort((a, b) => b.updated_at - a.updated_at)
}

/** Copilot event log → chat. Sub-agent events and injected notifications are left out; the main thread is kept. */
export async function convertCopilotEvents(file: string, model: string): Promise<Converted> {
  const c = new Converter(model)
  for await (const e of lines(file)) {
    const d = e?.data ?? {}
    if (e.agentId || d.parentToolCallId) continue
    switch (e.type) {
      case 'user.message': if (!d.source) c.user(str(d.content)); break
      case 'assistant.message':
        c.assistant(str(d.content), str(d.reasoningText))
        for (const r of d.toolRequests ?? []) c.toolCall(r.toolCallId, r.name, r.arguments)
        break
      case 'tool.execution_complete': c.toolResult(d.toolCallId, d.result?.content ?? d.error?.message ?? '', d.success !== false); break
      case 'session.compaction_complete': if (d.success !== false) c.compaction(str(d.summaryContent)); break
    }
  }
  return c.done()
}

function convertCopilotTurns(rows: Array<{ user_message: string | null; assistant_response: string | null }>, model: string): Converted {
  const c = new Converter(model)
  for (const r of rows) { c.user(r.user_message ?? ''); c.assistant(r.assistant_response ?? '') }
  return c.done()
}

// ── Claude Code ───────────────────────────────────────────────────────────────────────────────────────────────────
// ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl

/** Accepts ~/.claude, ~/.claude/projects, or one project folder. */
export function claudeFiles(p: string): string[] {
  const jsonl = (d: string) => fs.readdirSync(d).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(d, f))
  if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error(`${p} is not a folder`)
  if (fs.existsSync(path.join(p, 'projects'))) p = path.join(p, 'projects')
  const own = jsonl(p)
  const sub = fs.readdirSync(p).map((d) => path.join(p, d)).filter((d) => fs.statSync(d).isDirectory()).flatMap(jsonl)
  const files = [...own, ...sub]
  if (!files.length) throw new Error(`No Claude Code sessions in ${p}. Pick ~/.claude/projects or one project folder in it.`)
  return files
}

const NOISE = /^(<(command-name|command-message|local-command-|task-notification|system-reminder|user-prompt-submit-hook|bash-|relay )|\[Request interrupted)/
const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
/** Claude projects wrap a chat message in a <wake> envelope; keep just the message that triggered it. */
const unwrap = (t: string) => {
  if (!/^(@"[^"]*"\s*)?<wake /.test(t)) return t
  const m = /<message[^>]*trigger="true"[^>]*>([\s\S]*?)<\/message>/.exec(t) ?? /<message[^>]*>([\s\S]*?)<\/message>/.exec(t)
  return m ? unescape(m[1]) : t
}
const claudeUserText = (content: unknown): string => {
  if (typeof content === 'string') return unwrap(content)
  if (!Array.isArray(content) || content.some((b) => b?.type === 'tool_result')) return ''
  return content.map((b) => (b?.type === 'text' ? unwrap(b.text ?? '') : b?.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n')
}
const realPrompt = (e: any) => e.type === 'user' && !e.isMeta && !e.isSidechain && !e.isCompactSummary && (!e.origin?.kind || e.origin.kind === 'human')
  && (() => { const t = claudeUserText(e.message?.content).trim(); return !!t && !NOISE.test(t) })()

const PEEK = 64 * 1024
/** Whole lines from the first and last 64 KB of a file: enough for a session's folder, first prompt, title and times. */
function peekLines(file: string): { lines: any[]; whole: boolean } {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const read = (pos: number, len: number) => { const b = Buffer.alloc(len); return b.subarray(0, fs.readSync(fd, b, 0, len, pos)).toString('utf8') }
    const parse = (text: string, dropFirst: boolean, dropLast: boolean) => {
      const ls = text.split('\n')
      if (dropFirst) ls.shift()
      if (dropLast) ls.pop()
      return ls.flatMap((l) => { try { return l.trim() ? [JSON.parse(l)] : [] } catch { return [] } })
    }
    if (size <= 2 * PEEK) return { lines: parse(read(0, size), false, false), whole: true }
    return { lines: [...parse(read(0, PEEK), false, true), ...parse(read(size - PEEK, PEEK), true, false)], whole: false }
  } finally { fs.closeSync(fd) }
}

/**
 * Lists sessions by reading only the start and end of each log, so it stays quick on a network drive.
 * `turns` is counted for small logs and 0 (not counted) for large ones; import reads the picked chats in full.
 */
export async function scanClaude(p: string, onProgress?: Progress): Promise<SyncCandidate[]> {
  const out: SyncCandidate[] = []
  const files = claudeFiles(p)
  let done = 0
  for (const file of files) {
    onProgress?.(done++, files.length)
    let title = '', summary = '', first = '', cwd = '', start = 0, end = 0, turns = 0
    let peek: ReturnType<typeof peekLines>
    try { peek = peekLines(file) } catch { continue }
    for (const e of peek.lines) {
      if (e.type === 'custom-title' && e.customTitle) title = e.customTitle
      else if (e.type === 'summary' && e.summary) summary ||= e.summary
      if (e.timestamp) { const t = ms(e.timestamp); if (t) { start ||= t; end = Math.max(end, t) } }
      if (e.cwd && !cwd) cwd = e.cwd
      if (realPrompt(e)) { turns++; first ||= claudeUserText(e.message.content).trim().split('\n')[0].slice(0, 80) }
    }
    if (peek.whole && !turns) continue
    const proj = path.basename(path.dirname(file))
    out.push({
      id: file, title: title || summary || first || 'Claude session', cwd: cwd || proj, model: '', updated_at: end || fs.statSync(file).mtimeMs,
      parent_id: null, turns: peek.whole ? turns : 0, local: null, group: cwd || proj
    })
  }
  onProgress?.(files.length, files.length)
  return out.sort((a, b) => b.updated_at - a.updated_at)
}

export async function convertClaude(file: string, model: string): Promise<Converted & { cwd: string; title: string; start: number; end: number }> {
  const c = new Converter(model)
  let cwd = '', title = '', summary = '', start = 0, end = 0
  for await (const e of lines(file)) {
    if (e.type === 'custom-title' && e.customTitle) title = e.customTitle
    if (e.type === 'summary' && e.summary) summary = e.summary
    if (e.timestamp) { const t = ms(e.timestamp); if (t) { start ||= t; end = Math.max(end, t) } }
    if (e.cwd && !cwd) cwd = e.cwd
    if (e.isSidechain) continue
    const content = e.message?.content
    if (e.type === 'user') {
      if (e.isCompactSummary) { c.compaction(claudeUserText(content)); continue }
      if (Array.isArray(content)) for (const b of content) if (b?.type === 'tool_result') c.toolResult(b.tool_use_id, Array.isArray(b.content) ? b.content.map((x: any) => x?.text ?? '').join('\n') : b.content, !b.is_error)
      if (realPrompt(e)) c.user(claudeUserText(content))
    } else if (e.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'text') c.assistant(b.text ?? '')
        else if (b?.type === 'thinking' && b.thinking) c.assistant('', b.thinking)
        else if (b?.type === 'tool_use') c.toolCall(b.id, b.name, b.input)
      }
    }
  }
  return { ...c.done(), cwd, title: title || summary, start, end }
}

const firstPrompt = (c: Converted) => { const u = c.items.find((i) => i.t === 'user' && i.text !== CONTINUED); return u?.t === 'user' ? u.text.split('\n')[0].slice(0, 80) : '' }

// ── Import ────────────────────────────────────────────────────────────────────────────────────────────────────────

function save(store: Store, r: SyncImportResult, src: { title: string; cwd: string; created: number; updated: number; model: string }, conv: Converted) {
  if (!conv.turns) { r.skipped++; return }
  const row: SessionRow = {
    id: randomUUID(), title: src.title.replace(/\\n|\s+/g, ' ').trim().slice(0, 120), cwd: src.cwd || os.homedir(), model: src.model,
    created_at: src.created || src.updated, updated_at: src.updated || Date.now(), parent_id: null, fork_turn: null,
    compact_offset: conv.compactOffset || null
  }
  store.putSession(row)
  store.saveMessages(row.id, conv.messages)
  store.saveUiItems(row.id, conv.items)
  r.ids.push(row.id)
  r.added++
}

/** Imports chosen chats from another tool. Their IDs mean nothing here, so every chat gets a new UUID: never a conflict. */
/** Each picked chat is added as new, filed under `dest` (a working folder on this Mac) instead of the other tool's folder. */
export async function importExternal(store: Store, kind: ExternalSource, root: string, ids: string[], model: string, dest?: string, onProgress?: Progress): Promise<SyncImportResult> {
  const r: SyncImportResult = { added: 0, overwritten: 0, forked: 0, skipped: 0, ids: [] }
  if (kind === 'claude') {
    const known = new Set(claudeFiles(root))
    let done = 0
    for (const file of ids) {
      onProgress?.(done++, ids.length)
      if (!known.has(file)) { r.skipped++; continue }
      const conv = await convertClaude(file, model)
      save(store, r, { title: conv.title || firstPrompt(conv) || 'Claude session', cwd: dest || conv.cwd, created: conv.start, updated: conv.end, model }, conv)
    }
    return r
  }
  const stateDir = path.join(root, 'session-state')
  const meta = withCopilotDb(root, (db) => {
    const m = new Map<string, { cwd: string; summary: string; created: number; updated: number; turns: Array<{ user_message: string | null; assistant_response: string | null }> }>()
    if (!db) return m
    const hasTurns = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'turns'").get()
    const one = db.prepare('SELECT * FROM sessions WHERE id = ?')
    const turns = hasTurns ? db.prepare('SELECT user_message, assistant_response FROM turns WHERE session_id = ? ORDER BY turn_index') : null
    for (const id of ids) {
      const s = one.get(id) as any
      if (s) m.set(id, { cwd: s.cwd ?? '', summary: s.summary ?? '', created: ms(s.created_at), updated: ms(s.updated_at), turns: (turns?.all(id) as any[]) ?? [] })
    }
    return m
  })
  let done = 0
  for (const id of ids) {
    onProgress?.(done++, ids.length)
    const s = meta.get(id)
    const w = yaml(path.join(stateDir, id, 'workspace.yaml'))
    const events = path.join(stateDir, id, 'events.jsonl')
    const conv = fs.existsSync(events) ? await convertCopilotEvents(events, model) : convertCopilotTurns(s?.turns ?? [], model)
    save(store, r, { title: w.name || s?.summary || firstPrompt(conv) || 'Copilot session', cwd: dest || w.cwd || s?.cwd || '', created: ms(w.created_at, s?.created ?? 0), updated: ms(w.updated_at, s?.updated ?? 0), model }, conv)
  }
  return r
}

/** Default places to look, when they exist on this Mac. */
export function externalDefaults(): Record<ExternalSource, string | null> {
  const home = os.homedir()
  const ok = (p: string) => (fs.existsSync(p) ? p : null)
  return { copilot: ok(path.join(home, '.copilot', 'session-store.db')) ? path.join(home, '.copilot') : null, claude: ok(path.join(home, '.claude', 'projects')) }
}
