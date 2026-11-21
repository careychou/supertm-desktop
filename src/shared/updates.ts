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

/** The release the launch check should offer: the newest one, unless the user skipped it (or something newer). */
export function launchOffer(newer: ReleaseInfo[], skipped: string): ReleaseInfo | undefined {
  const top = newer[0]
  if (!top) return undefined
  return skipped && compareVersions(top.version, skipped) <= 0 ? undefined : top
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

/**
 * Why a private GitLab release list refused the request, in words that say what to fix.
 * GitLab answers 401 for a bad token, 403 for a token without API scope, and 404 when the token's account cannot see the project.
 */
export function gitlabAuthError(status: number, body: string, hasToken: boolean): string {
  if (!hasToken) return 'The release list is private and no GitLab token is saved. Save one, then check again.'
  if (status === 401) return 'GitLab rejected the saved token: it has expired, was revoked, or was mistyped. Create a new token and save it.'
  if (status === 403) return /insufficient_scope|scope/i.test(body)
    ? 'The saved GitLab token lacks the read_api scope, which reading releases needs (read_repository alone is not enough). Create a token with read_api and save it.'
    : 'GitLab refused the saved token for this project\'s releases (403). Check that the token has the read_api scope and that your account can see the project.'
  return 'The account behind the saved GitLab token cannot see the release project. Ask to be added to it, then check again.'
}

/**
 * Why a request never reached the release server, with what to try. Node reports every such failure as
 * "fetch failed" and keeps the real reason in `cause`; Chromium's stack reports "net::ERR_…".
 */
export function networkError(e: unknown, host: string): string {
  const chain: string[] = []
  for (let x: any = e, i = 0; x && i < 5; x = x.cause, i++) chain.push([x.code, x.name, x.message].filter(Boolean).join(' '))
  const all = chain.join(' | '), detail = chain.filter((c) => !/^(TypeError )?fetch failed$/.test(c)).pop() ?? chain[0] ?? String(e)
  const why =
    /ERR_INTERNET_DISCONNECTED|ENETUNREACH|ENETDOWN/i.test(all) ? 'This Mac is offline. Connect to the internet and check again.'
    : /CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|certificate|ERR_SSL/i.test(all) ? `The secure connection to ${host} was not trusted. This usually means a company network or security tool is inspecting traffic. Try again on the VPN (or off it), or ask IT whether ${host} is allowed.`
    : /PROXY|TUNNEL/i.test(all) ? `The network proxy refused the connection to ${host}. Check the proxy settings in System Settings → Network, or ask IT whether ${host} is allowed.`
    : /ENOTFOUND|EAI_AGAIN|NAME_NOT_RESOLVED/i.test(all) ? `This Mac could not look up ${host}. Check the internet connection and VPN, then check again.`
    : /Timeout|TIMED_OUT|ETIMEDOUT|ECONNREFUSED|ECONNRESET|CONNECTION_(REFUSED|RESET|CLOSED|FAILED)|EHOSTUNREACH|ADDRESS_UNREACHABLE|socket/i.test(all) ? `${host} did not answer. A firewall or VPN may be blocking it. Check that ${host} opens in a browser on this Mac.`
    : `Check that ${host} opens in a browser on this Mac, then check again.`
  return `Could not reach ${host}. ${why} (${detail})`
}

/** Splits a CHANGELOG ("## 1.3.15" sections) into versions, newest first as written. */
export function parseChangelog(md: string): Array<{ version: string; notes: string }> {
  const out: Array<{ version: string; notes: string }> = []
  const parts = String(md ?? '').split(/^##[ \t]+v?(\d+\.\d+\.\d+)[^\n]*$/m)
  for (let i = 1; i + 1 < parts.length; i += 2) {
    // links into the repository do not resolve inside the app: keep their text
    const notes = parts[i + 1].replace(/\[([^\]]+)\]\((?!https?:|mailto:)[^)]*\)/g, '$1').trim()
    out.push({ version: parts[i], notes })
  }
  return out
}

/** "/Applications/X.app/Contents/MacOS/X" → "/Applications/X.app"; null outside an app bundle (e.g. dev). */
export function appBundlePath(execPath: string): string | null {
  const m = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath)
  return m ? m[1] : null
}
