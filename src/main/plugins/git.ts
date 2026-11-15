import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { toHttps, toSsh, type GitAccess } from '../../shared/plugins'

export interface RunResult { code: number; stdout: string; stderr: string }
export type Runner = (cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; onLine?: (l: string) => void; signal?: AbortSignal }) => Promise<RunResult>

/** Runs a command without a shell; output lines go to onLine as they arrive. */
export const runCommand: Runner = (cmd, args, opts) => new Promise((resolve) => {
  const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = '', buf = ''
  const line = (s: string) => {
    if (!opts.onLine) return
    buf += s
    const parts = buf.split(/\r?\n/)
    buf = parts.pop() ?? ''
    for (const p of parts) opts.onLine(p)
  }
  child.stdout.on('data', (d) => { const s = d.toString(); stdout += s; line(s) })
  child.stderr.on('data', (d) => { const s = d.toString(); stderr += s; line(s) })
  const timer = opts.timeoutMs ? setTimeout(() => { stderr += `\n(timed out after ${Math.round(opts.timeoutMs! / 1000)}s)`; child.kill('SIGTERM') }, opts.timeoutMs) : undefined
  const abort = () => child.kill('SIGTERM')
  opts.signal?.addEventListener('abort', abort)
  child.on('error', (e) => { stderr += String(e.message); })
  child.on('close', (code) => {
    if (timer) clearTimeout(timer)
    opts.signal?.removeEventListener('abort', abort)
    if (buf && opts.onLine) opts.onLine(buf)
    resolve({ code: code ?? 1, stdout, stderr })
  })
})

/** How to reach one repository: the URL to use and the env that authenticates it. */
export interface Access { kind: GitAccess; url: string; env: NodeJS.ProcessEnv }

const isRemote = (u: string) => /^(https?:\/\/|git@|ssh:\/\/)/.test(u)

/**
 * Fetches git repositories with the user's existing access: SSH keys first, then HTTPS with a saved
 * token (handed to git through GIT_ASKPASS, never put in a URL or argv), then anonymous HTTPS.
 */
export class GitFetcher {
  private askpass?: string
  constructor(private getToken: () => string | undefined, private run: Runner = runCommand, private tmpRoot = os.tmpdir()) {}

  private baseEnv(): NodeJS.ProcessEnv {
    return { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new' }
  }

  private askpassScript(): string {
    if (!this.askpass || !fs.existsSync(this.askpass)) {
      const dir = fs.mkdtempSync(path.join(this.tmpRoot, 'askpass-'))
      this.askpass = path.join(dir, 'askpass.sh')
      // Username prompts get "oauth2", password prompts the token from the env (GitLab and GitHub accept this).
      fs.writeFileSync(this.askpass, '#!/bin/sh\ncase "$1" in Username*) echo oauth2 ;; *) echo "$DESK_GIT_TOKEN" ;; esac\n', { mode: 0o700 })
    }
    return this.askpass
  }

  /** Env that authenticates HTTPS with the given token. */
  tokenEnv(token: string): NodeJS.ProcessEnv {
    return { ...this.baseEnv(), GIT_ASKPASS: this.askpassScript(), DESK_GIT_TOKEN: token }
  }

  /** Finds a working way to read `url`, trying SSH, HTTPS + token, then anonymous HTTPS. */
  async probe(url: string, signal?: AbortSignal): Promise<Access> {
    if (!isRemote(url)) return { kind: 'ssh', url, env: this.baseEnv() }
    const tries: Access[] = [{ kind: 'ssh', url: toSsh(toHttps(url)), env: this.baseEnv() }]
    const token = this.getToken()
    if (token) tries.push({ kind: 'https-token', url: toHttps(url), env: this.tokenEnv(token) })
    tries.push({ kind: 'https', url: toHttps(url), env: this.baseEnv() })
    for (const t of tries) {
      const r = await this.run('git', ['ls-remote', '--heads', t.url], { env: t.env, timeoutMs: 30_000, signal })
      if (r.code === 0) return t
    }
    return { kind: 'auth-needed', url, env: this.baseEnv() }
  }

  /** SHA of `ref` (branch or tag) on the remote, or undefined. */
  async remoteHead(a: Access, ref: string, signal?: AbortSignal): Promise<string | undefined> {
    const r = await this.run('git', ['ls-remote', a.url, ref, `refs/tags/${ref}^{}`], { env: a.env, timeoutMs: 30_000, signal })
    if (r.code !== 0) return undefined
    const lines = r.stdout.trim().split('\n').filter(Boolean).map((l) => l.split(/\s+/))
    const peeled = lines.find((l) => l[1]?.endsWith('^{}'))
    const head = lines.find((l) => l[1] === `refs/heads/${ref}`) ?? lines.find((l) => l[1] === `refs/tags/${ref}`) ?? lines[0]
    return (peeled ?? head)?.[0]
  }

  /**
   * Shallow clone of `ref` into `dest`; returns the checked-out SHA. With `sparse`, only those paths are
   * checked out (and, where the server allows, downloaded); add more later with sparseAdd().
   */
  async clone(a: Access, ref: string | undefined, dest: string, opts: { onLine?: (l: string) => void; signal?: AbortSignal; sparse?: string[] } = {}): Promise<string> {
    const sparse = opts.sparse ? ['--filter=blob:none', '--no-checkout'] : []
    const args = ['clone', '--depth', '1', '--quiet', ...sparse, ...(ref ? ['--branch', ref] : []), a.url, dest]
    const r = await this.run('git', args, { env: a.env, timeoutMs: 5 * 60_000, onLine: opts.onLine, signal: opts.signal })
    if (r.code !== 0) throw new Error(`git clone failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`)
    if (opts.sparse) {
      await this.must(['sparse-checkout', 'set', '--no-cone', ...opts.sparse], dest, a.env, opts.signal)
      await this.must(['checkout', '--quiet'], dest, a.env, opts.signal)
    }
    const h = await this.run('git', ['rev-parse', 'HEAD'], { cwd: dest, env: a.env })
    return h.stdout.trim()
  }

  /** Adds paths to a sparse clone made by clone({ sparse }). `env` must authenticate the original remote. */
  async sparseAdd(dir: string, paths: string[], env: NodeJS.ProcessEnv = this.baseEnv(), signal?: AbortSignal): Promise<void> {
    await this.must(['sparse-checkout', 'add', ...paths], dir, env, signal)
  }

  private async must(args: string[], cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal) {
    const r = await this.run('git', args, { cwd, env, timeoutMs: 5 * 60_000, signal })
    if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`)
  }

  dispose() { if (this.askpass) fs.rmSync(path.dirname(this.askpass), { recursive: true, force: true }); this.askpass = undefined }
}
