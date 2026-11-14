import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { BRAND } from '../shared/brand'

/** Where chats and settings live: $<envPrefix>_HOME, else an explicit --user-data-dir profile, else ~/<BRAND.homeDir>. */
export function resolveDataHome(o: { env: Record<string, string | undefined>; home: string; profileDir?: string }): string {
  return o.env[`${BRAND.envPrefix}_HOME`] || o.profileDir || path.join(o.home, BRAND.homeDir)
}

/**
 * One-time move from the old Electron userData folder. Copies (never moves) so the
 * old files remain as a backup; skipped once the new folder already has a database.
 */
export function migrateDataHome(from: string, to: string): string[] {
  if (path.resolve(from) === path.resolve(to)) return []
  const oldDb = path.join(from, BRAND.dbFile)
  const newDb = path.join(to, BRAND.dbFile)
  if (!fs.existsSync(oldDb) || fs.existsSync(newDb)) return []
  fs.mkdirSync(to, { recursive: true })
  const copied: string[] = []
  const src = new DatabaseSync(oldDb)
  try {
    // VACUUM INTO folds pending WAL pages into one consistent file.
    src.exec(`VACUUM INTO '${newDb.replace(/'/g, "''")}'`)
    copied.push(BRAND.dbFile)
  } finally {
    src.close()
  }
  const oldSettings = path.join(from, 'settings.json')
  if (fs.existsSync(oldSettings)) {
    fs.copyFileSync(oldSettings, path.join(to, 'settings.json'))
    copied.push('settings.json')
  }
  return copied
}
