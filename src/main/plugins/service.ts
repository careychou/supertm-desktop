import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FolderConfig, MarketPlugin, PluginResult, PluginsStatus, PluginUpdates } from '../../shared/plugins'
import { githubDir, hasConfig, loadConfig, saveConfig } from './config'
import { loadLock, saveLock } from './lock'
import { GitFetcher, runCommand, type Runner } from './git'
import { MarketplaceCache, listPlugins, resolveSource, type Marketplace, type PluginSource } from './marketplace'
import { installPlugin, removeFiles } from './files'

export interface PluginServiceOptions {
  dataHome: string
  run?: Runner
  /** Token for HTTPS git access (e.g. a GitLab/GitHub token a branded build saves). */
  getToken?: () => string | undefined
  onLog?: (folder: string, line: string) => void
  /** Fired whenever a folder's plugin state may have changed. */
  onChange?: (folder: string) => void
  /** Plugins this service must not install (e.g. a branded build's core pack); returns why. */
  managed?: (folder: string, src: PluginSource) => string | undefined
}

/** Installs marketplace plugins (skills + agents) into working folders' .github/, and keeps them updated. */
export class PluginService {
  readonly git: GitFetcher
  readonly run: Runner
  private cache: MarketplaceCache
  private busy = new Set<string>()
  private updates = new Map<string, PluginUpdates>()

  constructor(private o: PluginServiceOptions) {
    this.run = o.run ?? runCommand
    this.git = new GitFetcher(() => o.getToken?.(), this.run)
    this.cache = new MarketplaceCache(path.join(o.dataHome, 'marketplace-cache'), this.git)
  }

  log(folder: string, line: string) { this.o.onLog?.(folder, line) }
  changed(folder: string) { try { this.o.onChange?.(folder) } catch { /* folder gone */ } }

  isBusy(folder: string) { return this.busy.has(folder) }

  /** Runs one change at a time per folder (shared with a branded build's own installers). */
  async exclusive<T>(folder: string, fn: () => Promise<T>): Promise<T> {
    if (this.busy.has(folder)) throw new Error('Already updating this folder. Wait for it to finish.')
    this.busy.add(folder)
    this.changed(folder)
    try { return await fn() } finally { this.busy.delete(folder); this.changed(folder) }
  }

  /** True when this folder has plugins installed or its own plugin settings. */
  hasPlugins(folder: string) { return Object.keys(loadLock(folder).plugins).length > 0 || hasConfig(folder) }

  status(folder: string): PluginsStatus {
    const lock = loadLock(folder)
    return {
      folder,
      config: loadConfig(folder),
      plugins: Object.entries(lock.plugins).map(([name, p]) => ({ name, marketplace: p.marketplace, version: p.version, sha: p.sha, installedAt: p.installedAt })),
      update: this.updates.get(folder),
      busy: this.busy.has(folder)
    }
  }

  saveConfig(folder: string, c: FolderConfig) {
    saveConfig(folder, { ...loadConfig(folder), ...c })
    this.cache = new MarketplaceCache(path.join(this.o.dataHome, 'marketplace-cache'), this.git)
    this.updates.delete(folder)
    this.changed(folder)
  }

  private async marketplace(folder: string, name: string, force = false): Promise<Marketplace> {
    const mp = loadConfig(folder).marketplaces.find((m) => m.name === name)
    if (!mp) throw new Error(`No marketplace named “${name}” in this folder’s sources.`)
    return this.cache.load(mp.url, { ref: mp.ref, force })
  }

  async listPlugins(folder: string, force = false): Promise<{ plugins: MarketPlugin[]; errors: string[] }> {
    const cfg = loadConfig(folder)
    const lock = loadLock(folder)
    const plugins: MarketPlugin[] = []
    const errors: string[] = []
    for (const mp of cfg.marketplaces) {
      try {
        const m = await this.cache.load(mp.url, { ref: mp.ref, force })
        for (const p of listPlugins(m, mp.name, (s) => this.o.managed?.(folder, s))) {
          plugins.push({ ...p, installed: !p.managed && lock.plugins[p.name]?.marketplace === mp.name })
        }
      } catch (e: any) { errors.push(`${mp.name}: ${e?.message ?? e}`) }
    }
    return { plugins, errors }
  }

  installPlugin(folder: string, name: string, marketplace: string, signal?: AbortSignal): Promise<PluginResult> {
    return this.exclusive(folder, () => this.installUnlocked(folder, name, marketplace, signal))
  }

  private async installUnlocked(folder: string, name: string, marketplace: string, signal?: AbortSignal): Promise<PluginResult> {
    const log = (l: string) => this.log(folder, l)
    const m = await this.marketplace(folder, marketplace)
    const raw = m.plugins.find((p) => p.name === name)
    if (!raw) return { ok: false, message: `“${name}” isn’t in ${marketplace}.` }
    const src = resolveSource(m, raw)
    const why = this.o.managed?.(folder, src)
    if (why) return { ok: false, message: why }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-plugin-'))
    try {
      let root: string, sha: string
      if (src.kind === 'local') {
        log(`→ Getting ${name} from ${marketplace}`)
        await this.cache.materialize(m, src.dir, signal)
        root = src.dir
        sha = (await this.run('git', ['rev-parse', 'HEAD'], { cwd: m.dir })).stdout.trim()
      } else {
        log(`→ Downloading ${name} from ${src.url}${src.ref ? ` @ ${src.ref}` : ''}`)
        const access = await this.git.probe(src.url, signal)
        if (access.kind === 'auth-needed') return { ok: false, needsAuth: true, message: `Can’t reach ${src.url}. Set up SSH access or add a git token.` }
        const sparse = src.path ? [`/${src.path.replace(/^\.?\/+|\/+$/g, '')}/`] : undefined
        sha = await this.git.clone(access, src.ref, path.join(tmp, 'p'), { onLine: log, signal, sparse })
        root = src.path ? path.join(tmp, 'p', src.path) : path.join(tmp, 'p')
      }
      const prev = loadLock(folder).plugins[name]
      const res = installPlugin(root, githubDir(folder), prev?.files)
      const fresh = loadLock(folder)
      fresh.plugins[name] = { marketplace, repo: src.kind === 'git' ? src.url : (m.url ?? m.dir), ref: src.kind === 'git' ? src.ref : undefined, sha, version: res.version ?? raw.version, installedAt: new Date().toISOString(), files: res.files }
      saveLock(folder, fresh)
      const cfg = loadConfig(folder)
      if (!cfg.plugins.some((p) => p.name === name)) saveConfig(folder, { ...cfg, plugins: [...cfg.plugins, { name, marketplace }] })
      if (res.skipped.length) log(`  not installed (only skills and agents are added): ${res.skipped.join(', ')}`)
      log(`✓ ${name} ${res.version ?? ''} installed: ${Object.keys(res.files).length} files`)
      const u = this.updates.get(folder)
      if (u) this.updates.set(folder, { ...u, plugins: u.plugins.filter((p) => p !== name) })
      return { ok: true, message: `${name} installed.` }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  }

  uninstallPlugin(folder: string, name: string): Promise<PluginResult> {
    return this.exclusive(folder, async () => {
      const lock = loadLock(folder)
      const p = lock.plugins[name]
      if (!p) return { ok: false, message: `${name} isn’t installed here.` }
      removeFiles(githubDir(folder), Object.keys(p.files))
      delete lock.plugins[name]
      saveLock(folder, lock)
      const cfg = loadConfig(folder)
      saveConfig(folder, { ...cfg, plugins: cfg.plugins.filter((x) => x.name !== name) })
      this.log(folder, `✓ ${name} removed`)
      return { ok: true, message: `${name} removed.` }
    })
  }

  /** Plugins whose source moved on since install. Quietly skips what it can't reach. */
  async checkUpdates(folder: string, signal?: AbortSignal): Promise<PluginUpdates | undefined> {
    const lock = loadLock(folder)
    const info: PluginUpdates = { plugins: [], checkedAt: new Date().toISOString() }
    const markets = new Map<string, Marketplace | null>()
    for (const [name, p] of Object.entries(lock.plugins)) {
      try {
        if (!markets.has(p.marketplace)) markets.set(p.marketplace, await this.marketplace(folder, p.marketplace, true).catch(() => null))
        const m = markets.get(p.marketplace)
        const raw = m?.plugins.find((x) => x.name === name)
        if (!m || !raw) continue
        const src = resolveSource(m, raw)
        if (src.kind === 'local') {
          const head = (await this.run('git', ['rev-parse', 'HEAD'], { cwd: m.dir })).stdout.trim()
          if ((raw.version && p.version && raw.version !== p.version) || (!raw.version && head && head !== p.sha)) info.plugins.push(name)
          continue
        }
        const a = await this.git.probe(src.url, signal)
        if (a.kind === 'auth-needed') continue
        const head = await this.git.remoteHead(a, src.ref ?? 'HEAD', signal)
        if (head && head !== p.sha) info.plugins.push(name)
      } catch { /* offline: try next time */ }
    }
    if (info.plugins.length) this.updates.set(folder, info); else this.updates.set(folder, { plugins: [], checkedAt: info.checkedAt })
    this.changed(folder)
    return info.plugins.length ? info : undefined
  }

  /** Reinstalls every plugin with an update. */
  async updateAll(folder: string, signal?: AbortSignal): Promise<PluginResult> {
    const u = await this.checkUpdates(folder, signal)
    if (!u) return { ok: true, message: 'All plugins are up to date.' }
    const msgs: string[] = []
    let ok = true
    for (const name of u.plugins) {
      const p = loadLock(folder).plugins[name]
      if (!p) continue
      const r = await this.installPlugin(folder, name, p.marketplace, signal).catch((e) => ({ ok: false, message: String(e?.message ?? e) }))
      ok &&= r.ok; msgs.push(r.message)
    }
    this.updates.delete(folder)
    this.changed(folder)
    return { ok, message: msgs.join(' ') }
  }

  /** Clears a folder's update flag (after a branded build refreshes everything itself). */
  clearUpdates(folder: string) { this.updates.delete(folder) }

  dispose() { this.git.dispose() }
}
