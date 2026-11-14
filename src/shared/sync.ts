/** What to do with an imported session whose UUID already exists on this Mac. */
export type SyncChoice = 'overwrite' | 'fork' | 'skip'
export interface SyncManifest { app: string; exportedAt: number; host: string; sessions: number }
export interface SyncCandidate {
  id: string; title: string; cwd: string; model: string; updated_at: number; parent_id: string | null; turns: number
  /** The local chat with the same UUID, if any. */
  local: { title: string; updated_at: number } | null
}
export interface SyncImportResult { added: number; overwritten: number; forked: number; skipped: number; ids: string[] }

/** "2 h 5 min newer" / "3 days older" / "same time": the import's last turn compared with the local one. */
export function ageDiff(imported: number, local: number): string {
  const d = imported - local
  const a = Math.abs(d)
  if (a < 60_000) return 'same time'
  const min = Math.round(a / 60_000), h = Math.floor(min / 60), days = Math.floor(h / 24)
  const span = days >= 1 ? `${days} day${days > 1 ? 's' : ''}${h % 24 ? ` ${h % 24} h` : ''}` : h >= 1 ? `${h} h${min % 60 ? ` ${min % 60} min` : ''}` : `${min} min`
  return `${span} ${d > 0 ? 'newer' : 'older'}`
}
