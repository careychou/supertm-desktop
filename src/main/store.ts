import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { BRAND } from '../shared/brand'
import type { Message } from '../engine/types'
import { canNest, isWithin, orderRows, reorderIds, shownParent } from '../shared/fork'

export interface UsageRec { ts: number; session_id: string; agent_id: string; model: string; prompt: number; cached: number; cache_write: number; completion: number }
export interface SessionRow { id: string; title: string; cwd: string; model: string; created_at: number; updated_at: number; parent_id: string | null; fork_turn: number | null; reasoning?: string | null; mode?: string | null; memories?: string | null; sort_order?: number | null; compact_offset?: number | null; turn_map?: string | null }
export interface FolderRow { path: string; added_at: number; memory?: string | null }
/** A bookmark folder (id) or a pinned session (session_id), nested via parent_id (null = top of Bookmarks). */
export interface BookmarkRow { id: string; kind: 'folder' | 'pin'; name: string | null; session_id: string | null; parent_id: string | null; sort_order: number; collapsed: number }

/** SQLite persistence for sessions, the main-agent message history, and UI event log. */
export class Store {
  private db: DatabaseSync
  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true })
    this.db = new DatabaseSync(path.join(dir, BRAND.dbFile))
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, model TEXT, created_at INTEGER, updated_at INTEGER);
      CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, seq INTEGER, content_json TEXT);
      CREATE TABLE IF NOT EXISTS ui_items (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, item_json TEXT);
      CREATE INDEX IF NOT EXISTS ix_msg ON messages(session_id, seq);
      CREATE INDEX IF NOT EXISTS ix_ui ON ui_items(session_id, id);
      CREATE TABLE IF NOT EXISTS folders (path TEXT PRIMARY KEY, added_at INTEGER);
    `)
    const cols = (this.db.prepare('PRAGMA table_info(sessions)').all() as any[]).map((c) => c.name)
    if (!cols.includes('parent_id')) this.db.exec('ALTER TABLE sessions ADD COLUMN parent_id TEXT')
    if (!cols.includes('fork_turn')) this.db.exec('ALTER TABLE sessions ADD COLUMN fork_turn INTEGER')
    if (!cols.includes('reasoning')) this.db.exec('ALTER TABLE sessions ADD COLUMN reasoning TEXT')
    if (!cols.includes('turn_map')) this.db.exec('ALTER TABLE sessions ADD COLUMN turn_map TEXT')
    if (!cols.includes('compact_offset')) this.db.exec('ALTER TABLE sessions ADD COLUMN compact_offset INTEGER')
    if (!cols.includes('sort_order')) this.db.exec('ALTER TABLE sessions ADD COLUMN sort_order INTEGER')
    this.db.exec('CREATE TABLE IF NOT EXISTS bookmarks (id TEXT PRIMARY KEY, kind TEXT, name TEXT, session_id TEXT, parent_id TEXT, sort_order INTEGER, collapsed INTEGER DEFAULT 0)')
    this.db.exec('CREATE TABLE IF NOT EXISTS usage (ts INTEGER, session_id TEXT, agent_id TEXT, model TEXT, prompt INTEGER, cached INTEGER, cache_write INTEGER, completion INTEGER); CREATE INDEX IF NOT EXISTS usage_ts ON usage(ts)')
    if (!cols.includes('mode')) this.db.exec('ALTER TABLE sessions ADD COLUMN mode TEXT')
    if (!cols.includes('memories')) this.db.exec('ALTER TABLE sessions ADD COLUMN memories TEXT')
    if (!(this.db.prepare('PRAGMA table_info(folders)').all() as any[]).some((c) => c.name === 'memory')) this.db.exec('ALTER TABLE folders ADD COLUMN memory TEXT')
    this.db.exec('INSERT OR IGNORE INTO folders (path, added_at) SELECT DISTINCT cwd, MIN(created_at) FROM sessions GROUP BY cwd')
  }

  listFolders(): FolderRow[] {
    return this.db.prepare('SELECT * FROM folders ORDER BY added_at').all() as unknown as FolderRow[]
  }
  addFolder(p: string) {
    this.db.prepare('INSERT OR IGNORE INTO folders (path, added_at) VALUES (?, ?)').run(p, Date.now())
  }
  getFolder(p: string): FolderRow | undefined {
    return this.db.prepare('SELECT * FROM folders WHERE path = ?').get(p) as unknown as FolderRow | undefined
  }
  /** Folder memory (JSON, see shared/memory); null clears it. */
  setFolderMemory(p: string, memory: string | null) {
    this.addFolder(p)
    this.db.prepare('UPDATE folders SET memory = ? WHERE path = ?').run(memory, p)
  }
  removeFolder(p: string) {
    for (const s of this.listSessions().filter((x) => x.cwd === p)) this.deleteSession(s.id)
    this.db.prepare('DELETE FROM folders WHERE path = ?').run(p)
  }

  addUsage(u: UsageRec) {
    this.db.prepare('INSERT INTO usage (ts, session_id, agent_id, model, prompt, cached, cache_write, completion) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(u.ts, u.session_id, u.agent_id, u.model, u.prompt, u.cached, u.cache_write, u.completion)
  }
  /** Usage records since `ts`, with the chat title (null once the chat is deleted). */
  usageSince(ts: number): Array<UsageRec & { title: string | null }> {
    return this.db.prepare('SELECT u.*, s.title AS title FROM usage u LEFT JOIN sessions s ON s.id = u.session_id WHERE u.ts >= ? ORDER BY u.ts').all(ts) as any
  }

  listSessions(): SessionRow[] {
    return this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 1000').all() as unknown as SessionRow[]
  }
  private listAllSessions(): SessionRow[] {
    return this.db.prepare('SELECT * FROM sessions').all() as unknown as SessionRow[]
  }
  getSession(id: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as unknown as SessionRow | undefined
  }
  createSession(r: SessionRow) {
    this.db.prepare('INSERT INTO sessions (id, title, cwd, model, created_at, updated_at, parent_id, fork_turn, reasoning, mode, memories, compact_offset, turn_map) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.id, r.title, r.cwd, r.model, r.created_at, r.updated_at, r.parent_id, r.fork_turn, r.reasoning ?? null, r.mode ?? null, r.memories ?? null, r.compact_offset ?? null, r.turn_map ?? null)
    this.addFolder(r.cwd)
  }
  /** Persists a manual order for sibling sessions (index = position). Does not bump updated_at. */
  setOrder(ids: string[]) {
    const st = this.db.prepare('UPDATE sessions SET sort_order = ? WHERE id = ?')
    ids.forEach((id, i) => st.run(i, id))
  }
  /**
   * Files a chat under `parent` (null = top of its working folder); its own children come along. With `targetId` it is placed
   * before/after that sibling, otherwise it is listed first. Refuses another folder's chat and a chat's own subtree.
   * A chat that changes parent stops claiming a fork turn, since it was not forked from the new parent.
   */
  placeSession(id: string, parent: string | null, targetId: string | null = null, before = false): boolean {
    const all = this.listAllSessions()
    const row = all.find((s) => s.id === id)
    if (!row || !canNest(all, id, parent)) return false
    if (shownParent(all, id) !== parent || (row.parent_id ?? null) !== parent) this.db.prepare('UPDATE sessions SET parent_id = ?, fork_turn = NULL WHERE id = ?').run(parent, id)
    if (!targetId) { this.db.prepare('UPDATE sessions SET sort_order = NULL WHERE id = ?').run(id); return true }
    const after = this.listAllSessions()
    const sibs = orderRows(after.filter((s) => s.cwd === row.cwd && s.id !== id && shownParent(after, s.id) === parent))
    this.setOrder(reorderIds(sibs.map((s) => s.id), id, targetId, before))
    return true
  }

  listBookmarks(): BookmarkRow[] {
    return this.db.prepare('SELECT * FROM bookmarks ORDER BY sort_order').all() as unknown as BookmarkRow[]
  }
  private nextBookmarkOrder(parent: string | null) {
    const r = this.db.prepare('SELECT MAX(sort_order) AS m FROM bookmarks WHERE parent_id IS ?').get(parent) as any
    return (r?.m ?? -1) + 1
  }
  addBookmark(b: Omit<BookmarkRow, 'sort_order' | 'collapsed'>) {
    if (b.kind === 'pin' && this.db.prepare("SELECT 1 FROM bookmarks WHERE kind = 'pin' AND session_id = ?").get(b.session_id)) return
    this.db.prepare('INSERT INTO bookmarks (id, kind, name, session_id, parent_id, sort_order, collapsed) VALUES (?, ?, ?, ?, ?, ?, 0)')
      .run(b.id, b.kind, b.name, b.session_id, b.parent_id, this.nextBookmarkOrder(b.parent_id))
  }
  updateBookmark(id: string, patch: Partial<Pick<BookmarkRow, 'name' | 'parent_id' | 'collapsed'>>) {
    const cur = this.db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id) as unknown as BookmarkRow | undefined
    if (!cur) return
    const n = { ...cur, ...patch }
    const order = patch.parent_id !== undefined && patch.parent_id !== cur.parent_id ? this.nextBookmarkOrder(n.parent_id) : cur.sort_order
    this.db.prepare('UPDATE bookmarks SET name = ?, parent_id = ?, collapsed = ?, sort_order = ? WHERE id = ?').run(n.name, n.parent_id, n.collapsed, order, id)
  }
  /** Moves a bookmark under `parent` (null = top), positioned before/after `targetId` or appended. Refuses folder cycles. */
  placeBookmark(id: string, parent: string | null, targetId: string | null, before: boolean) {
    const all = this.listBookmarks()
    if (!all.some((b) => b.id === id) || (parent && isWithin(all, id, parent))) return
    this.db.prepare('UPDATE bookmarks SET parent_id = ? WHERE id = ?').run(parent, id)
    const sibs = all.filter((b) => b.parent_id === parent && b.id !== id).map((b) => b.id)
    this.setBookmarkOrder(reorderIds(sibs, id, targetId, before))
  }
  pinId(sessionId: string): string | undefined {
    return (this.db.prepare("SELECT id FROM bookmarks WHERE kind = 'pin' AND session_id = ?").get(sessionId) as any)?.id
  }
  setBookmarkOrder(ids: string[]) {
    const st = this.db.prepare('UPDATE bookmarks SET sort_order = ? WHERE id = ?')
    ids.forEach((id, i) => st.run(i, id))
  }
  /** Removes a bookmark; a folder's contents move up to its parent. */
  removeBookmark(id: string) {
    const cur = this.db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id) as unknown as BookmarkRow | undefined
    if (!cur) return
    this.db.prepare('UPDATE bookmarks SET parent_id = ? WHERE parent_id = ?').run(cur.parent_id, id)
    this.db.prepare('DELETE FROM bookmarks WHERE id = ?').run(id)
  }

  setTurnMap(id: string, map: number[]) { this.db.prepare('UPDATE sessions SET turn_map = ?, compact_offset = NULL WHERE id = ?').run(JSON.stringify(map), id) }

  /** Changes chat settings; does not move `updated_at`, which tracks the last turn (see touchSession). */
  updateSession(id: string, patch: Partial<Pick<SessionRow, 'title' | 'model' | 'cwd' | 'reasoning' | 'mode' | 'memories'>>) {
    const cur = this.getSession(id)
    if (!cur) return
    const n = { ...cur, ...patch }
    this.db.prepare('UPDATE sessions SET title = ?, model = ?, cwd = ?, reasoning = ?, mode = ?, memories = ? WHERE id = ?')
      .run(n.title, n.model, n.cwd, n.reasoning ?? null, n.mode ?? null, n.memories ?? null, id)
  }
  /** Records that a turn finished now (used for sidebar order and Sync sessions conflict checks). */
  touchSession(id: string, at = Date.now()) { this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(at, id) }
  /** Inserts or fully replaces a session row (Sync sessions import). Children and pins keep pointing at the same id. */
  putSession(r: SessionRow) {
    this.db.prepare('INSERT OR REPLACE INTO sessions (id, title, cwd, model, created_at, updated_at, parent_id, fork_turn, reasoning, mode, memories, compact_offset, turn_map, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.id, r.title, r.cwd, r.model, r.created_at, r.updated_at, r.parent_id, r.fork_turn, r.reasoning ?? null, r.mode ?? null, r.memories ?? null, r.compact_offset ?? null, r.turn_map ?? null, r.sort_order ?? null)
    this.addFolder(r.cwd)
  }
  /** Writes a consistent standalone copy of the whole database (works while it is open in WAL mode). */
  exportTo(file: string) {
    fs.rmSync(file, { force: true })
    this.db.prepare('VACUUM INTO ?').run(file)
  }
  /** Rewrites every session's model id (used when the primary provider changes). */
  remapModels(fn: (model: string) => string) {
    const up = this.db.prepare('UPDATE sessions SET model = ? WHERE id = ?')
    for (const r of this.db.prepare('SELECT id, model FROM sessions').all() as Array<{ id: string; model: string }>) {
      const m = fn(r.model ?? '')
      if (m !== r.model) up.run(m, r.id)
    }
  }
  /** Deletes a session; its forks are re-parented to the deleted session's parent. */
  deleteSession(id: string) {
    const row = this.getSession(id)
    this.db.prepare('UPDATE sessions SET parent_id = ? WHERE parent_id = ?').run(row?.parent_id ?? null, id)
    for (const t of ['messages', 'ui_items']) this.db.prepare(`DELETE FROM ${t} WHERE session_id = ?`).run(id)
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    this.db.prepare("DELETE FROM bookmarks WHERE kind = 'pin' AND session_id = ?").run(id)
  }

  /** Replaces the stored main-agent history (system message excluded). */
  saveMessages(sessionId: string, msgs: Message[]) {
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId)
      const ins = this.db.prepare('INSERT INTO messages (session_id, seq, content_json) VALUES (?, ?, ?)')
      msgs.forEach((m, i) => ins.run(sessionId, i, JSON.stringify(m)))
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
  }
  loadMessages(sessionId: string): Message[] {
    return (this.db.prepare('SELECT content_json FROM messages WHERE session_id = ? ORDER BY seq').all(sessionId) as any[]).map((r) => JSON.parse(r.content_json))
  }

  saveUiItems(sessionId: string, items: unknown[]) {
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM ui_items WHERE session_id = ?').run(sessionId)
      const ins = this.db.prepare('INSERT INTO ui_items (session_id, item_json) VALUES (?, ?)')
      for (const it of items) ins.run(sessionId, JSON.stringify(it))
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
  }
  loadUiItems(sessionId: string): unknown[] {
    return (this.db.prepare('SELECT item_json FROM ui_items WHERE session_id = ? ORDER BY id').all(sessionId) as any[]).map((r) => JSON.parse(r.item_json))
  }
}
