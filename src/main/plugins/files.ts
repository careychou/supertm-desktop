import fs from 'node:fs'
import path from 'node:path'
import { hashFiles, listFiles } from './lock'

export interface PluginManifest { name?: string; version?: string; skills?: string | string[]; agents?: string | string[] }

export function readPluginManifest(root: string): PluginManifest {
  for (const m of ['.claude-plugin/plugin.json', 'plugin.json', '.github/plugin/plugin.json']) {
    try { return JSON.parse(fs.readFileSync(path.join(root, m), 'utf8')) } catch { /* next */ }
  }
  return {}
}

const asList = (v: string | string[] | undefined, def: string) => (v === undefined ? [def] : Array.isArray(v) ? v : [v])
const inside = (root: string, rel: string) => {
  const p = path.resolve(root, rel)
  return p === root || p.startsWith(root + path.sep) ? p : undefined
}

export interface PlannedCopy { from: string; to: string }
export interface PluginPlan { copies: PlannedCopy[]; skipped: string[]; version?: string }

/**
 * What a plugin would put into .github/: each skills/<name>/ folder and each agent file. Agent files are
 * renamed to *.agent.md, which is what the registry loads. Other folders (commands, scripts, hooks…) are
 * reported as skipped: skills reference their own files, and those travel with the skill folder.
 */
export function planPlugin(root: string): PluginPlan {
  const root_ = path.resolve(root)
  const man = readPluginManifest(root_)
  const copies: PlannedCopy[] = []
  for (const rel of asList(man.skills, 'skills')) {
    const dir = inside(root_, rel)
    if (!dir || !fs.existsSync(dir)) continue
    if (fs.existsSync(path.join(dir, 'SKILL.md'))) { copies.push({ from: dir, to: `skills/${path.basename(dir)}` }); continue }
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md'))) copies.push({ from: path.join(dir, e.name), to: `skills/${e.name}` })
    }
  }
  for (const rel of asList(man.agents, 'agents')) {
    const p = inside(root_, rel)
    if (!p || !fs.existsSync(p)) continue
    const files = fs.statSync(p).isDirectory() ? fs.readdirSync(p).filter((f) => f.endsWith('.md')).map((f) => path.join(p, f)) : [p]
    for (const f of files) {
      const base = path.basename(f)
      if (/^readme\.md$/i.test(base)) continue
      copies.push({ from: f, to: `agents/${base.endsWith('.agent.md') ? base : base.replace(/\.md$/, '.agent.md')}` })
    }
  }
  const skipped = ['commands', 'hooks', 'mcp', '.mcp.json'].filter((x) => fs.existsSync(path.join(root_, x)))
  return { copies, skipped, version: man.version }
}

/** Files a planned copy would create, relative to .github/. */
function targetFiles(c: PlannedCopy): string[] {
  if (fs.statSync(c.from).isDirectory()) return listFiles(c.from).map((r) => `${c.to}/${r}`)
  return [c.to]
}

/**
 * Copies a plugin into .github/. Refuses (changing nothing) if a target already exists and isn't one of
 * `owned` (files this plugin installed before). Returns the installed files with their hashes.
 */
export function installPlugin(root: string, ghDir: string, owned: Record<string, string> = {}): { files: Record<string, string>; skipped: string[]; version?: string } {
  const plan = planPlugin(root)
  if (!plan.copies.length) throw new Error('This plugin has no skills or agents to install.')
  const conflicts: string[] = []
  for (const c of plan.copies) {
    const dest = path.join(ghDir, c.to)
    if (!fs.existsSync(dest)) continue
    const existing = fs.statSync(dest).isDirectory() ? listFiles(dest).map((r) => `${c.to}/${r}`) : [c.to]
    if (existing.some((r) => !(r in owned))) conflicts.push(c.to)
  }
  if (conflicts.length) throw new Error(`Already in this folder (not from this plugin): ${conflicts.join(', ')}`)
  // Stage everything first so a failure leaves .github/ untouched.
  const stage = fs.mkdtempSync(path.join(ghDir, '.plugin-stage-'))
  try {
    for (const c of plan.copies) {
      fs.mkdirSync(path.dirname(path.join(stage, c.to)), { recursive: true })
      fs.cpSync(c.from, path.join(stage, c.to), { recursive: true, dereference: true })
    }
    removeFiles(ghDir, Object.keys(owned))
    const rels: string[] = []
    for (const c of plan.copies) {
      const dest = path.join(ghDir, c.to)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.rmSync(dest, { recursive: true, force: true })
      fs.renameSync(path.join(stage, c.to), dest)
      rels.push(...targetFiles({ from: dest, to: c.to }))
    }
    return { files: hashFiles(ghDir, rels), skipped: plan.skipped, version: plan.version }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }
}

/** Deletes exactly these files (relative to .github/) and any folders they leave empty. */
export function removeFiles(ghDir: string, rels: string[]): void {
  const dirs = new Set<string>()
  for (const r of rels) {
    const p = inside(path.resolve(ghDir), r)
    if (!p) continue
    fs.rmSync(p, { force: true })
    for (let d = path.dirname(p); d.startsWith(path.resolve(ghDir) + path.sep); d = path.dirname(d)) dirs.add(d)
  }
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    if (path.basename(d) === 'skills' || path.basename(d) === 'agents') continue
    try { if (!fs.readdirSync(d).length) fs.rmdirSync(d) } catch { /* not empty / gone */ }
  }
}
