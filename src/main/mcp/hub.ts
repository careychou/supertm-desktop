import fs from 'node:fs'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import type { Transport, FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { ToolDef } from '../../engine/tools/types'
import type { McpServerStatus, McpState } from '../../shared/mcp'
import { agentAllows, cleanSchema, formatResult, serverAllows, serverFingerprint, serverKey, toolName, type McpServerConfig } from './config'
import { AuthStore, McpOAuthProvider, awaitRedirect, freePort } from './oauth'

interface CachedTool { name: string; description: string; inputSchema: unknown }

interface Conn {
  cfg: McpServerConfig
  fp: string
  state: McpState
  error?: string
  client?: Client
  tools: CachedTool[]
  /** Tools are from an earlier session (not connected now). */
  cached: boolean
  connecting?: Promise<void>
  signIn?: { abort: AbortController; done: Promise<void> }
  stderr: string[]
}

export interface HubOptions {
  dataHome: string
  appName: string
  appVersion: string
  fetch: FetchLike
  openExternal(url: string): Promise<void> | void
  sealer: { seal(s: string): string; open(s: string): string } | null
  /** Called whenever any server's status changes. */
  onChange(): void
  /** Max chars of a tool result; read on every call. */
  maxOutputChars(): number
  /** Server lists to manage; re-read by reload(). */
  servers(): McpServerConfig[]
  enabled(): boolean
  /** Extra detail for a connection error (e.g. why a certificate was rejected). */
  explain?(error: string, cfg: McpServerConfig): string | undefined
}

const SIGN_IN_TIMEOUT = 5 * 60_000
const CALL_TIMEOUT = 15 * 60_000

class NeedsAuth extends Error { constructor() { super('needs sign-in') } }
const isAuthError = (e: any) => e instanceof UnauthorizedError || e instanceof NeedsAuth || e?.code === 401 || /\b401\b|unauthori[sz]ed|invalid_token/i.test(String(e?.message ?? ''))

/** Owns every MCP server connection: connect, browser sign-in, tool listing and calls. */
export class McpHub {
  private conns = new Map<string, Conn>()
  private store: AuthStore
  private cacheFile: string
  private toolCache: Record<string, { fp: string; tools: CachedTool[] }> = {}

  constructor(private o: HubOptions) {
    this.store = new AuthStore(path.join(o.dataHome, 'mcp-auth.json'), o.sealer)
    this.cacheFile = path.join(o.dataHome, 'mcp-tools.json')
    try { this.toolCache = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8')) } catch { /* none yet */ }
  }

  /** Re-reads the config: adds new servers, reconnects changed ones, drops removed ones. Doesn't open the browser. */
  reload(): void {
    const want = this.o.enabled() ? this.o.servers() : []
    const keys = new Set(want.map(serverKey))
    for (const [k, c] of this.conns) if (!keys.has(k)) { this.disconnect(c); this.conns.delete(k) }
    for (const cfg of want) {
      const k = serverKey(cfg), fp = serverFingerprint(cfg)
      const old = this.conns.get(k)
      if (old && old.fp === fp) { old.cfg = cfg; continue }
      if (old) this.disconnect(old)
      const hit = this.toolCache[k]
      const c: Conn = { cfg, fp, state: 'connecting', tools: hit?.fp === fp ? hit.tools : [], cached: true, stderr: [] }
      this.conns.set(k, c)
      void this.connect(c, false)
    }
    this.o.onChange()
  }

  status(): McpServerStatus[] {
    return [...this.conns.entries()].map(([key, c]) => ({
      key, name: c.cfg.name, scope: c.cfg.scope, type: c.cfg.type, source: c.cfg.source,
      target: c.cfg.type === 'stdio' ? [c.cfg.command, ...(c.cfg.args ?? [])].join(' ') : c.cfg.url ?? '',
      state: c.state, error: c.error,
      tools: c.tools.filter((t) => serverAllows(c.cfg, t.name)).map((t) => ({ name: t.name, description: t.description })),
      cachedTools: c.cached && c.tools.length > 0,
      signedIn: !!this.store.get(key).tokens, oauth: c.cfg.type !== 'stdio'
    }))
  }

  /** Model-facing tools for a chat in `cwd`, optionally filtered by a sub-agent's `tools` list. */
  tools(cwd: string, agentTools?: string[]): ToolDef[] {
    const taken = new Set<string>()
    const out: ToolDef[] = []
    for (const [key, c] of this.conns) {
      if (c.state === 'disabled' || (c.cfg.scope !== 'user' && c.cfg.scope !== cwd)) continue
      for (const t of c.tools) {
        if (!serverAllows(c.cfg, t.name)) continue
        const name = toolName(c.cfg.name, t.name, taken)
        if (!agentAllows(agentTools, c.cfg.name, t.name, name)) continue
        out.push({
          name,
          description: `[MCP server "${c.cfg.name}"] ${t.description || t.name}`.slice(0, 1024),
          parameters: cleanSchema(t.inputSchema),
          permission: 'mcp',
          summarize: (args) => `${c.cfg.name} → ${t.name}\n${JSON.stringify(args, null, 2)}`,
          run: (args, ctx) => this.call(key, t.name, args, ctx.signal)
        })
      }
    }
    return out
  }

  /** Opens the browser to sign in (or reconnects with stored tokens when they still work). */
  async signIn(key: string): Promise<void> {
    const c = this.conns.get(key)
    if (!c) throw new Error('unknown MCP server')
    if (c.signIn) return c.signIn.done
    const abort = new AbortController()
    const done = (async () => {
      this.set(c, 'signing-in')
      try { await this.connect(c, true, abort.signal) } finally { c.signIn = undefined }
      if (c.state !== 'connected') throw new Error(c.error || 'sign-in did not complete')
    })()
    c.signIn = { abort, done }
    done.catch(() => {})
    return done
  }

  cancelSignIn(key: string): void { this.conns.get(key)?.signIn?.abort.abort() }

  signOut(key: string): void {
    const c = this.conns.get(key)
    this.store.update(key, (r) => ({ port: r.port, client: r.client }))
    if (c) { this.disconnect(c); this.set(c, c.cfg.type === 'stdio' ? 'error' : 'needs-auth', c.cfg.type === 'stdio' ? 'disconnected' : undefined) }
  }

  /** Drops stored sign-in, client registration and cached tools of a server that was removed. */
  forget(key: string): void {
    this.store.set(key, {})
    if (this.toolCache[key]) { delete this.toolCache[key]; try { fs.writeFileSync(this.cacheFile, JSON.stringify(this.toolCache)) } catch { /* best effort */ } }
  }

  /** Retries every server that failed to connect (not ones waiting for sign-in), e.g. after the network recovers. */
  retryFailed(): void {
    for (const c of this.conns.values()) if (c.state === 'error' && !c.connecting) { this.disconnect(c); void this.connect(c, false) }
  }

  async reconnect(key: string): Promise<void> {
    const c = this.conns.get(key)
    if (!c) return
    this.disconnect(c)
    await this.connect(c, false)
  }

  dispose(): void { for (const c of this.conns.values()) this.disconnect(c); this.conns.clear() }

  private set(c: Conn, state: McpState, error?: string) {
    if (state !== c.state || error !== c.error) console.log(`[mcp] ${c.cfg.name}: ${state}${error ? ` — ${error}` : ''}`)
    c.state = state; c.error = error; this.o.onChange()
  }

  private disconnect(c: Conn) {
    const cl = c.client
    c.client = undefined
    c.signIn?.abort.abort()
    if (cl) { cl.onclose = undefined; void cl.close().catch(() => {}) }
  }

  private async port(key: string, cfg: McpServerConfig): Promise<number> {
    if (cfg.redirectPort) return cfg.redirectPort
    // a dynamically registered client is bound to its redirect URL, so keep using the same port
    const saved = this.store.get(key).port
    if (saved) return saved
    const p = await freePort()
    this.store.update(key, (r) => ({ ...r, port: p }))
    return p
  }

  private connect(c: Conn, interactive: boolean, signal?: AbortSignal): Promise<void> {
    if (c.connecting && !interactive) return c.connecting
    const run = this.doConnect(c, interactive, signal).finally(() => { if (c.connecting === run) c.connecting = undefined })
    c.connecting = run
    return run
  }

  private async doConnect(c: Conn, interactive: boolean, signal?: AbortSignal): Promise<void> {
    const key = serverKey(c.cfg)
    if (!interactive) this.set(c, 'connecting')
    let pending: ReturnType<typeof awaitRedirect> | null = null
    // only this connect may open the browser; a later 401 on the live connection goes through call() instead
    let mayRedirect = interactive
    const provider = c.cfg.type === 'stdio' ? undefined : new McpOAuthProvider({
      store: this.store, key, port: await this.port(key, c.cfg), clientName: this.o.appName,
      clientId: c.cfg.oauthClientId, scopes: c.cfg.oauthScopes,
      onRedirect: async (url, state) => {
        if (!mayRedirect) throw new NeedsAuth()
        mayRedirect = false
        pending = awaitRedirect(Number(new URL(provider!.redirectUrl).port), state, SIGN_IN_TIMEOUT, signal, this.o.appName)
        await pending.ready
        await this.o.openExternal(url.toString())
      }
    })
    const transport = (): Transport => {
      const cfg = c.cfg
      if (cfg.type === 'stdio') {
        const t = new StdioClientTransport({ command: cfg.command!, args: cfg.args, env: { ...(process.env as Record<string, string>), ...cfg.env }, cwd: cfg.cwd ?? (cfg.scope !== 'user' ? cfg.scope : undefined), stderr: 'pipe' })
        t.stderr?.on('data', (d: Buffer) => { c.stderr.push(...String(d).split('\n').filter(Boolean)); c.stderr.splice(0, Math.max(0, c.stderr.length - 20)) })
        return t
      }
      const opts = { authProvider: provider, fetch: this.o.fetch, requestInit: cfg.headers ? { headers: cfg.headers } : undefined }
      return cfg.type === 'sse' ? new SSEClientTransport(new URL(cfg.url!), opts) : new StreamableHTTPClientTransport(new URL(cfg.url!), opts)
    }
    const open = async (): Promise<Client> => {
      const client = new Client({ name: this.o.appName, version: this.o.appVersion }, {
        listChanged: { tools: { onChanged: (err, tools) => { if (!err && tools && c.client === client) this.setTools(c, key, tools as any) } } }
      })
      const t = transport()
      try { await client.connect(t); return client }
      catch (e) {
        if (!(e instanceof UnauthorizedError) || !pending || !(t as any).finishAuth) throw e
        const code = await (pending as ReturnType<typeof awaitRedirect>).code
        pending = null
        await (t as any).finishAuth(code)
        const again = new Client({ name: this.o.appName, version: this.o.appVersion }, {
          listChanged: { tools: { onChanged: (err, tools) => { if (!err && tools && c.client === again) this.setTools(c, key, tools as any) } } }
        })
        await again.connect(transport())
        return again
      }
    }
    try {
      const client = await open()
      mayRedirect = false
      if (signal?.aborted) { void client.close(); throw new Error('sign-in cancelled') }
      this.disconnect(c)
      c.client = client
      client.onclose = () => { if (c.client === client) { c.client = undefined; this.set(c, 'error', 'disconnected; it reconnects on the next tool call') } }
      const tools: CachedTool[] = []
      let cursor: string | undefined
      do {
        const r = await client.listTools(cursor ? { cursor } : undefined)
        tools.push(...r.tools.map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema })))
        cursor = r.nextCursor
      } while (cursor)
      this.setTools(c, key, tools)
      this.set(c, 'connected')
    } catch (e: any) {
      mayRedirect = false
      ;(pending as ReturnType<typeof awaitRedirect> | null)?.close()
      if (c.cfg.type !== 'stdio' && isAuthError(e)) this.set(c, 'needs-auth', interactive ? e?.message : undefined)
      else {
        const tail = c.stderr.slice(-3).join(' · ')
        const msg = `${e?.message ?? String(e)}${tail ? ` — ${tail}` : ''}`
        let more: string | undefined
        try { more = this.o.explain?.(msg, c.cfg) } catch { /* best effort */ }
        this.set(c, 'error', more ? `${msg}\n${more}` : msg)
      }
    }
  }

  private setTools(c: Conn, key: string, tools: CachedTool[]) {
    c.tools = tools
    c.cached = false
    this.toolCache[key] = { fp: c.fp, tools }
    try { fs.writeFileSync(this.cacheFile, JSON.stringify(this.toolCache)) } catch { /* cache is best-effort */ }
    this.o.onChange()
  }

  /** Runs a tool, connecting first if needed; a server that needs sign-in opens the browser once and retries. */
  private async call(key: string, tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const c = this.conns.get(key)
    if (!c) throw new Error('this MCP server was removed from the config')
    const ensure = async () => {
      if (c.client && c.state === 'connected') return
      if (c.state !== 'needs-auth') await this.connect(c, false)
      if (c.state === 'needs-auth' || c.state === 'signing-in') await this.signIn(key)
      if (!c.client) throw new Error(`MCP server "${c.cfg.name}" is not connected: ${c.error ?? c.state}`)
    }
    await ensure()
    const invoke = () => c.client!.callTool({ name: tool, arguments: args }, undefined, { signal, timeout: CALL_TIMEOUT, resetTimeoutOnProgress: true })
    try {
      return formatResult(await invoke(), this.o.maxOutputChars())
    } catch (e: any) {
      if (signal.aborted || !isAuthError(e) || c.cfg.type === 'stdio') throw e
      // the access token expired or was revoked mid-session
      this.disconnect(c)
      this.set(c, 'needs-auth')
      await ensure()
      return formatResult(await invoke(), this.o.maxOutputChars())
    }
  }
}
