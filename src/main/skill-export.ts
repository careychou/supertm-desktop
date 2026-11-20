import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { exportMarkdown, type ExportItem } from '../shared/export'
import { skillNameError, clipTranscript, collectSkillFiles, finalizeSkillMd, kindOf, scanSecrets, skillDraftPrompt, skillTargets, type SecretFinding, type SkillFileRef } from '../shared/skill-export'

const MAX_FILE = 1_000_000
// scratch files the agent wrote while testing; offered, but not ticked by default
const TEMP = /^(\/tmp\/|\/private\/|\/var\/folders\/)|\/(node_modules|\.venv|__pycache__)\//

/** One pack file: copied from `source`, or written from `content` (inline script or edited text). */
export interface SkillFileDraft { id: string; source?: string; content?: string; target: string; size: number; exists: boolean; origin: SkillFileRef['origin']; suggested: boolean }
export interface SkillDraft { md: string; files: SkillFileDraft[]; findings: SecretFinding[]; model: string }
export interface SkillFileOut { target: string; source?: string; content?: string }

const resolve = (cwd: string, p: string) => path.resolve(cwd, p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p)

function onDisk(source: string): { size: number; exists: boolean } {
  try { const st = fs.statSync(source); return { size: st.size, exists: st.isFile() && st.size <= MAX_FILE } } catch { return { size: 0, exists: false } }
}

/** Bundle candidates: files the turns wrote/edited/ran that still exist (and aren't huge), plus inline scripts. */
export function skillFiles(items: ExportItem[], turns: number[] | undefined, cwd: string): SkillFileDraft[] {
  const seen = new Set<string>()
  const refs = collectSkillFiles(items, turns).filter((r) => {
    if (r.content !== undefined) return true
    const k = resolve(cwd, r.path!)
    if (seen.has(k)) return false
    seen.add(k); return true
  })
  const targets = skillTargets(refs)
  return refs.map((r, i) => {
    if (r.content !== undefined) return { id: `inline:${i}`, content: r.content, target: targets[i], size: Buffer.byteLength(r.content), exists: true, origin: r.origin, suggested: false }
    const source = resolve(cwd, r.path!)
    const disk = onDisk(source)
    return { id: source, source, target: targets[i], ...disk, origin: r.origin, suggested: disk.exists && (source.startsWith(path.resolve(cwd) + path.sep) || !TEMP.test(source)) }
  })
}

/** Files the user picked to add to the pack, with targets that don't clash with `taken`. */
export function addedFiles(paths: string[], taken: string[]): SkillFileDraft[] {
  const refs: SkillFileRef[] = paths.map((p) => ({ path: p, kind: kindOf(p), origin: 'added' }))
  const used = new Set(taken)
  return refs.map((r) => {
    let target = skillTargets([r])[0]
    const dot = target.lastIndexOf('.'), slash = target.indexOf('/')
    const [stem, ext] = dot > slash ? [target.slice(0, dot), target.slice(dot)] : [target, '']
    for (let n = 2; used.has(target); n++) target = `${stem}-${n}${ext}`
    used.add(target)
    const disk = onDisk(r.path!)
    return { id: r.path!, source: r.path!, target, ...disk, origin: 'added' as const, suggested: disk.exists }
  })
}

/** Text of a pack file for preview/editing, or null if it's binary or too big to edit. */
export function readSkillFile(source: string, limit = 200_000): string | null {
  try {
    const b = fs.readFileSync(source)
    if (b.length > limit || b.subarray(0, 8000).includes(0)) return null
    return b.toString('utf8')
  } catch { return null }
}

const textOf = (f: SkillFileOut) => f.content ?? (f.source ? readSkillFile(f.source) ?? '' : '')

/** Drafts SKILL.md for the selected turns with `complete` (the compaction model). */
export async function draftSkill(o: {
  items: ExportItem[]; turns?: number[]; name: string; title: string; cwd: string; model: string
  complete(system: string, user: string): Promise<{ text: string; model: string }>
}): Promise<SkillDraft> {
  const files = skillFiles(o.items, o.turns, o.cwd)
  const transcript = clipTranscript(exportMarkdown(o.items, { title: o.title, cwd: o.cwd, model: o.model, turns: o.turns, includeTools: true }))
  const r = await o.complete('You write concise, reusable instruction files (skills) for AI coding agents.', skillDraftPrompt(o.name, transcript, files.filter((f) => f.suggested).map((f) => f.target)))
  if (!r.text.trim()) throw new Error('the model returned an empty skill')
  const md = finalizeSkillMd(r.text, o.name)
  return { md, files, findings: findingsFor(md, files.filter((f) => f.suggested)), model: r.model }
}

/** Secret scan over SKILL.md plus the bundled files (edited content wins over the file on disk). */
export function findingsFor(md: string, files: SkillFileOut[]): SecretFinding[] {
  return scanSecrets([md, ...files.map(textOf)].join('\n'))
}

/** Writes <root>/<name>/SKILL.md plus files; never overwrites an existing skill. Returns the skill folder. */
export function writeSkill(root: string, name: string, md: string, files: SkillFileOut[]): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error(`invalid skill name "${name}"`)
  const bad = skillNameError(name)
  if (bad) throw new Error(bad)
  const dir = path.join(root, name)
  if (fs.existsSync(dir)) throw new Error(`A skill named "${name}" already exists in ${root}. Pick another name.`)
  for (const f of files) if (!/^(scripts|assets)\/[^/\\]+$/.test(f.target) || /^(scripts|assets)\/\.\.?$/.test(f.target)) throw new Error(`invalid file name ${f.target}: use scripts/<name> or assets/<name>`)
  const dup = files.map((f) => f.target).find((t, i, a) => a.indexOf(t) !== i)
  if (dup) throw new Error(`two files are both named ${dup}`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), md.endsWith('\n') ? md : md + '\n')
  for (const f of files) {
    fs.mkdirSync(path.join(dir, path.dirname(f.target)), { recursive: true })
    const to = path.join(dir, f.target)
    if (f.content !== undefined) fs.writeFileSync(to, f.content)
    else if (f.source) fs.copyFileSync(f.source, to)
  }
  return dir
}

/** Skills root for a destination: the chat folder's .github/skills or the personal ~/.copilot/skills. */
export const skillsRoot = (dest: 'folder' | 'personal', cwd: string, home = path.join(os.homedir(), '.copilot')) =>
  dest === 'folder' ? path.join(cwd, '.github', 'skills') : path.join(home, 'skills')
