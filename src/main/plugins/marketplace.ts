import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { MarketPlugin } from '../../shared/plugins'
import type { GitFetcher } from './git'

export interface RawPlugin { name: string; description?: string; version?: string; source: unknown }
export interface Marketplace { name: string; dir: string; plugins: RawPlugin[]; url?: string; sparse?: boolean }

/** Where a plugin's files come from: a folder inside the marketplace clone, or another git repo. */
export type PluginSource = { kind: 'local'; dir: string } | { kind: 'git'; url: string; ref?: string; path?: string }

const MANIFESTS = ['.claude-plugin/marketplace.json', '.github/plugin/marketplace.json', 'marketplace.json']
/** What a marketplace clone checks out at first: just the manifests. Plugin folders are added on install. */
const SPARSE = ['/.claude-plugin/', '/.github/plugin/', '/marketplace.json']

export function readMarketplace(dir: string): Marketplace {
  for (const m of MANIFESTS) {
    const f = path.join(dir, m)
    if (!fs.existsSync(f)) continue
    const j = JSON.parse(fs.readFileSync(f, 'utf8'))
    const plugins = (Array.isArray(j.plugins) ? j.plugins : []).filter((p: any) => p && typeof p.name === 'string' && p.source)
    return { name: String(j.name ?? path.basename(dir)), dir, plugins }
  }
  throw new Error('No marketplace.json found (looked in .claude-plugin/ and .github/plugin/).')
}

export function resolveSource(m: Marketplace, p: RawPlugin): PluginSource {
  const s: any = p.source
  if (typeof s === 'string') {
    if (/^(https?:\/\/|git@|ssh:\/\/)/.test(s)) return { kind: 'git', url: s }
    const dir = path.resolve(m.dir, s)
    if (!dir.startsWith(path.resolve(m.dir) + path.sep) && dir !== path.resolve(m.dir)) throw new Error(`plugin ${p.name}: source escapes the marketplace`)
    return { kind: 'local', dir }
  }
  if (s && typeof s === 'object') {
    if (s.source === 'github' && s.repo) return { kind: 'git', url: `https://github.com/${s.repo}.git`, ref: s.ref, path: s.path }
    if ((s.source === 'url' || s.source === 'git') && s.url) return { kind: 'git', url: s.url, ref: s.ref, path: s.path }
  }
  throw new Error(`plugin ${p.name}: unsupported source`)
}

/** Clones (or reuses a recent clone of) a marketplace repo into the cache. */
export class MarketplaceCache {
  constructor(private root: string, private git: GitFetcher, private maxAgeMs = 6 * 3600_000) {}

  dirFor(url: string) { return path.join(this.root, crypto.createHash('sha1').update(url).digest('hex').slice(0, 12)) }

  async load(url: string, opts: { ref?: string; force?: boolean; signal?: AbortSignal } = {}): Promise<Marketplace> {
    const dir = this.dirFor(`${url}#${opts.ref ?? ''}`)
    const stamp = path.join(dir, '.fetched')
    const fresh = fs.existsSync(stamp) && Date.now() - fs.statSync(stamp).mtimeMs < this.maxAgeMs
    const done = () => ({ ...readMarketplace(path.join(dir, 'repo')), url, sparse: true })
    if (!fresh || opts.force) {
      const access = await this.git.probe(url, opts.signal)
      if (access.kind === 'auth-needed') {
        if (fs.existsSync(stamp)) return done()
        throw Object.assign(new Error(`Can't reach ${url}. Set up SSH access or add a git token, then try again.`), { needsAuth: true })
      }
      const tmp = `${dir}.tmp-${process.pid}`
      fs.rmSync(tmp, { recursive: true, force: true })
      fs.mkdirSync(tmp, { recursive: true })
      await this.git.clone(access, opts.ref || undefined, path.join(tmp, 'repo'), { signal: opts.signal, sparse: SPARSE })
      fs.writeFileSync(stamp.replace(dir, tmp), new Date().toISOString())
      fs.rmSync(dir, { recursive: true, force: true })
      fs.mkdirSync(path.dirname(dir), { recursive: true })
      fs.renameSync(tmp, dir)
    }
    return done()
  }

  /** Makes a plugin folder inside a sparse marketplace clone available on disk. */
  async materialize(m: Marketplace, dir: string, signal?: AbortSignal): Promise<void> {
    if (!m.sparse || fs.existsSync(dir)) return
    const rel = path.relative(m.dir, dir).split(path.sep).join('/')
    const access = m.url ? await this.git.probe(m.url, signal) : undefined
    await this.git.sparseAdd(m.dir, [`/${rel}/`], access?.env, signal)
  }
}

export function listPlugins(m: Marketplace, mpName: string, managed: (s: PluginSource) => string | undefined = () => undefined): MarketPlugin[] {
  return m.plugins.map((p) => {
    let by: string | undefined
    try { by = managed(resolveSource(m, p)) } catch { /* listed, install will report */ }
    return { name: p.name, description: p.description, version: p.version, marketplace: mpName, managed: by }
  })
}
