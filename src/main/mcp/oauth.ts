import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'

/** What's remembered per server: OAuth client, tokens, discovery and the loopback port. */
export interface AuthRecord {
  client?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  discovery?: OAuthDiscoveryState
  port?: number
}

export interface Sealer { seal(s: string): string; open(s: string): string }

/** One JSON file of per-server records, each sealed (OS keychain) when a sealer is given. Written with mode 600. */
export class AuthStore {
  private cache: Record<string, string> | null = null
  constructor(private file: string, private sealer: Sealer | null) {}
  private load(): Record<string, string> {
    if (this.cache) return this.cache
    try { this.cache = JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch { this.cache = {} }
    return this.cache!
  }
  get(key: string): AuthRecord {
    const v = this.load()[key]
    if (!v) return {}
    try { return JSON.parse(this.sealer ? this.sealer.open(v) : v) } catch { return {} }
  }
  set(key: string, rec: AuthRecord): void {
    const all = this.load()
    if (!rec.client && !rec.tokens && !rec.discovery && !rec.port) delete all[key]
    else all[key] = this.sealer ? this.sealer.seal(JSON.stringify(rec)) : JSON.stringify(rec)
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(all, null, 2), { mode: 0o600 })
    try { fs.chmodSync(this.file, 0o600) } catch { /* best effort */ }
  }
  update(key: string, f: (r: AuthRecord) => AuthRecord): void { this.set(key, f(this.get(key))) }
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.unref()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)) })
  })
}

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:15px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:90vh;color:#24292f"><div style="text-align:center"><h2>${title}</h2><p>${body}</p></div></body>`
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/**
 * Waits for one OAuth redirect on http://127.0.0.1:<port>/ and resolves with its code.
 * The server is listening when the returned promise of `ready` settles; it closes after the first matching redirect.
 */
export function awaitRedirect(port: number, state: string, timeoutMs: number, signal?: AbortSignal, appName = 'the app'): { ready: Promise<void>; code: Promise<string>; close(): void } {
  let server: http.Server | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let settle: { resolve(c: string): void; reject(e: Error): void } = { resolve: () => {}, reject: () => {} }
  const code = new Promise<string>((resolve, reject) => { settle = { resolve, reject } })
  const close = () => { clearTimeout(timer); server?.close(); server?.closeAllConnections?.(); server = null }
  const fail = (e: Error) => { close(); settle.reject(e) }
  const ready = new Promise<void>((resolve, reject) => {
    server = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
      const got = u.searchParams.get('code'), err = u.searchParams.get('error'), st = u.searchParams.get('state')
      if (!got && !err) { res.writeHead(404).end(); return }
      if (st !== state) { res.writeHead(400, { 'content-type': 'text/html' }).end(page('Sign-in not recognized', 'This sign-in response is stale or from another app. Start the sign-in again.')); return }
      if (err) {
        const msg = `${err}${u.searchParams.get('error_description') ? `: ${u.searchParams.get('error_description')}` : ''}`
        res.writeHead(200, { 'content-type': 'text/html' }).end(page('Sign-in failed', esc(msg)))
        fail(new Error(`sign-in failed: ${msg}`))
        return
      }
      res.writeHead(200, { 'content-type': 'text/html' }).end(page('Signed in', `You can close this tab and return to ${esc(appName)}.`))
      close()
      settle.resolve(got!)
    })
    server.on('error', (e: any) => {
      const err = new Error(e?.code === 'EADDRINUSE' ? `port ${port} for the sign-in redirect is in use (another app, or another sign-in, may hold it); close it and try again` : `sign-in redirect server: ${e?.message ?? e}`)
      reject(err); fail(err)
    })
    server.listen(port, '127.0.0.1', () => resolve())
  })
  ready.catch(() => {})
  code.catch(() => {})
  timer = setTimeout(() => fail(new Error('sign-in timed out; no response from the browser')), timeoutMs)
  signal?.addEventListener('abort', () => fail(new Error('sign-in cancelled')), { once: true })
  return { ready, code, close }
}

export interface ProviderOptions {
  store: AuthStore
  /** Store key for this server. */
  key: string
  port: number
  clientName: string
  clientId?: string
  scopes?: string[]
  /** Called when the browser must be opened; non-interactive connects get `null` and stop with "needs sign-in". */
  onRedirect: (url: URL, state: string) => Promise<void> | void
}

/** OAuthClientProvider backed by AuthStore with a loopback redirect. */
export class McpOAuthProvider implements OAuthClientProvider {
  private verifier = ''
  private lastState = ''
  constructor(private o: ProviderOptions) {}

  get redirectUrl(): string { return `http://127.0.0.1:${this.o.port}/` }
  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl], client_name: this.o.clientName,
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
      ...(this.o.scopes?.length ? { scope: this.o.scopes.join(' ') } : {})
    }
  }
  state(): string { this.lastState = randomBytes(16).toString('hex'); return this.lastState }
  get pendingState(): string { return this.lastState }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const c = this.o.store.get(this.o.key).client
    if (this.o.clientId) return c?.client_id === this.o.clientId ? c : { client_id: this.o.clientId }
    return c
  }
  saveClientInformation(c: OAuthClientInformationMixed): void { this.o.store.update(this.o.key, (r) => ({ ...r, client: c })) }
  tokens(): OAuthTokens | undefined { return this.o.store.get(this.o.key).tokens }
  saveTokens(t: OAuthTokens): void { this.o.store.update(this.o.key, (r) => ({ ...r, tokens: t })) }
  discoveryState(): OAuthDiscoveryState | undefined { return this.o.store.get(this.o.key).discovery }
  saveDiscoveryState(d: OAuthDiscoveryState): void { this.o.store.update(this.o.key, (r) => ({ ...r, discovery: d })) }
  saveCodeVerifier(v: string): void { this.verifier = v }
  codeVerifier(): string { if (!this.verifier) throw new Error('no sign-in in progress'); return this.verifier }
  async redirectToAuthorization(url: URL): Promise<void> { await this.o.onRedirect(url, this.lastState) }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'verifier') { this.verifier = ''; return }
    this.o.store.update(this.o.key, (r) => {
      if (scope === 'all') return { port: r.port }
      const n = { ...r }
      if (scope === 'client') delete n.client
      if (scope === 'tokens') delete n.tokens
      if (scope === 'discovery') delete n.discovery
      return n
    })
  }
}
