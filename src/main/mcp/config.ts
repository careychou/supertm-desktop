import fs from 'node:fs'
import path from 'node:path'

/** One MCP server entry, normalized from Copilot CLI / VS Code / Claude style config files. */
export interface McpServerConfig {
  name: string
  type: 'http' | 'sse' | 'stdio'
  url?: string
  headers?: Record<string, string>
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  /** Tool allow-list; undefined or containing '*' = all tools. */
  tools?: string[]
  /** Pre-registered OAuth client; without it the server's dynamic client registration is used. */
  oauthClientId?: string
  oauthScopes?: string[]
  /** Fixed loopback port registered with the identity provider for the OAuth redirect. */
  redirectPort?: number
  /** File the entry came from. */
  source: string
  /** 'user' for personal config, otherwise the working folder it belongs to. */
  scope: string
}

const expand = (v: string, env: NodeJS.ProcessEnv): string =>
  v.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, k) => env[k] ?? '')

const strMap = (o: unknown, env: NodeJS.ProcessEnv): Record<string, string> | undefined => {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null) out[k] = expand(String(v), env)
  return Object.keys(out).length ? out : undefined
}

/** Normalizes one raw entry; returns null for disabled or unusable entries. */
export function normalizeServer(name: string, raw: any, source: string, scope: string, env: NodeJS.ProcessEnv = process.env): McpServerConfig | null {
  if (!raw || typeof raw !== 'object' || raw.disabled === true || raw.enabled === false) return null
  const t = String(raw.type ?? raw.transport ?? '').toLowerCase()
  const type: McpServerConfig['type'] | null =
    t === 'sse' ? 'sse'
      : t === 'stdio' || t === 'local' ? 'stdio'
        : t === 'http' || t === 'streamable-http' || t === 'streamablehttp' || t === 'remote' ? 'http'
          : raw.command ? 'stdio' : raw.url ? 'http' : null
  if (!type) return null
  if (type === 'stdio' && !raw.command) return null
  if (type !== 'stdio' && !raw.url) return null
  const port = Number(raw.auth?.redirectPort ?? raw.oauthRedirectPort)
  const scopes = raw.oauthScopes ?? raw.auth?.scopes
  return {
    name, type, source, scope,
    ...(type === 'stdio'
      ? {
          command: expand(String(raw.command), env),
          args: Array.isArray(raw.args) ? raw.args.map((a: unknown) => expand(String(a), env)) : [],
          env: strMap(raw.env, env),
          ...(raw.cwd ? { cwd: expand(String(raw.cwd), env) } : {})
        }
      : { url: expand(String(raw.url), env), headers: strMap(raw.headers, env) }),
    ...(Array.isArray(raw.tools) ? { tools: raw.tools.map(String) } : {}),
    ...(raw.oauthClientId || raw.auth?.clientId ? { oauthClientId: String(raw.oauthClientId ?? raw.auth.clientId) } : {}),
    ...(Array.isArray(scopes) ? { oauthScopes: scopes.map(String) } : {}),
    ...(Number.isInteger(port) && port > 0 && port < 65536 ? { redirectPort: port } : {})
  }
}

/** Parses one config file's text; VS Code's .vscode/mcp.json keys servers under "servers", the others under "mcpServers". */
export function parseConfigText(text: string, source: string, scope: string, env: NodeJS.ProcessEnv = process.env): McpServerConfig[] {
  let raw: any
  try { raw = JSON.parse(text) } catch { return [] }
  const map = raw?.mcpServers ?? raw?.servers ?? raw?.mcp?.servers
  if (!map || typeof map !== 'object') return []
  return Object.entries(map).map(([n, v]) => normalizeServer(n, v, source, scope, env)).filter((x): x is McpServerConfig => !!x)
}

export const userConfigFiles = (home: string, appHomeDir: string): string[] => [
  path.join(home, '.copilot', 'mcp-config.json'),
  path.join(home, appHomeDir, 'mcp.json')
]

export const folderConfigFiles = (cwd: string): string[] => [
  path.join(cwd, '.vscode', 'mcp.json'),
  path.join(cwd, '.mcp.json'),
  path.join(cwd, '.github', 'mcp.json')
]

const readAll = (files: string[], scope: string, env: NodeJS.ProcessEnv): McpServerConfig[] => {
  const byName = new Map<string, McpServerConfig>()
  // later files override earlier ones of the same name
  for (const f of files) {
    let text: string
    try { text = fs.readFileSync(f, 'utf8') } catch { continue }
    for (const s of parseConfigText(text, f, scope, env)) byName.set(s.name, s)
  }
  return [...byName.values()]
}

export function loadUserServers(home: string, appHomeDir: string, env: NodeJS.ProcessEnv = process.env): McpServerConfig[] {
  return readAll(userConfigFiles(home, appHomeDir), 'user', env)
}

/** Folder servers; the home folder's own config is the user config, not a folder one. */
export function loadFolderServers(cwd: string, home: string, env: NodeJS.ProcessEnv = process.env): McpServerConfig[] {
  if (!cwd || path.resolve(cwd) === path.resolve(home)) return []
  return readAll(folderConfigFiles(cwd), cwd, env)
}

/** Identity of a server connection. */
export const serverKey = (s: Pick<McpServerConfig, 'scope' | 'name'>): string => `${s.scope}\u0000${s.name}`
/** A changed fingerprint reconnects the server. */
export const serverFingerprint = (s: McpServerConfig): string => JSON.stringify({ ...s, source: undefined })

/** `<server>-<tool>` restricted to the characters and length every provider accepts. */
export function toolName(server: string, tool: string, taken: Set<string>): string {
  const clean = (v: string) => v.replace(/[^a-zA-Z0-9_-]/g, '_')
  let base = `${clean(server)}-${clean(tool)}`
  if (base.length > 64) base = base.slice(0, 64)
  let name = base, i = 2
  while (taken.has(name)) { const suf = `_${i++}`; name = base.slice(0, 64 - suf.length) + suf }
  taken.add(name)
  return name
}

/** Whether an agent's `tools` list grants an MCP tool: '*', the server name, `server/*`, `server/tool` or the full tool name. */
export function agentAllows(agentTools: string[] | undefined, server: string, tool: string, fullName: string): boolean {
  if (!agentTools) return true
  return agentTools.some((e) => e === '*' || e === server || e === `${server}/*` || e === `${server}/${tool}` || e === `${server}-*` || e === fullName)
}

/** Whether a server's own `tools` allow-list includes a tool. */
export const serverAllows = (s: Pick<McpServerConfig, 'tools'>, tool: string): boolean => !s.tools || s.tools.includes('*') || s.tools.includes(tool)

/** Drops keys some providers reject and guarantees an object schema. */
export function cleanSchema(schema: any): Record<string, unknown> {
  const s = schema && typeof schema === 'object' ? { ...schema } : {}
  delete s.$schema
  if (s.type !== 'object') s.type = 'object'
  if (!s.properties || typeof s.properties !== 'object') s.properties = {}
  return s
}

/** Flattens an MCP tools/call result to text for the model. Throws when the server flags an error. */
export function formatResult(r: any, maxChars: number): string {
  const parts: string[] = []
  for (const c of Array.isArray(r?.content) ? r.content : []) {
    if (c?.type === 'text') parts.push(String(c.text ?? ''))
    else if (c?.type === 'image' || c?.type === 'audio') parts.push(`[${c.type}: ${c.mimeType ?? 'unknown type'}, ${Math.round(String(c.data ?? '').length * 0.75 / 1024)} KB, not shown]`)
    else if (c?.type === 'resource') parts.push(c.resource?.text !== undefined ? String(c.resource.text) : `[resource ${c.resource?.uri ?? ''}${c.resource?.mimeType ? ` (${c.resource.mimeType})` : ''}]`)
    else if (c?.type === 'resource_link') parts.push(`[resource link: ${c.name ? `${c.name} ` : ''}${c.uri ?? ''}]`)
  }
  if (!parts.length && r?.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent, null, 2))
  if (!parts.length && r?.toolResult !== undefined) parts.push(typeof r.toolResult === 'string' ? r.toolResult : JSON.stringify(r.toolResult, null, 2))
  let text = parts.join('\n\n') || '(no output)'
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n\n[output clipped at ${maxChars} of ${text.length} chars; raise "MCP tool output" in Settings → General → Limits to see more]`
  if (r?.isError) throw new Error(text)
  return text
}

/** Raw `mcpServers` map of a config file ({} when missing or unreadable). */
function readMap(file: string): { doc: any; map: Record<string, any> } {
  let doc: any = {}
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* new file */ }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) doc = {}
  const key = doc.mcpServers ? 'mcpServers' : doc.servers ? 'servers' : 'mcpServers'
  doc[key] ??= {}
  return { doc, map: doc[key] }
}

/** The raw entry of one server in a config file, for editing. */
export const readServerEntry = (file: string, name: string): Record<string, unknown> | null => readMap(file).map[name] ?? null

const NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/

/** Adds or replaces (renaming from `oldName`) one server entry, keeping the rest of the file. Throws on an invalid entry or a taken name. */
export function saveServerEntry(file: string, name: string, entry: Record<string, unknown>, oldName?: string): void {
  name = name.trim()
  if (!NAME.test(name)) throw new Error('Name must start with a letter or digit and use only letters, digits, spaces, "-", "_" or "." (max 64).')
  if (!normalizeServer(name, { ...entry, disabled: false, enabled: true }, file, 'user', {})) throw new Error(entry.command !== undefined || entry.type === 'stdio' ? 'A local (stdio) server needs a command.' : 'A remote server needs a URL.')
  const { doc, map } = readMap(file)
  if (name !== oldName && map[name] !== undefined) throw new Error(`A server named "${name}" already exists.`)
  const next: Record<string, any> = {}
  // keep the order; a renamed entry stays in its place
  for (const [k, v] of Object.entries(map)) next[k === oldName ? name : k] = k === oldName ? entry : v
  if (!(name in next)) next[name] = entry
  for (const k of Object.keys(map)) delete map[k]
  Object.assign(map, next)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n')
}

export function removeServerEntry(file: string, name: string): void {
  const { doc, map } = readMap(file)
  if (map[name] === undefined) return
  delete map[name]
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n')
}
