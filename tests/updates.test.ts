import { describe, expect, it } from 'vitest'
import { appBundlePath, compareVersions, parseReleases, parseVersion , gitlabAuthError, networkError, parseChangelog } from '../src/shared/updates'

describe('update checks', () => {
  it('reads only this product\'s tags and compares numerically', () => {
    expect(parseVersion('pearl-v1.3.10', 'pearl-v')).toEqual([1, 3, 10])
    expect(parseVersion('v1.3.10', 'pearl-v')).toBeNull()
    expect(parseVersion('pearl-v1.4.0-rc1', 'pearl-v')).toBeNull()
    expect(compareVersions('1.3.10', '1.3.9')).toBeGreaterThan(0)
    expect(compareVersions('1.3.9', '1.3.9')).toBe(0)
  })

  it('parses GitLab releases newest first with arch-matched assets', () => {
    const link = (v: string, f: string) => ({ name: `app-${v}-${f}`, url: `u/${f}`, direct_asset_url: `https://x/${v}/${f}` })
    const rel = (v: string, extra = {}) => ({ tag_name: `pearl-v${v}`, name: `App ${v}`, description: `## ${v}\n\n### Fix\n- x`, released_at: '2026-11-16T00:00:00Z', _links: { self: `https://r/${v}` }, assets: { links: [link(v, 'x64.zip'), link(v, 'arm64.zip'), link(v, 'arm64.dmg')] }, ...extra })
    const out = parseReleases({ provider: 'gitlab', host: 'https://gitlab.com', project: '1', tagPrefix: 'pearl-v' },
      [rel('1.3.9'), rel('1.3.10'), { tag_name: 'other-v9.9.9' }, rel('2.0.0', { upcoming_release: true })], 'arm64')
    expect(out.map((r) => r.version)).toEqual(['1.3.10', '1.3.9'])
    expect(out[0]).toMatchObject({ notes: '### Fix\n- x', url: 'https://r/1.3.10', zipUrl: 'https://x/1.3.10/arm64.zip', dmgUrl: 'https://x/1.3.10/arm64.dmg' })
  })

  it('skips GitHub drafts and prereleases', () => {
    const rel = (v: string, extra = {}) => ({ tag_name: `v${v}`, body: 'notes', html_url: 'h', published_at: '', assets: [{ name: `a-${v}-arm64.zip`, browser_download_url: `z${v}` }], ...extra })
    const out = parseReleases({ provider: 'github', repo: 'o/r', tagPrefix: 'v' }, [rel('1.2.8', { prerelease: true }), rel('1.2.7'), rel('1.2.9', { draft: true })], 'arm64')
    expect(out.map((r) => [r.version, r.zipUrl])).toEqual([['1.2.7', 'z1.2.7']])
  })

  it('finds the app bundle only for a packaged app', () => {
    expect(appBundlePath('/Applications/Pearl AITM Desktop.app/Contents/MacOS/Pearl AITM Desktop')).toBe('/Applications/Pearl AITM Desktop.app')
    expect(appBundlePath('/proj/node_modules/electron/dist/Electron.app/Contents/Frameworks/x')).toBeNull()
  })
})

describe('release check diagnostics and bundled notes', () => {
  it('says what to fix for each way a private release list refuses', () => {
    expect(gitlabAuthError(404, '', false)).toMatch(/no GitLab token is saved/)
    expect(gitlabAuthError(401, '{"message":"401 Unauthorized"}', true)).toMatch(/expired, was revoked/)
    expect(gitlabAuthError(403, '{"error":"insufficient_scope"}', true)).toMatch(/lacks the read_api scope/)
    expect(gitlabAuthError(404, '{"message":"404 Project Not Found"}', true)).toMatch(/cannot see the release project/)
  })

  it('explains a request that never reached the server instead of saying "fetch failed"', () => {
    const node = (code: string, message = code) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(message), { code }) })
    expect(networkError(node('UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'unable to get local issuer certificate'), 'gitlab.com')).toMatch(/^Could not reach gitlab\.com\. The secure connection to gitlab\.com was not trusted.*\(UNABLE_TO_GET_ISSUER_CERT_LOCALLY Error unable to get local issuer certificate\)$/)
    expect(networkError(node('ENOTFOUND', 'getaddrinfo ENOTFOUND gitlab.com'), 'gitlab.com')).toMatch(/could not look up gitlab\.com/)
    expect(networkError(node('ECONNREFUSED'), 'gitlab.com')).toMatch(/did not answer/)
    expect(networkError(new Error('net::ERR_INTERNET_DISCONNECTED'), 'gitlab.com')).toMatch(/offline/)
    expect(networkError(new Error('net::ERR_TUNNEL_CONNECTION_FAILED'), 'gitlab.com')).toMatch(/proxy refused/)
    expect(networkError(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }), 'gitlab.com')).toMatch(/did not answer/)
    expect(networkError(new TypeError('fetch failed'), 'gitlab.com')).toMatch(/opens in a browser.*\(TypeError fetch failed\)$/)
  })

  it('splits the changelog into versions and drops links that only work in the repository', () => {
    const h = parseChangelog('# Release notes\n\n## 1.3.15\n\n### Excel\n- New: [tutorial](doc/tutorial.md#x) and [site](https://example.com)\n\n## 1.3.14\n- Fix\n')
    expect(h.map((x) => x.version)).toEqual(['1.3.15', '1.3.14'])
    expect(h[0].notes).toBe('### Excel\n- New: tutorial and [site](https://example.com)')
    expect(h[1].notes).toBe('- Fix')
  })
})
