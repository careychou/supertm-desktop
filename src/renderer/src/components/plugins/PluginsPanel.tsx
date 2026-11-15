import { useEffect, useMemo, useRef, useState } from 'react'
import type { PushEvent } from '../../../../shared/api'
import type { FolderConfig, MarketPlugin, MarketplaceRef, PluginsStatus } from '../../../../shared/plugins'
import { BRAND } from '../../../../shared/brand'

/** Browse a folder's marketplaces and install/remove plugins. */
export function PluginBrowser({ folder, onManage, onChanged }: { folder: string; onManage?(): void; onChanged?(): void }) {
  const [st, setSt] = useState<PluginsStatus | null>(null)
  const [list, setList] = useState<MarketPlugin[] | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [working, setWorking] = useState('')
  const [q, setQ] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [log, setLog] = useState<string[]>([])
  const logEl = useRef<HTMLPreElement>(null)

  const load = async (force = false) => {
    const r = await window.desk.plugins.list(folder, force)
    setList(r.plugins); setErrors(r.errors)
  }
  useEffect(() => {
    void window.desk.plugins.status(folder).then(setSt)
    void load()
    return window.desk.onPush((p: PushEvent) => {
      if (p.type === 'pluginsStatus' && p.status.folder === folder) setSt(p.status)
      if (p.type === 'pluginsLog' && p.folder === folder) setLog((l) => [...l.slice(-200), p.line])
    })
  }, [folder])
  useEffect(() => { logEl.current?.scrollTo(0, logEl.current.scrollHeight) }, [log])

  const act = async (p: MarketPlugin) => {
    setWorking(p.name); setMsg(null); setLog([])
    const r = p.installed ? await window.desk.plugins.uninstall(folder, p.name) : await window.desk.plugins.install(folder, p.name, p.marketplace)
    setWorking('')
    setMsg({ ok: r.ok, text: r.ok && !p.installed ? `${r.message} Start a new chat in this folder to use it.` : r.message })
    await load(); onChanged?.()
  }
  const updateAll = async () => {
    setWorking('*'); setMsg(null); setLog([])
    const r = await window.desk.plugins.updateAll(folder)
    setWorking(''); setMsg({ ok: r.ok, text: r.message }); await load(); onChanged?.()
  }

  const updates = new Set(st?.update?.plugins ?? [])
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    const l = (list ?? []).filter((p) => !s || `${p.name} ${p.description ?? ''}`.toLowerCase().includes(s))
    return [...l.filter((p) => p.installed || p.managed), ...l.filter((p) => !p.installed && !p.managed)]
  }, [list, q])
  const noSources = st && st.config.marketplaces.length === 0

  return (
    <div className="form">
      <div className="muted small">Plugins add skills and agents to this folder only (<code>.github/</code>), so they don’t affect your other folders.</div>
      {noSources ? (
        <div className="tm-card">
          <div><b>No marketplaces yet.</b></div>
          <div className="muted small">Add a plugin marketplace (a git repository with a <code>marketplace.json</code>) to browse its plugins.</div>
          {onManage && <div><button className="primary" onClick={onManage}>Add a marketplace…</button></div>}
        </div>
      ) : (
        <>
          {updates.size > 0 && <div className="tm-update">⬆ Updates available: {[...updates].join(', ')} <button disabled={!!working} onClick={() => void updateAll()}>Update all</button></div>}
          {errors.map((e) => <div key={e} className="err">{e}</div>)}
          {msg && <div className={msg.ok ? 'saved' : 'err'}>{msg.text}</div>}
          {working && log.length > 0 && <pre ref={logEl} className="tm-log">{log.join('\n')}</pre>}
          {list && list.length > 8 && <input className="pl-search" placeholder={`Search ${list.length} plugins…`} value={q} onChange={(e) => setQ(e.target.value)} />}
          {!list ? <div className="muted"><span className="spinner" /> Loading marketplace…</div> : (
            <div className="tm-plugins">
              {shown.length === 0 && <div className="tm-plugin muted">No plugins found.</div>}
              {shown.map((p) => (
                <div key={`${p.marketplace}/${p.name}`} className="tm-plugin">
                  <div className="tm-plugin-text">
                    <div><b>{p.name}</b> {p.version && <span className="muted small">v{p.version}</span>} <span className="muted small">· {p.marketplace}</span>
                      {p.installed && <span className="pl-tag">installed</span>}{updates.has(p.name) && <span className="pl-tag up">update</span>}</div>
                    {p.description && <div className="muted small pl-desc">{p.description}</div>}
                  </div>
                  {p.managed
                    ? <span className="muted small">{p.managed}</span>
                    : <button disabled={!!working || st?.busy} className={p.installed ? '' : 'primary'} onClick={() => void act(p)}>
                        {working === p.name ? <><span className="spinner" /> Working…</> : p.installed ? 'Remove' : 'Install'}</button>}
                </div>
              ))}
            </div>
          )}
        </>
      )}
      <div className="actions">
        {onManage && !noSources && <button onClick={onManage}>Marketplaces…</button>}
        {!noSources && <button disabled={!!working} onClick={() => { setList(null); void load(true) }}>Reload</button>}
      </div>
    </div>
  )
}

/** Edit the folder's marketplace list (saved in .github/<BRAND.folderConfig>). */
export function MarketplaceSources({ folder, onSaved }: { folder: string; onSaved?(): void }) {
  const [c, setC] = useState<FolderConfig | null>(null)
  const [saved, setSaved] = useState(false)
  useEffect(() => { void window.desk.plugins.status(folder).then((s) => setC(s.config)) }, [folder])
  if (!c) return <div className="muted"><span className="spinner" /></div>
  const edit = (m: MarketplaceRef[]) => { setSaved(false); setC({ ...c, marketplaces: m }) }
  const setMp = (i: number, k: keyof MarketplaceRef, v: string) => edit(c.marketplaces.map((m, j) => j === i ? { ...m, [k]: v } : m))
  const nameFor = (url: string) => url.replace(/\.git$/, '').split(/[/:]/).filter(Boolean).pop() ?? ''
  const save = async () => {
    const marketplaces = c.marketplaces.filter((m) => m.url.trim()).map((m) => ({ name: m.name.trim() || nameFor(m.url.trim()), url: m.url.trim(), ...(m.ref?.trim() ? { ref: m.ref.trim() } : {}) }))
    await window.desk.plugins.saveConfig(folder, { ...c, marketplaces })
    setC({ ...c, marketplaces }); setSaved(true); onSaved?.()
  }
  return (
    <div className="form">
      <div className="muted small">Git repositories with a plugin <code>marketplace.json</code>. Saved in this folder’s <code>.github/{BRAND.folderConfig}</code>.</div>
      {c.marketplaces.length === 0 && <div className="muted small">None yet. Example: <code>https://github.com/github/awesome-copilot</code> (branch <code>marketplace</code>).</div>}
      {c.marketplaces.map((m, i) => (
        <div key={i} className="tm-row">
          <input value={m.name} placeholder="name" onChange={(e) => setMp(i, 'name', e.target.value)} style={{ maxWidth: 170 }} aria-label="Marketplace name" />
          <input value={m.url} placeholder="git URL" onChange={(e) => setMp(i, 'url', e.target.value)} spellCheck={false} aria-label="Marketplace URL" />
          <input value={m.ref ?? ''} placeholder="branch" onChange={(e) => setMp(i, 'ref', e.target.value)} spellCheck={false} style={{ maxWidth: 110 }} aria-label="Branch" />
          <button className="link" onClick={() => edit(c.marketplaces.filter((_, j) => j !== i))}>Remove</button>
        </div>
      ))}
      <div><button className="link" onClick={() => edit([...c.marketplaces, { name: '', url: '' }])}>+ Add marketplace</button></div>
      <label className="tm-check"><input type="checkbox" checked={c.autoCheck} onChange={(e) => { setSaved(false); setC({ ...c, autoCheck: e.target.checked }) }} /> Check for plugin updates automatically</label>
      {saved && <div className="saved">Saved.</div>}
      <div className="actions"><button className="primary" onClick={() => void save()}>Save</button></div>
    </div>
  )
}
