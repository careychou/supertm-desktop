/** Where a build looks for newer releases (Settings → About → Check for updates). */
export type UpdateSource =
  | { provider: 'gitlab'; host: string; project: string; tagPrefix: string }
  | { provider: 'github'; repo: string; tagPrefix: string }

export interface ReleaseInfo {
  version: string
  tag: string
  name: string
  /** Markdown release notes. */
  notes: string
  date: string
  url: string
  zipUrl?: string
  dmgUrl?: string
}

export interface UpdateCheck {
  current: string
  /** Newest published version, even when it is not newer than this build. */
  latest?: string
  /** Releases newer than this build, newest first. */
  newer: ReleaseInfo[]
  error?: string
  /** The release list is private and no usable token is saved. */
  needsToken?: boolean
  /** This copy can replace itself (a packaged app in a folder the user can write to). */
  canInstall: boolean
  /** Why it can't, shown next to the manual download link. */
  installBlocked?: string
}

export type UpdateState =
  | { phase: 'idle' }
  | { phase: 'downloading'; version: string; received: number; total: number }
  | { phase: 'ready'; version: string }
  | { phase: 'error'; version?: string; error: string }

/** "pearl-v1.3.10" → [1, 3, 10]; null when it is not a release tag for this product. */
export function parseVersion(tag: string, prefix = ''): number[] | null {
  if (prefix && !tag.startsWith(prefix)) return null
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag.slice(prefix.length))
  return m ? m.slice(1).map(Number) : null
}

export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a) ?? [0, 0, 0], pb = parseVersion(b) ?? [0, 0, 0]
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]
  return 0
}

const pickAsset = (assets: Array<{ name: string; url: string }>, ext: string, arch: string) =>
  assets.find((a) => a.name.endsWith(`-${arch}.${ext}`))?.url ?? assets.find((a) => a.name.endsWith(`.${ext}`))?.url

/** Drops a leading "## 1.3.9" heading: the list already shows the version. */
const stripVersionHeading = (notes: string, version: string) =>
  notes.replace(new RegExp(`^\\s*#+\\s*v?${version.replace(/\./g, '\\.')}[ \\t]*(\\n+|$)`), '')

/** Normalises a GitLab or GitHub release list into this product's releases, newest first. */
export function parseReleases(src: UpdateSource, json: unknown, arch: string): ReleaseInfo[] {
  if (!Array.isArray(json)) return []
  const out: ReleaseInfo[] = []
  for (const r of json as any[]) {
    const tag = String(r?.tag_name ?? '')
    const v = parseVersion(tag, src.tagPrefix)
    if (!v) continue
    let assets: Array<{ name: string; url: string }>
    let url: string, date: string
    if (src.provider === 'github') {
      if (r.draft || r.prerelease) continue
      assets = (r.assets ?? []).map((a: any) => ({ name: String(a.name), url: String(a.browser_download_url) }))
      url = String(r.html_url ?? ''); date = String(r.published_at ?? r.created_at ?? '')
    } else {
      if (r.upcoming_release) continue
      assets = (r.assets?.links ?? []).map((a: any) => ({ name: String(a.name), url: String(a.direct_asset_url || a.url) }))
      url = String(r._links?.self ?? ''); date = String(r.released_at ?? r.created_at ?? '')
    }
    out.push({
      version: v.join('.'), tag, name: String(r.name || tag), notes: stripVersionHeading(String((src.provider === 'github' ? r.body : r.description) ?? ''), v.join('.')),
      date, url, zipUrl: pickAsset(assets, 'zip', arch), dmgUrl: pickAsset(assets, 'dmg', arch)
    })
  }
  return out.sort((a, b) => compareVersions(b.version, a.version))
}

/** "/Applications/X.app/Contents/MacOS/X" → "/Applications/X.app"; null outside an app bundle (e.g. dev). */
export function appBundlePath(execPath: string): string | null {
  const m = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath)
  return m ? m[1] : null
}
