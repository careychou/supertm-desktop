import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { agentAllows, formatResult, loadFolderServers, loadUserServers, parseConfigText, readServerEntry, removeServerEntry, saveServerEntry, toolName } from '../src/main/mcp/config'
import { emptyMcpForm, mcpEntryToForm, mcpFormToEntry } from '../src/shared/mcp'
import { McpHub } from '../src/main/mcp/hub'

describe('mcp config', () => {
  it('adds, renames, turns off and removes several servers in the app file, keeping the others', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcph-'))
    const file = path.join(home, '.app', 'mcp.json')
    saveServerEntry(file, 'one', { type: 'http', url: 'https://one/mcp' })
    saveServerEntry(file, 'two', { command: 'npx', args: ['-y', 'srv'] })
    saveServerEntry(file, 'three', { type: 'sse', url: 'https://three' })
    expect(loadUserServers(home, '.app').map((s) => s.name)).toEqual(['one', 'two', 'three'])
    expect(() => saveServerEntry(file, 'two', { url: 'https://x' })).toThrow(/already exists/)
    expect(() => saveServerEntry(file, 'bad', { type: 'http' })).toThrow(/URL/)
    expect(() => saveServerEntry(file, '-x', { url: 'https://x' })).toThrow(/Name/)
    saveServerEntry(file, 'uno', { type: 'http', url: 'https://uno/mcp' }, 'one')
    saveServerEntry(file, 'two', { command: 'npx', disabled: true }, 'two')
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers)).toEqual(['uno', 'two', 'three'])
    expect(loadUserServers(home, '.app').map((s) => s.name)).toEqual(['uno', 'three'])
    expect(readServerEntry(file, 'two')).toMatchObject({ disabled: true })
    removeServerEntry(file, 'three')
    expect(loadUserServers(home, '.app').map((s) => s.name)).toEqual(['uno'])
  })

  it('round-trips the add/edit form to a config entry', () => {
    const f = { ...emptyMcpForm(), name: 'ma', url: 'https://x/mcp', headers: 'X-Key: ${KEY}', oauthClientId: 'cid', oauthScopes: 'openid, email', redirectPort: '33418', tools: 'whoami, sales' }
    const e = mcpFormToEntry(f)
    expect(e).toEqual({ type: 'http', url: 'https://x/mcp', headers: { 'X-Key': '${KEY}' }, oauthClientId: 'cid', oauthScopes: ['openid', 'email'], auth: { redirectPort: 33418 }, tools: ['whoami', 'sales'] })
    expect(mcpEntryToForm('ma', e)).toEqual({ ...f, oauthScopes: 'openid email' })
    expect(mcpFormToEntry({ ...emptyMcpForm(), type: 'stdio', command: 'npx', args: '-y\nsrv', env: 'A=1' })).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'srv'], env: { A: '1' }, tools: ['*'] })
    expect(() => mcpFormToEntry({ ...emptyMcpForm(), url: 'ftp://x' })).toThrow(/URL/)
    expect(() => mcpFormToEntry({ ...emptyMcpForm(), url: 'https://x', redirectPort: '99999' })).toThrow(/port/)
  })

  it('reads Copilot, VS Code and Claude shapes, expands env vars and skips disabled entries', () => {
    const env = { TOKEN: 'abc' }
    const copilot = parseConfigText(JSON.stringify({ mcpServers: {
      ma: { type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer ${TOKEN}' }, oauthClientId: 'cid', auth: { redirectPort: 33418 }, tools: ['*'] },
      off: { url: 'https://y', disabled: true },
      cli: { command: 'npx', args: ['-y', 'srv', '${env:TOKEN}'] }
    } }), 'f', 'user', env)
    expect(copilot.map((s) => [s.name, s.type])).toEqual([['ma', 'http'], ['cli', 'stdio']])
    expect(copilot[0]).toMatchObject({ headers: { Authorization: 'Bearer abc' }, oauthClientId: 'cid', redirectPort: 33418 })
    expect(copilot[1].args).toEqual(['-y', 'srv', 'abc'])
    expect(parseConfigText('{"servers":{"v":{"type":"sse","url":"https://z"}}}', 'f', 'user')[0].type).toBe('sse')
    expect(parseConfigText('not json', 'f', 'user')).toEqual([])
  })

  it('lets a later folder file override an earlier one and ignores the home folder', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-'))
    fs.mkdirSync(path.join(dir, '.vscode')); fs.mkdirSync(path.join(dir, '.github'))
    fs.writeFileSync(path.join(dir, '.vscode/mcp.json'), '{"servers":{"a":{"url":"https://old"},"b":{"url":"https://b"}}}')
    fs.writeFileSync(path.join(dir, '.github/mcp.json'), '{"mcpServers":{"a":{"url":"https://new"}}}')
    const got = loadFolderServers(dir, os.homedir())
    expect(Object.fromEntries(got.map((s) => [s.name, s.url]))).toEqual({ a: 'https://new', b: 'https://b' })
    expect(loadFolderServers(dir, dir)).toEqual([])
  })

  it('makes provider-safe unique tool names', () => {
    const taken = new Set<string>()
    expect(toolName('sales data', 'get.sales', taken)).toBe('sales_data-get_sales')
    expect(toolName('sales data', 'get.sales', taken)).toBe('sales_data-get_sales_2')
    expect(toolName('s', 'x'.repeat(100), taken)).toHaveLength(64)
  })

  it('matches sub-agent tool lists against MCP tools', () => {
    expect(agentAllows(undefined, 'ma', 'whoami', 'ma-whoami')).toBe(true)
    expect(agentAllows(['ma/*'], 'ma', 'whoami', 'ma-whoami')).toBe(true)
    expect(agentAllows(['ma/whoami'], 'ma', 'whoami', 'ma-whoami')).toBe(true)
    expect(agentAllows(['read_file', 'other/*'], 'ma', 'whoami', 'ma-whoami')).toBe(false)
  })

  it('flattens results, clips long output and throws on tool errors', () => {
    expect(formatResult({ content: [{ type: 'text', text: 'hi' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }] }, 100)).toMatch(/^hi\n\n\[image: image\/png/)
    expect(formatResult({ content: [], structuredContent: { n: 1 } }, 100)).toContain('"n": 1')
    expect(formatResult({ content: [{ type: 'text', text: 'x'.repeat(50) }] }, 10)).toMatch(/^x{10}\n\n\[output clipped at 10 of 50/)
    expect(() => formatResult({ isError: true, content: [{ type: 'text', text: 'boom' }] }, 100)).toThrow('boom')
  })
})

/** A local MCP server behind a tiny OAuth authorization server, like an enterprise MCP behind a company identity provider. */
async function oauthMcpServer() {
  const codes = new Map<string, string>()
  let issued = 0
  const tokens = new Set<string>()
  const server = http.createServer(async (req, res) => {
    const base = `http://127.0.0.1:${(server.address() as any).port}`
    const u = new URL(req.url!, base)
    const json = (o: unknown, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(o))
    if (u.pathname.startsWith('/.well-known/oauth-protected-resource')) return json({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['read'] })
    if (u.pathname === '/.well-known/oauth-authorization-server') return json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'] })
    if (u.pathname === '/authorize') {
      const code = `code${codes.size}`
      codes.set(code, u.searchParams.get('client_id')!)
      res.writeHead(302, { location: `${u.searchParams.get('redirect_uri')}?code=${code}&state=${u.searchParams.get('state')}` }).end()
      return
    }
    if (u.pathname === '/token') {
      let body = ''
      for await (const c of req) body += c
      const p = new URLSearchParams(body)
      if (p.get('grant_type') !== 'authorization_code' || !codes.has(p.get('code')!)) return json({ error: 'invalid_grant' }, 400)
      const t = `tok${++issued}`
      tokens.add(t)
      return json({ access_token: t, token_type: 'Bearer', expires_in: 3600 })
    }
    if (u.pathname === '/mcp') {
      const auth = String(req.headers.authorization ?? '').replace(/^Bearer /, '')
      if (!tokens.has(auth)) {
        res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` }).end()
        return
      }
      const mcp = new McpServer({ name: 'test', version: '1' })
      mcp.registerTool('whoami', { description: 'Who is signed in', inputSchema: { greeting: z.string().optional() } }, async ({ greeting }) => ({ content: [{ type: 'text', text: `${greeting ?? 'hello'} user (${auth})` }] }))
      const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.on('close', () => { void t.close(); void mcp.close() })
      await mcp.connect(t)
      await t.handleRequest(req, res)
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return { server, url: `http://127.0.0.1:${(server.address() as any).port}/mcp`, revoke: () => tokens.clear() }
}

describe('mcp hub', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => { while (cleanups.length) cleanups.pop()!() })

  it('waits for a user sign-in, completes the browser OAuth flow, lists and calls tools, and re-signs in after a revoked token', async () => {
    const srv = await oauthMcpServer()
    cleanups.push(() => srv.server.close())
    const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-'))
    const opened: string[] = []
    const hub = new McpHub({
      dataHome, appName: 'Test', appVersion: '1', sealer: null, fetch: fetch as any, onChange: () => {},
      enabled: () => true, maxOutputChars: () => 1000,
      servers: () => [{ name: 'ma', type: 'http', url: srv.url, oauthClientId: 'cid', source: 'f', scope: 'user' }],
      // stands in for the browser: follow the authorize redirect to the app's loopback listener
      openExternal: async (url) => {
        opened.push(url)
        const r = await fetch(url, { redirect: 'manual' })
        await fetch(r.headers.get('location')!)
      }
    })
    cleanups.push(() => hub.dispose())
    hub.reload()
    const settled = async () => { for (let i = 0; i < 100 && hub.status()[0].state === 'connecting'; i++) await new Promise((r) => setTimeout(r, 20)) }
    await settled()
    // never opens the browser on its own at startup
    expect(hub.status()[0].state).toBe('needs-auth')
    expect(opened).toEqual([])

    await hub.signIn(hub.status()[0].key)
    expect(opened).toHaveLength(1)
    expect(new URL(opened[0]).searchParams.get('client_id')).toBe('cid')
    expect(hub.status()[0]).toMatchObject({ state: 'connected', signedIn: true, tools: [{ name: 'whoami' }] })

    const [tool] = hub.tools('/any')
    expect(tool.name).toBe('ma-whoami')
    expect(tool.permission).toBe('mcp')
    const ctx = { signal: new AbortController().signal } as any
    expect(await tool.run({ greeting: 'hi' }, ctx)).toBe('hi user (tok1)')
    expect(hub.tools('/any', ['read_file'])).toEqual([])

    // a revoked/expired token opens the sign-in again and retries the call
    srv.revoke()
    expect(await tool.run({}, ctx)).toBe('hello user (tok2)')
    expect(opened).toHaveLength(2)

    // tokens survive a restart: a new hub connects without the browser
    hub.dispose()
    const hub2 = new McpHub({ ...(hub as any).o })
    cleanups.push(() => hub2.dispose())
    hub2.reload()
    for (let i = 0; i < 100 && hub2.status()[0].state === 'connecting'; i++) await new Promise((r) => setTimeout(r, 20))
    expect(hub2.status()[0].state).toBe('connected')
    expect(opened).toHaveLength(2)
  })
})
