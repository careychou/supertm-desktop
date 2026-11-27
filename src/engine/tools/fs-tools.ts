import { toolLimits } from '../limits'
import fs from 'node:fs'
import path from 'node:path'
import type { ToolDef } from './types'
import { globToRegExp, head, resolvePath } from './util'

const SKIP = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'out', 'dist', '.DS_Store'])

export function* walk(root: string, limit = 20000): Generator<string> {
  const stack = [root]
  let n = 0
  while (stack.length) {
    const d = stack.pop()!
    let ents: fs.Dirent[]
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { continue }
    for (const e of ents) {
      if (SKIP.has(e.name)) continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.isFile()) { yield p; if (++n >= limit) return }
    }
  }
}

/** Image type from the first bytes, '' for none. */
export function imageKind(h: Buffer): string {
  if (h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47) return 'png'
  if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return 'jpeg'
  if (h.toString('ascii', 0, 4) === 'GIF8') return 'gif'
  if (h.toString('ascii', 0, 4) === 'RIFF' && h.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  return ''
}

const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

export const readFile: ToolDef = {
  name: 'read_file',
  description: 'Read a text file. Optionally pass a 1-based inclusive line range [start, end] (end -1 = EOF). Long output is cut at a whole line with a note giving the next start line; call again from there to read the rest. An image (PNG, JPEG, GIF, WebP) is shown to you as a picture, not as text. Other binary files are refused.',
  parameters: { type: 'object', properties: { path: { type: 'string' }, start: { type: 'integer' }, end: { type: 'integer' } }, required: ['path'] },
  async run(a, ctx) {
    const p = resolvePath(ctx.cwd, a.path)
    const st = fs.statSync(p)
    if (st.isDirectory()) return fs.readdirSync(p).sort().join('\n')
    const buf = fs.readFileSync(p)
    const sniff = buf.subarray(0, 8192)
    const img = imageKind(sniff)
    if (img) {
      if (!ctx.loadImage || !ctx.attachImage) throw new Error(`${p} is a ${img.toUpperCase()} image (${kb(st.size)}); read_file returns text only, and images cannot be shown in this context`)
      const im = await ctx.loadImage(p)
      ctx.attachImage({ ...im, caption: `Image from read_file: ${p} (${im.width}×${im.height})` })
      return `${p} is a ${img.toUpperCase()} image (${kb(st.size)}). It is attached as a picture right after these tool results (${im.width}×${im.height}), so look at it there.`
    }
    if (sniff.includes(0)) throw new Error(`${p} is a binary file (${kb(st.size)}); read_file reads text only. Use a shell command to inspect or convert it (e.g. file, pdftotext, unzip -l)`)
    const txt = buf.toString('utf8')
    const lines = txt.split('\n')
    const start = Math.max(1, Number(a.start) || 1)
    const numbered = !!a.start
    const end = !a.end || a.end < 0 ? lines.length : Math.min(a.end, lines.length)
    const max = toolLimits.readFileChars
    const out: string[] = []
    let size = 0
    for (let n = start; n <= end; n++) {
      const l = numbered ? `${n}. ${lines[n - 1]}` : lines[n - 1]
      if (size + l.length + 1 > max && out.length) {
        return out.join('\n') + `\n[...output limit reached: showing lines ${start}-${n - 1} of ${lines.length}. Call read_file with start=${n} to continue.]`
      }
      out.push(head(l, max))
      size += l.length + 1
    }
    return out.join('\n')
  }
}

export const writeFile: ToolDef = {
  name: 'write_file',
  description: 'Create or overwrite a file with the given content. Parent directories are created. For a large file (more than ~20KB), write it in parts: the first call creates it, each further call sets append=true to add the next part, so no single reply gets cut off by the output token limit.',
  parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, append: { type: 'boolean', description: 'Add content to the end of the file instead of overwriting it.' } }, required: ['path', 'content'] },
  permission: 'write',
  summarize: (a) => `${a.append ? 'append to' : 'write'} ${a.path} (${String(a.content ?? '').length} chars)`,
  async run(a, ctx) {
    const p = resolvePath(ctx.cwd, a.path)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    if (a.append) {
      fs.appendFileSync(p, a.content ?? '')
      return `appended ${String(a.content ?? '').length} chars to ${p} (now ${fs.statSync(p).size} bytes)`
    }
    fs.writeFileSync(p, a.content ?? '')
    return `wrote ${p}`
  }
}

export const editFile: ToolDef = {
  name: 'edit_file',
  description: 'Replace exactly one occurrence of old_str with new_str in a file. Fails if old_str is missing or not unique.',
  parameters: { type: 'object', properties: { path: { type: 'string' }, old_str: { type: 'string' }, new_str: { type: 'string' } }, required: ['path', 'old_str', 'new_str'] },
  permission: 'write',
  summarize: (a) => `edit ${a.path}`,
  async run(a, ctx) {
    const p = resolvePath(ctx.cwd, a.path)
    const src = fs.readFileSync(p, 'utf8')
    const count = src.split(a.old_str).length - 1
    if (count === 0) throw new Error('old_str not found')
    if (count > 1) throw new Error(`old_str is not unique (${count} matches); include more context`)
    fs.writeFileSync(p, src.replace(a.old_str, () => a.new_str))
    return `edited ${p}`
  }
}

export const glob: ToolDef = {
  name: 'glob',
  description: 'Find files by glob pattern (e.g. "**/*.py") relative to path (default: working folder). Returns up to 200 paths.',
  parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] },
  async run(a, ctx) {
    const root = resolvePath(ctx.cwd, a.path ?? '.')
    const re = globToRegExp(a.pattern.includes('/') ? a.pattern : `**/${a.pattern}`)
    const out: string[] = []
    for (const f of walk(root)) {
      const rel = path.relative(root, f).split(path.sep).join('/')
      if (re.test(rel)) { out.push(rel); if (out.length >= 200) break }
    }
    return out.length ? out.sort().join('\n') : 'no matches'
  }
}
