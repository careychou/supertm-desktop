import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { SessionRow, Store } from './store'
import type { Message } from '../engine/types'
import { BRAND } from '../shared/brand'
import type { SyncChoice, SyncCandidate, SyncImportResult, SyncManifest } from '../shared/sync'

const stem = BRAND.dbFile.replace(/\.db$/, '')
export const SYNC_DB = `${stem}-sessions.db`
export const SYNC_MANIFEST = `${stem}-sessions.json`

/** Writes the session database (every chat, or just `ids`) plus a small manifest into `dir`. */
export function exportSessions(store: Store, dir: string, app: string, now = Date.now(), ids?: string[]): SyncManifest {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, SYNC_DB)
  const tmp = file + '.tmp'
  store.exportTo(tmp)
  let sessions: number
  const db = new DatabaseSync(tmp)
  try {
    if (ids) {
      db.exec('CREATE TEMP TABLE keep (id TEXT PRIMARY KEY)')
      const ins = db.prepare('INSERT OR IGNORE INTO keep VALUES (?)')
      for (const id of ids) ins.run(id)
      for (const [t, col] of [['messages', 'session_id'], ['ui_items', 'session_id'], ['usage', 'session_id'], ['bookmarks', 'session_id'], ['sessions', 'id']]) {
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)) db.exec(`DELETE FROM ${t} WHERE ${col} IS NOT NULL AND ${col} NOT IN (SELECT id FROM keep)`)
      }
      db.exec('VACUUM')
    }
    sessions = (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n
  } finally { db.close() }
  fs.renameSync(tmp, file)
  const m: SyncManifest = { app, exportedAt: now, host: os.hostname(), sessions }
  fs.writeFileSync(path.join(dir, SYNC_MANIFEST), JSON.stringify(m, null, 2))
  return m
}

/** Accepts the export folder or the .db file itself. */
export function resolveSyncFile(p: string): string {
  const f = fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p, SYNC_DB) : p
  if (!fs.existsSync(f)) throw new Error(`No ${SYNC_DB} in ${p}. Pick the folder you exported to.`)
  return f
}

function openSource(file: string) {
  const db = new DatabaseSync(file, { readOnly: true })
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get()
  if (!has) { db.close(); throw new Error(`${file} is not an exported session database`) }
  return db
}

/** Sessions in an export, each marked with whether its UUID already exists locally and the time difference. */
export function scanSessions(store: Store, file: string): { manifest: SyncManifest | null; sessions: SyncCandidate[] } {
  const db = openSource(file)
  try {
    const rows = db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all() as unknown as SessionRow[]
    const turns = new Map((db.prepare("SELECT session_id, COUNT(*) AS n FROM ui_items WHERE json_extract(item_json, '$.t') = 'user' GROUP BY session_id").all() as any[]).map((r) => [r.session_id, r.n as number]))
    let manifest: SyncManifest | null = null
    try { manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(file), SYNC_MANIFEST), 'utf8')) } catch { /* optional */ }
    return {
      manifest,
      sessions: rows.map((r) => {
        const local = store.getSession(r.id)
        return {
          id: r.id, title: r.title, cwd: r.cwd, model: r.model, updated_at: r.updated_at, parent_id: r.parent_id, turns: turns.get(r.id) ?? 0,
          local: local ? { title: local.title, updated_at: local.updated_at } : null
        }
      })
    }
  } finally { db.close() }
}

/**
 * Imports the chosen sessions. New UUIDs are added as-is. For a UUID that already exists locally the choice decides:
 * `overwrite` replaces the local chat, `fork` adds it with a new UUID filed under the local chat, `skip` leaves both alone.
 */
export function importSessions(store: Store, file: string, picks: Array<{ id: string; choice?: SyncChoice }>, stateDirOf?: (id: string) => string): SyncImportResult {
  const db = openSource(file)
  const res: SyncImportResult = { added: 0, overwritten: 0, forked: 0, skipped: 0, ids: [] }
  try {
    const get = db.prepare('SELECT * FROM sessions WHERE id = ?')
    const msgs = db.prepare('SELECT content_json FROM messages WHERE session_id = ? ORDER BY seq')
    const items = db.prepare('SELECT item_json FROM ui_items WHERE session_id = ? ORDER BY id')
    const chosen = new Set(picks.map((p) => p.id))
    for (const { id, choice } of picks) {
      const src = get.get(id) as unknown as SessionRow | undefined
      if (!src) { res.skipped++; continue }
      const local = store.getSession(id)
      const c: SyncChoice = local ? choice ?? 'skip' : 'overwrite'
      if (c === 'skip') { res.skipped++; continue }
      let row: SessionRow = { ...src }
      if (local && c === 'fork') {
        row = { ...src, id: randomUUID(), parent_id: id, fork_turn: null, sort_order: null, title: `${src.title} · imported` }
      } else {
        // keep the import's own tree when its parent came along or already exists here; otherwise file it at the top level
        if (row.parent_id && !chosen.has(row.parent_id) && !store.getSession(row.parent_id)) row = { ...row, parent_id: null, fork_turn: null }
        if (local) { row.sort_order = local.sort_order ?? null; if (stateDirOf) fs.rmSync(stateDirOf(id), { recursive: true, force: true }) }
      }
      store.putSession(row)
      store.saveMessages(row.id, (msgs.all(id) as any[]).map((r) => JSON.parse(r.content_json) as Message))
      store.saveUiItems(row.id, (items.all(id) as any[]).map((r) => JSON.parse(r.item_json)))
      res.ids.push(row.id)
      if (!local) res.added++
      else if (c === 'fork') res.forked++
      else res.overwritten++
    }
  } finally { db.close() }
  return res
}
