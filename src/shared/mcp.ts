/** Connection state of one MCP server, as shown in Settings → MCP servers. */
export type McpState = 'connecting' | 'connected' | 'needs-auth' | 'signing-in' | 'error' | 'disabled'

export interface McpServerStatus {
  key: string
  name: string
  /** 'user' (personal config) or the working folder the server belongs to. */
  scope: string
  type: 'http' | 'sse' | 'stdio'
  /** URL, or the command line for stdio. */
  target: string
  /** Config file the entry came from. */
  source: string
  state: McpState
  error?: string
  tools: Array<{ name: string; description: string }>
  /** True when the server's tools come from the last successful connection (it needs sign-in before they run). */
  cachedTools?: boolean
  /** Whether sign-in tokens are stored for it. */
  signedIn: boolean
  /** Whether its entry lives in the app's own file, so Settings can edit or remove it. */
  editable?: boolean
  /** Whether it can use browser sign-in (http/sse). */
  oauth: boolean
}

/** The fields of Settings → MCP servers → Add/Edit server. */
export interface McpServerForm {
  name: string
  type: 'http' | 'sse' | 'stdio'
  url: string
  /** One `Name: value` per line. */
  headers: string
  command: string
  /** One argument per line. */
  args: string
  /** One `NAME=value` per line. */
  env: string
  /** Comma-separated tool names; empty or * = all. */
  tools: string
  oauthClientId: string
  /** Space- or comma-separated. */
  oauthScopes: string
  redirectPort: string
  disabled: boolean
}

export const emptyMcpForm = (): McpServerForm => ({ name: '', type: 'http', url: '', headers: '', command: '', args: '', env: '', tools: '', oauthClientId: '', oauthScopes: '', redirectPort: '', disabled: false })

const lines = (v: string) => v.split('\n').map((l) => l.trim()).filter(Boolean)
const pairs = (v: string, sep: RegExp): Record<string, string> | undefined => {
  const out: Record<string, string> = {}
  for (const l of lines(v)) { const m = sep.exec(l); if (m && m.index > 0) out[l.slice(0, m.index).trim()] = l.slice(m.index + m[0].length).trim() }
  return Object.keys(out).length ? out : undefined
}

/** Form → config-file entry (Copilot CLI shape). Throws a readable message on a bad value. */
export function mcpFormToEntry(f: McpServerForm): Record<string, unknown> {
  const e: Record<string, unknown> = { type: f.type }
  if (f.type === 'stdio') {
    if (!f.command.trim()) throw new Error('Enter the command that starts the server.')
    e.command = f.command.trim()
    const args = lines(f.args); if (args.length) e.args = args
    const env = pairs(f.env, /=/); if (env) e.env = env
  } else {
    const url = f.url.trim()
    if (!/^https?:\/\/\S+$/i.test(url)) throw new Error('Enter the server URL, starting with https:// or http://.')
    e.url = url
    const headers = pairs(f.headers, /:/); if (headers) e.headers = headers
    if (f.oauthClientId.trim()) e.oauthClientId = f.oauthClientId.trim()
    const scopes = f.oauthScopes.split(/[\s,]+/).filter(Boolean); if (scopes.length) e.oauthScopes = scopes
    if (f.redirectPort.trim()) {
      const p = Number(f.redirectPort)
      if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('Redirect port must be a number from 1 to 65535.')
      e.auth = { redirectPort: p }
    }
  }
  e.tools = f.tools.split(',').map((t) => t.trim()).filter(Boolean)
  if (!(e.tools as string[]).length) e.tools = ['*']
  if (f.disabled) e.disabled = true
  return e
}

/** Config-file entry → form; keys the form doesn't know are dropped on save. */
export function mcpEntryToForm(name: string, e: any): McpServerForm {
  const f = emptyMcpForm()
  const t = String(e?.type ?? e?.transport ?? '').toLowerCase()
  f.name = name
  f.type = t === 'sse' ? 'sse' : t === 'stdio' || t === 'local' || (!t && e?.command) ? 'stdio' : 'http'
  f.url = String(e?.url ?? '')
  f.headers = Object.entries(e?.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n')
  f.command = String(e?.command ?? '')
  f.args = (Array.isArray(e?.args) ? e.args : []).join('\n')
  f.env = Object.entries(e?.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n')
  const tools: string[] = Array.isArray(e?.tools) ? e.tools.map(String) : []
  f.tools = tools.includes('*') ? '' : tools.join(', ')
  f.oauthClientId = String(e?.oauthClientId ?? e?.auth?.clientId ?? '')
  f.oauthScopes = (e?.oauthScopes ?? e?.auth?.scopes ?? []).join(' ')
  f.redirectPort = e?.auth?.redirectPort ?? e?.oauthRedirectPort ? String(e?.auth?.redirectPort ?? e?.oauthRedirectPort) : ''
  f.disabled = e?.disabled === true || e?.enabled === false
  return f
}
