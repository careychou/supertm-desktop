import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** File types that open in their default app on a click. Anything else (scripts, apps, installers, archives) is shown in Finder instead, so a link in a chat can never run something. */
const OPENABLE = new Set(['html', 'htm', 'pdf', 'md', 'markdown', 'txt', 'log', 'csv', 'tsv', 'json', 'jsonl', 'xml', 'yaml', 'yml', 'toml', 'ini',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'heic', 'bmp', 'tiff', 'mp3', 'wav', 'ogg', 'm4a', 'mp4', 'mov', 'webm',
  'xlsx', 'xls', 'xlsm', 'docx', 'doc', 'pptx', 'ppt', 'rtf', 'key', 'numbers', 'pages', 'ipynb',
  'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'sql', 'r', 'java', 'go', 'rs', 'c', 'h', 'cpp', 'swift', 'kt', 'rb', 'php'])

const exists = (p: string) => { try { fs.statSync(p); return true } catch { return false } }

/** Turns what a chat link holds (absolute, ~/, relative to the working folder, file:// URL, percent-encoded, with a :line or #anchor suffix) into an absolute path. Prefers a reading that exists on disk. */
export function resolveLocal(raw: string, cwd: string): string {
  let p = raw.trim()
  if (/^file:/i.test(p)) { try { p = fileURLToPath(p) } catch { p = p.replace(/^file:(\/\/)?/i, '') } }
  const forms = [p]
  try { const d = decodeURIComponent(p); if (d !== p) forms.push(d) } catch { /* not percent-encoded */ }
  for (const f of [...forms]) for (const cut of [f.replace(/[#?].*$/, ''), f.replace(/(:\d+){1,2}$/, '')]) if (cut && cut !== f) forms.push(cut)
  const abs = forms.map((f) => (f === '~' || f.startsWith('~/') ? path.join(os.homedir(), f.slice(1)) : path.resolve(cwd || os.homedir(), f)))
  return abs.find(exists) ?? abs[0]
}

/** For each candidate, the absolute path if it exists on disk, else null. */
export function existingPaths(raws: string[], cwd: string): (string | null)[] {
  return raws.slice(0, 200).map((r) => { const p = resolveLocal(r, cwd); return exists(p) ? p : null })
}

/** What a click does: open in the default app, show in Finder, or report that it is gone. */
export function linkAction(p: string, reveal = false): 'open' | 'reveal' | 'missing' {
  let st: fs.Stats
  try { st = fs.statSync(p) } catch { return 'missing' }
  if (reveal) return 'reveal'
  const ext = path.extname(p).slice(1).toLowerCase()
  if (st.isDirectory()) return ext ? 'reveal' : 'open'
  return OPENABLE.has(ext) ? 'open' : 'reveal'
}
