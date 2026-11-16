import { describe, expect, it } from 'vitest'
import { appBundlePath, compareVersions, parseReleases, parseVersion } from '../src/shared/updates'

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
