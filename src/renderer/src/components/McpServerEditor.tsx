import { useState } from 'react'
import { mcpFormToEntry, type McpServerForm } from '../../../shared/mcp'
import { Lbl } from './Info'

const errText = (e: any) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Add or edit one MCP server; saves straight to the app's own config file. */
export function McpServerEditor({ initial, oldName, onDone, onCancel }: { initial: McpServerForm; oldName?: string; onDone(): void; onCancel(): void }) {
  const [f, setF] = useState(initial)
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)
  const [more, setMore] = useState(!!(initial.headers || initial.oauthClientId || initial.oauthScopes || initial.redirectPort || initial.tools || initial.env))
  const set = <K extends keyof McpServerForm>(k: K, v: McpServerForm[K]) => setF({ ...f, [k]: v })
  const remote = f.type !== 'stdio'
  const save = async () => {
    setErr('')
    let entry: Record<string, unknown>
    try { entry = mcpFormToEntry(f) } catch (e) { setErr(errText(e)); return }
    setSaving(true)
    try { await window.desk.mcpSaveServer(f.name, entry, oldName); onDone() } catch (e) { setErr(errText(e)) } finally { setSaving(false) }
  }
  return (
    <div className="mcp-server mcp-edit">
      <b>{oldName ? `Edit ${oldName}` : 'Add MCP server'}</b>
      <label><Lbl text="Name" tip="A short name for the server. Its tools are offered to the agent as <name>-<tool>, and a sub-agent's tools list can allow it as <name>/*." ex="sales-data → tools named sales-data-get_report" />
        <input value={f.name} autoFocus placeholder="my-server" onChange={(e) => set('name', e.target.value)} />
      </label>
      <label><Lbl text="Connection" tip="Remote servers are reached over HTTPS (Streamable HTTP, or the older SSE). Local servers are a program on this Mac that the app starts and talks to over stdin/stdout." ex="Remote: https://example.com/mcp · Local: npx -y @some/mcp-server" />
        <select value={f.type} onChange={(e) => set('type', e.target.value as McpServerForm['type'])}>
          <option value="http">Remote — HTTP (Streamable HTTP)</option>
          <option value="sse">Remote — SSE (older servers)</option>
          <option value="stdio">Local — a program on this Mac (stdio)</option>
        </select>
      </label>
      {remote ? (
        <label><Lbl text="URL" tip="The server's MCP endpoint. If it asks for a sign-in, the app opens your browser when you click Sign in." ex="https://example.com/mcp" />
          <input value={f.url} placeholder="https://example.com/mcp" onChange={(e) => set('url', e.target.value)} />
        </label>
      ) : <>
        <label><Lbl text="Command" tip="The program to start. It runs with your PATH plus Homebrew's." ex="npx · uvx · /usr/local/bin/my-server" />
          <input value={f.command} placeholder="npx" onChange={(e) => set('command', e.target.value)} />
        </label>
        <label><Lbl text="Arguments (one per line)" tip="Passed to the command in order. ${NAME} is replaced by that environment variable." ex={'-y\n@modelcontextprotocol/server-filesystem\n~/Documents'} />
          <textarea rows={3} value={f.args} onChange={(e) => set('args', e.target.value)} />
        </label>
      </>}
      <button className="link small mcp-more" onClick={() => setMore(!more)}>{more ? '▾' : '▸'} Advanced{remote ? ' — headers, sign-in, tools' : ' — environment, tools'}</button>
      {more && <>
        {remote ? <>
          <label><Lbl text="Headers (one per line)" tip="Sent with every request, for servers that use an API key instead of a browser sign-in. ${NAME} is replaced by that environment variable, so the key doesn't have to be stored in the file." ex="Authorization: Bearer ${MY_API_KEY}" />
            <textarea rows={2} value={f.headers} placeholder="Authorization: Bearer ${MY_API_KEY}" onChange={(e) => set('headers', e.target.value)} />
          </label>
          <label><Lbl text="Sign-in client ID" tip="Only for servers whose identity provider (Okta, Entra ID…) needs a pre-registered app. Leave empty to let the server register the app automatically." ex="0oa1abc2def3GHI4j5k6" />
            <input value={f.oauthClientId} placeholder="automatic" onChange={(e) => set('oauthClientId', e.target.value)} />
          </label>
          <label><Lbl text="Sign-in scopes" tip="Permissions to ask for when signing in, separated by spaces. Leave empty to use what the server advertises." ex="openid email profile offline_access data:read" />
            <input value={f.oauthScopes} placeholder="from the server" onChange={(e) => set('oauthScopes', e.target.value)} />
          </label>
          <label><Lbl text="Sign-in redirect port" tip="Only when the client ID was registered with a fixed redirect address http://127.0.0.1:<port>/. Leave empty to pick a free port." ex="33418" />
            <input value={f.redirectPort} placeholder="any free port" onChange={(e) => set('redirectPort', e.target.value)} />
          </label>
        </> : (
          <label><Lbl text="Environment (one per line)" tip="Extra environment variables for the program, on top of the app's own." ex="API_KEY=${MY_API_KEY}" />
            <textarea rows={2} value={f.env} placeholder="NAME=value" onChange={(e) => set('env', e.target.value)} />
          </label>
        )}
        <label><Lbl text="Only these tools (comma-separated)" tip="Offer just some of the server's tools to the agent. Leave empty for all of them." ex="whoami, get_sales" />
          <input value={f.tools} placeholder="all tools" onChange={(e) => set('tools', e.target.value)} />
        </label>
      </>}
      {err && <div className="mcp-err small">{err}</div>}
      <div className="row-actions">
        <button className="primary" disabled={saving} onClick={() => void save()}>{saving ? <><span className="spinner" /> Saving…</> : oldName ? 'Save server' : 'Add server'}</button>
        <button disabled={saving} onClick={onCancel}>Cancel</button>
        <span className="muted small">Saved right away; it connects in the background.</span>
      </div>
    </div>
  )
}
