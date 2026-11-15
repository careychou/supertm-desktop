// Folder plugins: install skills and agents from plugin marketplaces into a working folder's .github/,
// so they only apply to chats in that folder.

export interface MarketplaceRef {
  name: string
  /** Git URL (https, ssh, or a local path / file:// URL). */
  url: string
  /** Branch or tag; default branch when empty. */
  ref?: string
}

/** <folder>/.github/<BRAND.folderConfig>: where this folder gets plugins from. Branded builds may add keys. */
export interface FolderConfig {
  version: 1
  marketplaces: MarketplaceRef[]
  plugins: Array<{ name: string; marketplace: string }>
  autoCheck: boolean
}

export interface LockEntry {
  repo: string
  ref?: string
  sha: string
  version?: string
  installedAt: string
  /** Paths relative to .github/ → sha256. */
  files: Record<string, string>
}

export interface PluginLockEntry extends LockEntry { marketplace: string }

/** <folder>/.github/<config>.lock.json: what was installed. Branded builds may add keys. */
export interface FolderLock {
  version: 1
  plugins: Record<string, PluginLockEntry>
}

export interface MarketPlugin {
  name: string
  description?: string
  version?: string
  marketplace: string
  installed?: boolean
  /** Installed some other way (e.g. a branded build's core pack); not installable here. */
  managed?: string
}

export interface PluginUpdates { plugins: string[]; checkedAt: string }

export interface PluginsStatus {
  folder: string
  config: FolderConfig
  plugins: Array<{ name: string; marketplace: string; version?: string; sha: string; installedAt: string }>
  update?: PluginUpdates
  busy: boolean
}

export interface PluginResult { ok: boolean; message: string; needsAuth?: boolean }

export type GitAccess = 'ssh' | 'https-token' | 'https' | 'auth-needed'

// ---- git URL helpers ----

/** https://host/a/b(.git) → git@host:a/b.git (other forms unchanged). */
export function toSsh(url: string): string {
  const m = /^https?:\/\/([^/]+)\/(.+?)(\.git)?\/?$/.exec(url.trim())
  return m ? `git@${m[1]}:${m[2]}.git` : url.trim()
}

/** git@host:a/b.git or ssh://git@host/a/b.git → https://host/a/b.git (other forms unchanged). */
export function toHttps(url: string): string {
  const u = url.trim()
  let m = /^git@([^:]+):(.+?)(\.git)?\/?$/.exec(u)
  if (m) return `https://${m[1]}/${m[2]}.git`
  m = /^ssh:\/\/git@([^/:]+)(?::\d+)?\/(.+?)(\.git)?\/?$/.exec(u)
  if (m) return `https://${m[1]}/${m[2]}.git`
  m = /^(https?:\/\/[^/]+\/.+?)(\.git)?\/?$/.exec(u)
  return m ? `${m[1]}.git` : u
}

/** Same repository regardless of protocol / trailing .git / case of host. */
export function sameRepo(a: string, b: string): boolean {
  const norm = (s: string) => toHttps(s).replace(/^https?:\/\//, '').replace(/\.git$/, '').toLowerCase()
  return norm(a) === norm(b)
}
