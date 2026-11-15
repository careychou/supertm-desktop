import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { PluginService } from '../src/main/plugins/service'
import { configPath, defaultConfig, loadConfig, saveConfig } from '../src/main/plugins/config'
import { loadLock } from '../src/main/plugins/lock'
import { GitFetcher, type Runner } from '../src/main/plugins/git'
import { resolveSource, readMarketplace } from '../src/main/plugins/marketplace'
import { toSsh, toHttps, sameRepo } from '../src/shared/plugins'
import { BRAND } from '../src/shared/brand'

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plg-')))
const write = (f: string, s: string) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s) }
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString().trim()

/** Bare repo at <root>/<name>.git built from files; returns its file:// URL and a commit helper. */
function makeRepo(root: string, name: string, files: Record<string, string>) {
  const work = path.join(root, `${name}-work`)
  for (const [f, s] of Object.entries(files)) write(path.join(work, f), s)
  git(root, 'init', '-q', '-b', 'main', work)
  git(work, 'add', '-A'); git(work, 'commit', '-qm', 'init')
  const bare = path.join(root, `${name}.git`)
  git(root, 'clone', '-q', '--bare', work, bare)
  git(work, 'remote', 'add', 'origin', bare)
  return {
    url: `file://${bare}`,
    commit(f: Record<string, string>) { for (const [k, s] of Object.entries(f)) write(path.join(work, k), s); git(work, 'add', '-A'); git(work, 'commit', '-qm', 'more'); git(work, 'push', '-q', 'origin', 'main'); return git(work, 'rev-parse', 'HEAD') }
  }
}

describe('git url helpers', () => {
  it('converts between https and ssh and compares repos', () => {
    expect(toSsh('https://gitlab.com/a/b')).toBe('git@gitlab.com:a/b.git')
    expect(toHttps('git@gitlab.com:a/b.git')).toBe('https://gitlab.com/a/b.git')
    expect(sameRepo('git@gitlab.com:A/b.git', 'https://GitLab.com/A/b')).toBe(true)
  })
})

describe('folder config', () => {
  it('starts from the brand defaults and keeps keys it does not know', () => {
    const d = tmp()
    expect(loadConfig(d)).toEqual(defaultConfig())
    write(configPath(d), JSON.stringify({ core: { ref: 'x' }, marketplaces: [{ name: 'm', url: 'u' }] }))
    saveConfig(d, { ...loadConfig(d), plugins: [{ name: 'p', marketplace: 'm' }] })
    const raw = JSON.parse(fs.readFileSync(path.join(d, '.github', BRAND.folderConfig), 'utf8'))
    expect(raw.core).toEqual({ ref: 'x' })
    expect(raw.plugins).toEqual([{ name: 'p', marketplace: 'm' }])
  })
})

describe('marketplace sources', () => {
  it('resolves local, url and github sources (with a path inside the repo)', () => {
    const m = { name: 'm', dir: '/x/m', plugins: [] }
    expect(resolveSource(m, { name: 'a', source: './plugins/a' })).toEqual({ kind: 'local', dir: '/x/m/plugins/a' })
    expect(resolveSource(m, { name: 'b', source: { source: 'github', repo: 'o/r', path: 'p', ref: 'v1' } })).toEqual({ kind: 'git', url: 'https://github.com/o/r.git', ref: 'v1', path: 'p' })
    expect(() => resolveSource(m, { name: 'c', source: '../../etc' })).toThrow(/escapes/)
  })
  it('reads .github/plugin/marketplace.json', () => {
    const d = tmp()
    write(path.join(d, '.github/plugin/marketplace.json'), JSON.stringify({ name: 'gh', plugins: [{ name: 'a', source: 'plugins/a' }, { name: 'bad' }] }))
    expect(readMarketplace(d)).toMatchObject({ name: 'gh', plugins: [{ name: 'a' }] })
  })
})

describe('PluginService', () => {
  let root: string, folder: string, svc: PluginService, market: ReturnType<typeof makeRepo>, logs: string[]
  beforeEach(() => {
    root = tmp(); folder = path.join(root, 'work'); fs.mkdirSync(folder)
    market = makeRepo(root, 'market', {
      '.github/plugin/marketplace.json': JSON.stringify({ name: 'm', plugins: [
        { name: 'arch', version: '1.0.0', source: 'plugins/arch' },
        { name: 'rails', source: { source: 'url', url: 'RAILS', ref: 'main' } },
        { name: 'core', source: { source: 'url', url: 'CORE' } }
      ] }),
      'plugins/arch/plugin.json': '{"name":"arch","version":"1.0.0"}',
      'plugins/arch/skills/doc-and-modernize/SKILL.md': '---\nname: doc-and-modernize\ndescription: d\n---\n',
      'plugins/arch/agents/arch-lead.md': '---\nname: arch-lead\n---\n',
      'plugins/arch/hooks/x.json': '{}',
      'plugins/big/skills/huge/SKILL.md': 'not needed'
    })
    const rails = makeRepo(root, 'rails', {
      '.claude-plugin/plugin.json': '{"name":"rails","version":"0.4.9","skills":"./.claude/skills"}',
      '.claude/skills/conduct/SKILL.md': '---\nname: conduct\ndescription: c\n---\n'
    })
    market.commit({ '.github/plugin/marketplace.json': fs.readFileSync(path.join(root, 'market-work/.github/plugin/marketplace.json'), 'utf8').replace('RAILS', rails.url).replace('CORE', 'git@example.com:core/pack.git') })
    saveConfig(folder, { ...defaultConfig(), marketplaces: [{ name: 'm', url: market.url }] })
    logs = []
    svc = new PluginService({ dataHome: path.join(root, 'data'), onLog: (_f, l) => logs.push(l),
      managed: (_f, s) => (s.kind === 'git' && sameRepo(s.url, 'git@example.com:core/pack.git') ? 'Managed elsewhere' : undefined) })
  })

  it('lists plugins from a sparse marketplace clone, installs and removes them', async () => {
    const { plugins, errors } = await svc.listPlugins(folder)
    expect(errors).toEqual([])
    expect(plugins.map((p) => [p.name, !!p.installed, p.managed])).toEqual([['arch', false, undefined], ['rails', false, undefined], ['core', false, 'Managed elsewhere']])
    const cache = fs.readdirSync(path.join(root, 'data/marketplace-cache'))[0]
    expect(fs.existsSync(path.join(root, 'data/marketplace-cache', cache, 'repo/plugins'))).toBe(false)

    expect(await svc.installPlugin(folder, 'arch', 'm')).toMatchObject({ ok: true })
    expect(fs.existsSync(path.join(folder, '.github/skills/doc-and-modernize/SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(folder, '.github/agents/arch-lead.agent.md'))).toBe(true)
    expect(fs.existsSync(path.join(root, 'data/marketplace-cache', cache, 'repo/plugins/big'))).toBe(false)
    expect(logs.some((l) => l.includes('hooks'))).toBe(true)
    expect(await svc.installPlugin(folder, 'rails', 'm')).toMatchObject({ ok: true })
    expect(fs.existsSync(path.join(folder, '.github/skills/conduct/SKILL.md'))).toBe(true)
    expect(await svc.installPlugin(folder, 'core', 'm')).toMatchObject({ ok: false, message: 'Managed elsewhere' })
    expect(loadConfig(folder).plugins.map((p) => p.name)).toEqual(['arch', 'rails'])
    expect((await svc.installPlugin(folder, 'arch', 'm')).ok).toBe(true)

    expect((await svc.uninstallPlugin(folder, 'arch')).ok).toBe(true)
    expect(fs.existsSync(path.join(folder, '.github/skills/doc-and-modernize'))).toBe(false)
    expect(fs.existsSync(path.join(folder, '.github/agents/arch-lead.agent.md'))).toBe(false)
    expect(Object.keys(loadLock(folder).plugins)).toEqual(['rails'])
  })

  it('detects a plugin update in the marketplace and updates it', async () => {
    await svc.installPlugin(folder, 'arch', 'm')
    expect(await svc.checkUpdates(folder)).toBeUndefined()
    const mj = JSON.parse(fs.readFileSync(path.join(root, 'market-work/.github/plugin/marketplace.json'), 'utf8'))
    mj.plugins[0].version = '1.1.0'
    market.commit({ '.github/plugin/marketplace.json': JSON.stringify(mj), 'plugins/arch/plugin.json': '{"name":"arch","version":"1.1.0"}', 'plugins/arch/skills/doc-and-modernize/SKILL.md': 'v2' })
    expect((await svc.checkUpdates(folder))?.plugins).toEqual(['arch'])
    expect(svc.status(folder).update?.plugins).toEqual(['arch'])
    expect((await svc.updateAll(folder)).ok).toBe(true)
    expect(fs.readFileSync(path.join(folder, '.github/skills/doc-and-modernize/SKILL.md'), 'utf8')).toBe('v2')
    expect(loadLock(folder).plugins.arch.version).toBe('1.1.0')
    expect(svc.status(folder).update).toBeUndefined()
  })

  it('refuses a plugin that would overwrite the user’s own skill', async () => {
    write(path.join(folder, '.github/skills/conduct/SKILL.md'), 'mine')
    await expect(svc.installPlugin(folder, 'rails', 'm')).rejects.toThrow(/Already in this folder/)
    expect(fs.readFileSync(path.join(folder, '.github/skills/conduct/SKILL.md'), 'utf8')).toBe('mine')
  })
})

describe('GitFetcher.probe', () => {
  it('falls back from SSH to HTTPS with the token, which never appears in argv', async () => {
    const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = []
    const run: Runner = async (_cmd, args, o) => {
      calls.push({ args, env: o.env })
      return { code: args.some((a) => a.startsWith('git@')) ? 128 : 0, stdout: '', stderr: '' }
    }
    const g = new GitFetcher(() => 'tok-SECRET', run)
    const a = await g.probe('https://gitlab.com/x/y')
    expect(a.kind).toBe('https-token')
    expect(calls.every((c) => !c.args.join(' ').includes('SECRET'))).toBe(true)
    expect(calls[1].env?.GIT_ASKPASS).toBeTruthy()
    g.dispose()
  })
})
