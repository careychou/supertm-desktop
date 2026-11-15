import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { FolderLock } from '../../shared/plugins'
import { BRAND } from '../../shared/brand'
import { githubDir } from './config'

export const lockFile = () => BRAND.folderConfig.replace(/\.json$/, '') + '.lock.json'
const lockPath = (folder: string) => path.join(githubDir(folder), lockFile())

/** The folder's lock; keys added by other parts of the app are kept. */
export function loadLock<T extends FolderLock = FolderLock>(folder: string): T {
  try {
    const l = JSON.parse(fs.readFileSync(lockPath(folder), 'utf8'))
    return { ...l, version: 1, plugins: l.plugins ?? {} }
  } catch { return { version: 1, plugins: {} } as T }
}

export function saveLock(folder: string, l: FolderLock): void {
  fs.mkdirSync(githubDir(folder), { recursive: true })
  fs.writeFileSync(lockPath(folder), JSON.stringify(l, null, 2) + '\n')
}

export const sha256File = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')

/** All files under `root` (recursive), as forward-slash paths relative to `base`. */
export function listFiles(root: string, base = root): string[] {
  const out: string[] = []
  let entries: fs.Dirent[] = []
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = path.join(root, e.name)
    if (e.isDirectory()) out.push(...listFiles(p, base))
    else if (e.isFile()) out.push(path.relative(base, p).split(path.sep).join('/'))
  }
  return out
}

/** relpath (under .github/) → sha256. */
export function hashFiles(ghDir: string, rels: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of rels) { try { out[r] = sha256File(path.join(ghDir, r)) } catch { /* vanished */ } }
  return out
}

/** Lock-listed files that were edited or deleted since install. */
export function modifiedFiles(ghDir: string, files: Record<string, string>): string[] {
  const out: string[] = []
  for (const [r, h] of Object.entries(files)) {
    const p = path.join(ghDir, r)
    if (!fs.existsSync(p)) { out.push(r); continue }
    try { if (sha256File(p) !== h) out.push(r) } catch { out.push(r) }
  }
  return out
}
