import { useState } from 'react'
import { ageDiff, type SyncCandidate, type SyncChoice, type SyncManifest } from '../../../shared/sync'

const KEY = 'syncDir'
const when = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p
const CHOICES: Array<[SyncChoice, string]> = [['skip', 'Skip'], ['overwrite', 'Overwrite local'], ['fork', 'Import as fork']]

/** Settings → Sync sessions: export the whole session database to a folder, and import chosen sessions from one. */
export function SyncTab() {
  const [dir, setDir] = useState(() => localStorage.getItem(KEY) ?? '')
  const [msg, setMsg] = useState('')
  const [scan, setScan] = useState<{ file: string; manifest: SyncManifest | null; sessions: SyncCandidate[] } | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [choice, setChoice] = useState<Record<string, SyncChoice>>({})
  const [busy, setBusy] = useState(false)

  const pick = async () => {
    const d = await window.desk.pickFolder()
    if (d) { setDir(d); localStorage.setItem(KEY, d); setScan(null); setMsg('') }
    return d
  }
  const act = async (f: () => Promise<void>) => {
    setBusy(true); setMsg('')
    try { await f() } catch (e: any) { setMsg(`✗ ${String(e?.message ?? e).replace(/^Error invoking remote method '\w+': (Error: )?/, '')}`) } finally { setBusy(false) }
  }
  const doExport = () => act(async () => {
    const d = dir || await pick()
    if (!d) return
    const m = await window.desk.syncExport(d)
    setMsg(`✓ Exported ${m.sessions} session${m.sessions === 1 ? '' : 's'} to ${d}`)
  })
  const doScan = () => act(async () => {
    const d = dir || await pick()
    if (!d) return
    const r = await window.desk.syncScan(d)
    setScan(r); setChoice({})
    setPicked(new Set(r.sessions.filter((s) => !s.local).map((s) => s.id)))
    if (!r.sessions.length) setMsg('The export has no sessions.')
  })
  const doImport = () => act(async () => {
    if (!scan) return
    const picks = scan.sessions.filter((s) => picked.has(s.id)).map((s) => ({ id: s.id, choice: s.local ? choice[s.id] ?? 'skip' : undefined }))
    const over = scan.sessions.filter((s) => s.local && picks.some((p) => p.id === s.id && p.choice === 'overwrite'))
    if (over.length && !window.confirm(`Overwrite ${over.length} chat${over.length > 1 ? 's' : ''} on this Mac?\n\n${over.map((s) => `• ${s.local!.title}: import is ${ageDiff(s.updated_at, s.local!.updated_at)}`).join('\n')}\n\nThe local cop${over.length > 1 ? 'ies are' : 'y is'} replaced and cannot be restored.`)) return
    const r = await window.desk.syncImport(scan.file, picks)
    const parts = [r.added && `${r.added} added`, r.overwritten && `${r.overwritten} overwritten`, r.forked && `${r.forked} imported as fork${r.forked === 1 ? '' : 's'}`, r.skipped && `${r.skipped} skipped`].filter(Boolean)
    setMsg(`✓ ${parts.join(', ') || 'Nothing imported'}`)
    setScan({ ...scan, sessions: (await window.desk.syncScan(scan.file)).sessions })
    setPicked(new Set())
  })

  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const list = scan?.sessions ?? []
  const all = list.length > 0 && list.every((s) => picked.has(s.id))
  const conflicts = list.filter((s) => s.local && picked.has(s.id))

  return (
    <div className="form sync">
      <div className="muted">Move chats between Macs through a shared folder (OneDrive, Google Drive, a USB drive). Each chat is keyed by a unique ID, so the same chat is recognized on both sides.</div>
      <label>Sync folder
        <div className="row-actions">
          <input value={dir} placeholder="Choose a folder…" onChange={(e) => { setDir(e.target.value); localStorage.setItem(KEY, e.target.value); setScan(null) }} />
          <button onClick={pick}>Choose…</button>
        </div>
      </label>
      <div className="row-actions">
        <button disabled={busy} onClick={doExport} title="Writes the session database (every chat) and a small manifest into the folder, replacing an earlier export">⇪ Export all sessions</button>
        <button disabled={busy} onClick={doScan} title="Lists the chats in the folder's export so you can pick which to import">⇩ Import from folder…</button>
        <span className="muted small">{msg}</span>
      </div>

      {scan && list.length > 0 && <>
        <div className="muted small">
          {scan.manifest ? <>Exported {when(scan.manifest.exportedAt)} from <b>{scan.manifest.host}</b> · </> : null}{list.length} sessions. Chats already on this Mac are unchecked; check one to choose what to do with it.
        </div>
        <table className="sync-table">
          <thead><tr>
            <th><input type="checkbox" checked={all} onChange={() => setPicked(all ? new Set() : new Set(list.map((s) => s.id)))} /></th>
            <th>Session</th><th>Last updated</th><th>On this Mac</th>
          </tr></thead>
          <tbody>
            {list.map((s) => (
              <tr key={s.id} className={s.local ? 'conflict' : ''}>
                <td><input type="checkbox" checked={picked.has(s.id)} onChange={() => toggle(s.id)} /></td>
                <td><div className="sync-title">{s.title}</div><div className="muted small" title={`${s.cwd}\n${s.id}`}>📂 {base(s.cwd)} · {s.turns} turn{s.turns === 1 ? '' : 's'}{s.parent_id ? ' · fork' : ''}</div></td>
                <td className="small">{when(s.updated_at)}</td>
                <td className="small">
                  {!s.local ? <span className="muted">New</span> : <>
                    <div className="sync-warn">⚠ Same ID, local updated {when(s.local.updated_at)}: import is <b>{ageDiff(s.updated_at, s.local.updated_at)}</b></div>
                    {picked.has(s.id) && (
                      <select value={choice[s.id] ?? 'skip'} onChange={(e) => setChoice({ ...choice, [s.id]: e.target.value as SyncChoice })}>
                        {CHOICES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                      </select>
                    )}
                  </>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {conflicts.length > 0 && <div className="muted small"><b>Overwrite local</b> replaces this Mac's copy. <b>Import as fork</b> keeps it and adds the import, with a new ID, under it. <b>Skip</b> leaves it alone.</div>}
        <div className="row-actions">
          <div className="spacer" />
          <button className="primary" disabled={busy || picked.size === 0} onClick={doImport}>Import {picked.size || ''} selected</button>
        </div>
      </>}
    </div>
  )
}
