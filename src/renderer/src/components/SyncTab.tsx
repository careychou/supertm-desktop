import { useEffect, useState } from 'react'
import { SessionTree, type TreeRow } from './SessionTree'
import { ageDiff, type ImportSource, type SyncCandidate, type SyncChoice, type SyncManifest } from '../../../shared/sync'
import { BRAND } from '../../../shared/brand'
import { useEscape } from '../hooks/useEscape'

const KEY = 'syncDir'
const when = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
const CHOICES: Array<[SyncChoice, string]> = [['skip', 'Skip'], ['overwrite', 'Overwrite local'], ['fork', 'Import as fork']]
const clean = (e: any) => String(e?.message ?? e).replace(/^Error invoking remote method '\w+': (Error: )?/, '')

const SOURCES: Array<{ kind: ImportSource; label: string; hint: string }> = [
  { kind: 'owned', label: BRAND.title, hint: `A folder you exported to from ${BRAND.title} on another Mac. Same-ID chats can be overwritten, forked or skipped.` },
  { kind: 'copilot', label: 'GitHub Copilot', hint: 'A Copilot session-state folder (holds session-store.db and session-state/), usually ~/.copilot. Every chat is added as new.' },
  { kind: 'claude', label: 'Claude Code', hint: 'Claude Code projects (~/.claude/projects, or one project folder in it). Every chat is added as new.' }
]

type Row = TreeRow

/** Export step 2: after the destination is chosen, pick the chats to write. */
function ExportDialog({ dir, onClose, onDone }: { dir: string; onClose(): void; onDone(msg: string): void }) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEscape(onClose)
  useEffect(() => {
    void window.desk.listSessions().then((l) => {
      const ui = l.sessions.map((s) => ({ id: s.id, title: s.title, cwd: s.cwd, updated_at: s.updated_at, turns: 0, parent_id: s.parent_id ?? null }))
      setRows(ui); setPicked(new Set(ui.map((r) => r.id)))
    })
  }, [])
  const go = async () => {
    setBusy(true); setErr('')
    try {
      const all = rows && picked.size === rows.length
      const m = await window.desk.syncExport(dir, all ? undefined : [...picked])
      onDone(`✓ Exported ${plural(m.sessions, 'session')} to ${dir}`)
    } catch (e) { setErr(`✗ ${clean(e)}`) } finally { setBusy(false) }
  }
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal sync-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>Export sessions</h3>
        <div className="muted small">To <b title={dir}>{dir}</b>. This replaces an earlier export in that folder. Every session is selected; uncheck the ones to leave out.</div>
        {rows ? <SessionTree rows={rows} picked={picked} setPicked={setPicked} /> : <div className="muted">Loading…</div>}
        <div className="row-actions modal-foot">
          <span className="muted small">{err}</span>
          <div className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || picked.size === 0} onClick={go}>{busy ? 'Exporting…' : `Export ${plural(picked.size, 'session')}`}</button>
        </div>
      </div>
    </div>
  )
}

interface Scan { kind: ImportSource; root: string; manifest: SyncManifest | null; sessions: SyncCandidate[] }

/** Settings → Sync sessions: export chats to a folder, and import chats from an export, GitHub Copilot or Claude Code. */
export function SyncTab() {
  const [msg, setMsg] = useState('')
  const [exportDir, setExportDir] = useState<string | null>(null)
  const [scan, setScan] = useState<Scan | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [choice, setChoice] = useState<Record<string, SyncChoice>>({})
  const [busy, setBusy] = useState('')

  const act = async (label: string, f: () => Promise<void>) => {
    setBusy(label); setMsg('')
    try { await f() } catch (e) { setMsg(`✗ ${clean(e)}`) } finally { setBusy('') }
  }
  const startExport = async () => {
    const d = await window.desk.pickFolder({ defaultPath: localStorage.getItem(KEY) ?? undefined, title: 'Export sessions to…', buttonLabel: 'Choose destination' })
    if (!d) return
    localStorage.setItem(KEY, d); setMsg(''); setExportDir(d)
  }
  const startImport = (kind: ImportSource) => act('Reading sessions…', async () => {
    const defaults = kind === 'owned' ? null : await window.desk.importDefaults()
    const last = localStorage.getItem(`${KEY}:${kind}`) ?? (kind === 'owned' ? localStorage.getItem(KEY) : defaults?.[kind])
    const label = SOURCES.find((s) => s.kind === kind)!.label
    const d = await window.desk.pickFolder({ defaultPath: last ?? undefined, title: `Import from ${label}`, buttonLabel: 'Read sessions' })
    if (!d) return
    localStorage.setItem(`${KEY}:${kind}`, d)
    setScan(null); setChoice({})
    if (kind === 'owned') {
      const r = await window.desk.syncScan(d)
      setScan({ kind, root: r.file, manifest: r.manifest, sessions: r.sessions })
      setPicked(new Set(r.sessions.filter((s) => !s.local).map((s) => s.id)))
      if (!r.sessions.length) setMsg('The export has no sessions.')
    } else {
      const r = await window.desk.importScan(kind, d)
      setScan({ kind, root: r.root, manifest: null, sessions: r.sessions })
      setPicked(new Set())
      if (!r.sessions.length) setMsg(`No ${label} sessions with turns in that folder.`)
    }
  })
  const doImport = () => act('Importing…', async () => {
    if (!scan) return
    let r
    if (scan.kind === 'owned') {
      const picks = scan.sessions.filter((s) => picked.has(s.id)).map((s) => ({ id: s.id, choice: s.local ? choice[s.id] ?? 'skip' : undefined }))
      const over = scan.sessions.filter((s) => s.local && picks.some((p) => p.id === s.id && p.choice === 'overwrite'))
      if (over.length && !window.confirm(`Overwrite ${over.length} chat${over.length > 1 ? 's' : ''} on this Mac?\n\n${over.map((s) => `• ${s.local!.title}: import is ${ageDiff(s.updated_at, s.local!.updated_at)}`).join('\n')}\n\nThe local cop${over.length > 1 ? 'ies are' : 'y is'} replaced and cannot be restored.`)) return
      r = await window.desk.syncImport(scan.root, picks)
      setScan({ ...scan, sessions: (await window.desk.syncScan(scan.root)).sessions })
    } else {
      r = await window.desk.importExternal(scan.kind, scan.root, [...picked])
    }
    const parts = [r.added && `${r.added} added`, r.overwritten && `${r.overwritten} overwritten`, r.forked && `${r.forked} imported as fork${r.forked === 1 ? '' : 's'}`, r.skipped && `${r.skipped} skipped`].filter(Boolean)
    setMsg(`✓ ${parts.join(', ') || 'Nothing imported'}`)
    setPicked(new Set())
  })

  const list = scan?.sessions ?? []
  const owned = scan?.kind === 'owned'
  const conflicts = owned ? list.filter((s) => s.local && picked.has(s.id)) : []
  const srcLabel = SOURCES.find((s) => s.kind === scan?.kind)?.label

  return (
    <div className="form sync">
      <div className="muted">Each chat has a unique ID, so the same chat is recognized on both Macs. Share exports through any folder (OneDrive, Google Drive, a USB drive).</div>

      <h4>Export</h4>
      <div className="row-actions">
        <button disabled={!!busy} onClick={startExport} title="Choose a destination folder, then the sessions to export">⇪ Export sessions…</button>
      </div>

      <h4>Import from</h4>
      <div className="sync-sources">
        {SOURCES.map((s) => (
          <button key={s.kind} disabled={!!busy} className={scan?.kind === s.kind ? 'on' : ''} onClick={() => startImport(s.kind)} title={s.hint}>
            <b>{s.label}</b><span className="muted small">{s.hint}</span>
          </button>
        ))}
      </div>
      {(busy || msg) && <div className="muted small">{busy || msg}</div>}

      {scan && list.length > 0 && <>
        <div className="muted small">
          <b>{srcLabel}</b>{' · '}
          {scan.manifest ? <>exported {when(scan.manifest.exportedAt)} from <b>{scan.manifest.host}</b> · </> : <span title={scan.root}>{scan.root} · </span>}
          {plural(list.length, 'session')}.{' '}
          {owned ? 'Chats already on this Mac are unchecked; check one to choose what to do with it.' : 'Each chat you pick is added as a new chat (its old ID is not used, so nothing conflicts).'}
        </div>
        <SessionTree
          rows={list} picked={picked} setPicked={setPicked} extraLabel={owned && list.some((x) => x.local) ? `${list.filter((x) => x.local).length} already on this Mac` : undefined}
          rowClass={(s) => (s.local ? 'conflict' : '')}
          extra={owned ? (s) => !s.local ? null : <>
            <div className="sync-warn">⚠ Same ID, local updated {when(s.local.updated_at)}: import is <b>{ageDiff(s.updated_at, s.local.updated_at)}</b></div>
            {picked.has(s.id) && (
              <select value={choice[s.id] ?? 'skip'} onChange={(e) => setChoice({ ...choice, [s.id]: e.target.value as SyncChoice })}>
                {CHOICES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            )}
          </> : undefined}
        />
        {conflicts.length > 0 && <div className="muted small"><b>Overwrite local</b> replaces this Mac's copy. <b>Import as fork</b> keeps it and adds the import, with a new ID, under it. <b>Skip</b> leaves it alone.</div>}
        {!owned && <div className="muted small">Imported chats keep the full transcript (messages, tool calls and results). The model continues from a text-only history, and the other tool's compaction summaries carry over.</div>}
        <div className="row-actions">
          <div className="spacer" />
          <button className="primary" disabled={!!busy || picked.size === 0} onClick={doImport}>Import {picked.size || ''} selected</button>
        </div>
      </>}

      {exportDir && <ExportDialog dir={exportDir} onClose={() => setExportDir(null)} onDone={(m) => { setExportDir(null); setMsg(m) }} />}
    </div>
  )
}
