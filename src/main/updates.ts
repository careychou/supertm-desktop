import { app, shell, type IpcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { BRAND } from '../shared/brand'
import { appBundlePath, compareVersions, gitlabAuthError, parseReleases, type ReleaseInfo, type UpdateCheck, type UpdateSource, type UpdateState } from '../shared/updates'
import type { PushEvent } from '../shared/api'

const run = promisify(execFile)

interface Opts {
  push(e: PushEvent): void
  /** Token for a private GitLab release list (the AI Teammate GITLAB_TOKEN). */
  getToken(): string | undefined
}

const authHeaders = (src: UpdateSource, token?: string): Record<string, string> =>
  src.provider === 'gitlab' ? (token ? { 'PRIVATE-TOKEN': token } : {}) : { Accept: 'application/vnd.github+json' }

function listUrl(src: UpdateSource): string {
  return src.provider === 'gitlab'
    ? `${src.host.replace(/\/+$/, '')}/api/v4/projects/${encodeURIComponent(src.project)}/releases?per_page=30`
    : `https://api.github.com/repos/${src.repo}/releases?per_page=30`
}

/** Whether this running copy can replace itself, and if not, why. */
function installTarget(): { target?: string; blocked?: string } {
  if (process.platform !== 'darwin') return { blocked: 'Automatic install is only supported on macOS.' }
  if (!app.isPackaged) return { blocked: 'This is a development build.' }
  const target = appBundlePath(process.execPath)
  if (!target) return { blocked: 'The app is not running from an .app bundle.' }
  if (target.includes('/AppTranslocation/')) return { blocked: 'macOS is running the app from a temporary copy. Move it to Applications first.' }
  try { fs.accessSync(path.dirname(target), fs.constants.W_OK); fs.accessSync(target, fs.constants.W_OK) }
  catch { return { blocked: `You don't have permission to replace ${target}.` } }
  return { target }
}

export function registerUpdates(ipcMain: IpcMain, o: Opts): { checkInBackground(): void } {
  const src = BRAND.updates
  let state: UpdateState = { phase: 'idle' }
  let staged: { version: string; app: string; dir: string } | null = null
  let lastCheck: UpdateCheck | null = null
  let abort: AbortController | null = null
  const setState = (s: UpdateState) => { state = s; o.push({ type: 'update', state: s }) }

  async function check(): Promise<UpdateCheck> {
    const current = app.getVersion()
    const { target, blocked } = installTarget()
    const base = { current, newer: [] as ReleaseInfo[], canInstall: !!target, installBlocked: blocked }
    if (!src) return { ...base, error: 'This build has no release source configured.' }
    const token = src.provider === 'gitlab' ? (o.getToken() || process.env.GITLAB_TOKEN || undefined) : undefined
    try {
      const r = await fetch(listUrl(src), { headers: authHeaders(src, token), signal: AbortSignal.timeout(20_000) })
      if ((r.status === 401 || r.status === 403 || r.status === 404) && src.provider === 'gitlab')
        return { ...base, needsToken: true, error: gitlabAuthError(r.status, await r.text().catch(() => ''), !!token) }
      if (!r.ok) return { ...base, error: `Release server returned ${r.status} ${r.statusText}` }
      const all = parseReleases(src, await r.json(), process.arch)
      lastCheck = { ...base, latest: all[0]?.version, newer: all.filter((x) => compareVersions(x.version, current) > 0) }
      return lastCheck
    } catch (e) {
      return { ...base, error: `Could not reach the release server: ${(e as Error).message}` }
    }
  }

  async function download(version: string): Promise<{ ok: boolean; error?: string }> {
    if (state.phase === 'downloading') return { ok: false, error: 'A download is already running.' }
    const rel = lastCheck?.newer.find((r) => r.version === version)
    if (!rel?.zipUrl || !src) return { ok: false, error: 'This release has no macOS zip to install.' }
    const token = src.provider === 'gitlab' ? (o.getToken() || process.env.GITLAB_TOKEN || undefined) : undefined
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${BRAND.dataDir}-update-`))
    abort = new AbortController()
    try {
      setState({ phase: 'downloading', version, received: 0, total: 0 })
      const r = await fetch(rel.zipUrl, { headers: src.provider === 'gitlab' ? authHeaders(src, token) : {}, signal: abort.signal })
      if (!r.ok || !r.body) throw new Error(`Download failed: ${r.status} ${r.statusText}`)
      const total = Number(r.headers.get('content-length') || 0)
      const zip = path.join(dir, 'update.zip')
      const out = fs.createWriteStream(zip)
      let received = 0, last = 0
      for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
        received += chunk.length
        if (!out.write(chunk)) await new Promise((res) => out.once('drain', res))
        if (received - last > 1 << 20) { last = received; setState({ phase: 'downloading', version, received, total }) }
      }
      await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())))
      const unpacked = path.join(dir, 'app')
      await run('/usr/bin/ditto', ['-x', '-k', zip, unpacked])
      const name = fs.readdirSync(unpacked).find((f) => f.endsWith('.app'))
      if (!name) throw new Error('The download does not contain an app.')
      const newApp = path.join(unpacked, name)
      const { stdout } = await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(newApp, 'Contents/Info.plist')])
      if (stdout.trim() !== version) throw new Error(`The download is version ${stdout.trim()}, expected ${version}.`)
      await run('/usr/bin/xattr', ['-cr', newApp]).catch(() => undefined)
      fs.rmSync(zip, { force: true })
      if (staged) fs.rmSync(staged.dir, { recursive: true, force: true })
      staged = { version, app: newApp, dir }
      setState({ phase: 'ready', version })
      return { ok: true }
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true })
      const error = abort?.signal.aborted ? 'Download cancelled.' : (e as Error).message
      setState({ phase: 'error', version, error })
      return { ok: false, error }
    } finally { abort = null }
  }

  /** Quits, swaps the staged app into place, clears quarantine and reopens it. */
  function install(): { ok: boolean; error?: string } {
    const { target, blocked } = installTarget()
    if (!target) return { ok: false, error: blocked }
    if (!staged || !fs.existsSync(staged.app)) return { ok: false, error: 'Download the update first.' }
    const script = path.join(staged.dir, 'install.sh')
    fs.writeFileSync(script, [
      '#!/bin/sh',
      // Wait for this app to exit; if the quit is cancelled, the update applies on the next quit.
      'while kill -0 "$APP_PID" 2>/dev/null; do sleep 0.5; done',
      'rm -rf "$OLD_APP"',
      'if mv "$TARGET_APP" "$OLD_APP" && mv "$NEW_APP" "$TARGET_APP"; then',
      '  xattr -cr "$TARGET_APP" 2>/dev/null; rm -rf "$OLD_APP"',
      'else',
      '  [ -d "$TARGET_APP" ] || mv "$OLD_APP" "$TARGET_APP"',
      'fi',
      'open "$TARGET_APP"',
      'rm -rf "$STAGE_DIR"',
      ''
    ].join('\n'), { mode: 0o755 })
    spawn('/bin/sh', [script], {
      detached: true, stdio: 'ignore',
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', APP_PID: String(process.pid), TARGET_APP: target, NEW_APP: staged.app, OLD_APP: path.join(staged.dir, 'previous.app'), STAGE_DIR: staged.dir }
    }).unref()
    setImmediate(() => app.quit())
    return { ok: true }
  }

  ipcMain.handle('checkUpdates', () => check())
  ipcMain.handle('updateState', () => state)
  ipcMain.handle('downloadUpdate', (_e, version: string) => download(version))
  ipcMain.handle('cancelUpdate', () => { abort?.abort(); return true })
  ipcMain.handle('installUpdate', () => install())
  ipcMain.handle('openRelease', (_e, url: string) => { if (/^https:\/\//.test(url)) void shell.openExternal(url) })

  return {
    /** Quiet check shortly after launch; tells the renderer only when something newer exists. */
    checkInBackground() {
      if (!src || !app.isPackaged) return
      setTimeout(() => {
        void check().then((c) => { if (c.newer.length) o.push({ type: 'updateAvailable', version: c.newer[0].version }) })
      }, 15_000)
    }
  }
}
