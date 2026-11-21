import { useEffect, useState } from 'react'
import type { Settings } from '../../../shared/api'
import { emptyMcpForm, mcpEntryToForm, type McpServerForm, type McpServerStatus } from '../../../shared/mcp'
import { BRAND } from '../../../shared/brand'
import { Lbl } from './Info'
import { McpServerEditor } from './McpServerEditor'

const toast = (m: string) => window.dispatchEvent(new CustomEvent('desk-toast', { detail: m }))
const tilde = (p: string) => p.replace(/^\/Users\/[^/]+/, '~')
const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p

const STATE: Record<McpServerStatus['state'], [string, string]> = {
  connecting: ['busy', 'Connecting…'],
  connected: ['ok', 'Connected'],
  'needs-auth': ['warn', 'Sign-in needed'],
  'signing-in': ['busy', 'Signing in… finish in your browser'],
  error: ['bad', 'Not connected'],
  disabled: ['', 'Off']
}


/** Settings → MCP servers: what's configured, its state, sign-in, and the trust/CA options. */
export function McpTab({ s, setS }: { s: Settings; setS(s: Settings): void }) {
  const [list, setList] = useState<McpServerStatus[] | null>(null)
  const [files, setFiles] = useState<string[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  // null: no editor; '' : adding; otherwise the name being edited
  const [edit, setEdit] = useState<{ name: string; form: McpServerForm } | null>(null)
  useEffect(() => {
    void window.desk.mcpStatus().then(setList)
    void window.desk.mcpConfigFiles().then(setFiles)
    return window.desk.onPush((p) => { if (p.type === 'mcpStatus') setList(p.servers) })
  }, [])
  const act = async (key: string, label: string, f: () => Promise<unknown>) => {
    setBusy(key + label)
    try { await f() } catch (e: any) { toast(`${label} failed: ${String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`) } finally { setBusy(null) }
  }
  const startEdit = async (name: string) => {
    const raw = await window.desk.mcpGetServer(name)
    if (raw) setEdit({ name, form: mcpEntryToForm(name, raw) })
  }
  const toggle = (m: McpServerStatus) => act(m.key, m.state === 'disabled' ? 'Turn on' : 'Turn off', async () => {
    const raw: any = await window.desk.mcpGetServer(m.name)
    if (!raw) return
    const { disabled: _d, enabled: _e, ...rest } = raw
    setList(await window.desk.mcpSaveServer(m.name, m.state === 'disabled' ? rest : { ...rest, disabled: true }, m.name))
  })
  const remove = (m: McpServerStatus) => {
    if (!confirm(`Remove the MCP server "${m.name}"? Its sign-in is forgotten too.`)) return
    void act(m.key, 'Remove', async () => setList(await window.desk.mcpRemoveServer(m.name)))
  }
  const reload = async () => { setBusy('reload'); try { setList(await window.desk.mcpReload()) } finally { setBusy(null) } }

  return (
    <div className="form mcp">
      <p className="muted small">MCP servers give the agent extra tools, such as company data services. {BRAND.short} reads the same config files as GitHub Copilot CLI and VS Code: your personal file applies to every chat; a folder's <code>.vscode/mcp.json</code>, <code>.mcp.json</code> or <code>.github/mcp.json</code> applies to chats in that folder. Servers that need a company sign-in open your browser once; the sign-in is kept and renewed for you.</p>
      <label><Lbl text="Use MCP servers" tip="Connect to the MCP servers in your config files and offer their tools to the agent and sub-agents. Click Save to apply." ex="Off: the agent only has its built-in tools, even if mcp-config.json lists servers." />
        <select value={s.mcpEnabled ? 'on' : 'off'} onChange={(e) => setS({ ...s, mcpEnabled: e.target.value === 'on' })}>
          <option value="on">On — connect and offer their tools to the agent</option>
          <option value="off">Off</option>
        </select>
      </label>
      <div className="row-actions">
        <button className="primary" disabled={!!edit || !s.mcpEnabled} title={s.mcpEnabled ? undefined : 'Turn on "Use MCP servers" and Save first'} onClick={() => setEdit({ name: '', form: emptyMcpForm() })}>+ Add server</button>
        <button onClick={() => void reload()} disabled={busy === 'reload'} title={`Re-read ${files.map(tilde).join(' and ')} and the folders' mcp.json files`}>{busy === 'reload' ? <><span className="spinner" /> Reloading…</> : 'Reload config'}</button>
        <button className="link small" onClick={() => void act('', 'Open config', async () => { await window.desk.mcpOpenConfig() })} title={files[0]}>Edit Copilot CLI config…</button>
      </div>
      {edit && edit.name === '' && <McpServerEditor initial={edit.form} onCancel={() => setEdit(null)} onDone={() => setEdit(null)} />}

      <div className="sub-h">Servers{list?.length ? ` (${list.length})` : ''}</div>
      {!list ? <div className="xl-status"><span className="spinner" /> Loading…</div>
        : !list.length ? (
          <div className="muted small">
            {s.mcpEnabled ? <>No servers yet. Click <b>+ Add server</b>, or add them to <code>{tilde(files[0] ?? '')}</code> or a folder's <code>.vscode/mcp.json</code>.</> : 'MCP servers are turned off.'}
          </div>
        ) : list.map((m) => edit && edit.name === m.name && m.editable ? <McpServerEditor key={m.key} initial={edit.form} oldName={m.name} onCancel={() => setEdit(null)} onDone={() => setEdit(null)} /> : (() => {
          const [tone, label] = STATE[m.state]
          const signing = m.state === 'signing-in'
          return (
            <div key={m.key} className={`mcp-server${m.state === 'disabled' ? ' off' : ''}`}>
              <div className="mcp-head">
                <span className={`dot ${tone}`} />
                <b>{m.name}</b>
                <span className="muted small">{m.scope === 'user' ? 'personal' : `folder: ${base(m.scope)}`} · {m.type}</span>
                <div className="spacer" />
                {signing ? <><span className="spinner" /><button onClick={() => void window.desk.mcpCancelSignIn(m.key)}>Cancel</button></>
                  : m.state === 'disabled' ? null : <>
                    {m.oauth && m.state === 'needs-auth' && <button className="primary" disabled={!!busy} onClick={() => void act(m.key, 'Sign in', () => window.desk.mcpSignIn(m.key))}>Sign in</button>}
                    {m.state !== 'connecting' && <button disabled={!!busy} onClick={() => void act(m.key, 'Reconnect', () => window.desk.mcpReconnect(m.key))}>{busy === m.key + 'Reconnect' ? <><span className="spinner" /> Connecting…</> : 'Reconnect'}</button>}
                    {m.oauth && m.signedIn && <button disabled={!!busy} onClick={() => void act(m.key, 'Sign out', () => window.desk.mcpSignOut(m.key))}>Sign out</button>}
                  </>}
              </div>
              <div className="mcp-line small"><span>{label}</span>{m.state === 'connecting' && <span className="spinner" />}<span className="muted mcp-target" title={m.target}>{m.target}</span></div>
              {m.error && <div className="mcp-err small">{m.error}</div>}
              {signing && <div className="muted small">A browser window opened for sign-in. Finish there, then come back; this updates by itself.</div>}
              {m.tools.length > 0 && (
                <div className="small">
                  <button className="link" onClick={() => setOpen(open === m.key ? null : m.key)}>{open === m.key ? '▾' : '▸'} {m.tools.length} tool{m.tools.length === 1 ? '' : 's'}{m.cachedTools ? ' (from last connection)' : ''}</button>
                  {open === m.key && <ul className="mcp-tools">{m.tools.map((t) => <li key={t.name}><code>{t.name}</code> <span className="muted">{t.description.split('\n')[0].slice(0, 160)}</span></li>)}</ul>}
                </div>
              )}
              <div className="mcp-foot small">
                <span className="muted mcp-src" title={m.source}>from {tilde(m.source)}</span>
                <div className="spacer" />
                {m.editable ? <>
                  <button className="link" disabled={!!busy || !!edit || signing} onClick={() => void startEdit(m.name)}>Edit</button>
                  <button className="link" disabled={!!busy || signing} onClick={() => void toggle(m)}>{m.state === 'disabled' ? 'Turn on' : 'Turn off'}</button>
                  <button className="link danger" disabled={!!busy || signing} onClick={() => remove(m)}>Remove</button>
                </> : <button className="link" title="Servers from Copilot CLI or folder config files are edited in that file" onClick={() => void act(m.key, 'Open file', () => window.desk.mcpOpenFile(m.source))}>Open file</button>}
              </div>
            </div>
          )
        })())}

      <div className="sub-h">Network trust</div>
      <label><Lbl text="Extra trusted certificates (PEM file)" tip="Root or intermediate certificates to trust for HTTPS in addition to macOS's own, for servers signed by a company certificate authority. A certificate is accepted only if it chains to one in this file and matches the server's name. Click Save to apply." ex="~/certs/company-root.pem lets the app reach https://data.internal.example.com/mcp when macOS doesn't trust its certificate." />
        <input value={s.extraCaFile} placeholder="none — macOS trust only" onChange={(e) => setS({ ...s, extraCaFile: e.target.value })} />
      </label>
      <p className="muted small">Connections use your Mac's proxy settings, including automatic proxy (PAC) files, so servers reachable through the VPN or a proxy work the same as in your browser. Tool calls ask first in Interactive chats; a sub-agent only gets MCP tools its <code>tools</code> list allows (for example <code>my-server/*</code>).</p>
    </div>
  )
}
