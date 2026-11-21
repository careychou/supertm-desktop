import { useEffect, useMemo, useState } from 'react'
import { Dialog } from './Dialog'
import { Busy, ProgressBar } from './Progress'
import type { SessionRow } from '../../../shared/api'
import { exportMarkdown, splitTurns, type ExportItem } from '../../../shared/export'
import { BRAND } from '../../../shared/brand'
import { finalizeSkillMd, skillName, skillNameError } from '../../../shared/skill-export'
import type { SecretFinding, SkillDraft, SkillFileDraft, SkillFileOut } from '../../../shared/api'

/** A pack file in review: included or not, and its text once opened (null = binary/too big to edit). */
type PackFile = SkillFileDraft & { on: boolean; text?: string | null; edited?: boolean }
const ORIGIN: Record<SkillFileDraft['origin'], string> = { written: 'written by the chat', ran: 'run by the chat', inline: 'inline code the chat ran', added: 'added by you' }
const SKILL_TAB = '\u0000skill'
const kb = (n: number) => `${Math.max(1, Math.round(n / 1024))} KB`
const validTarget = (t: string) => /^(scripts|assets)\/[^/\\]+$/.test(t) && !/\/\.\.?$/.test(t)

interface Props {
  session: SessionRow
  onClose(): void
}

export function ShareModal({ session, onClose }: Props) {
  const [items, setItems] = useState<ExportItem[] | null>(null)
  const [all, setAll] = useState(true)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [tools, setTools] = useState(false)
  const [thinking, setThinking] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [kind, setKind] = useState<'md' | 'skill'>('md')
  const [name, setName] = useState(() => skillName(session.title))
  const [dest, setDest] = useState<'folder' | 'personal'>('folder')
  const [instruction, setInstruction] = useState('')
  const [draft, setDraft] = useState<SkillDraft | null>(null)
  const [md, setMd] = useState('')
  const [files, setFiles] = useState<PackFile[]>([])
  const [tab, setTab] = useState(SKILL_TAB)
  const [showAll, setShowAll] = useState(false)
  const [busy, setBusy] = useState<'' | 'generate' | 'save' | 'add'>('')
  const [err, setErr] = useState('')
  const [findings, setFindings] = useState<SecretFinding[] | null>(null)

  const nameErr = skillNameError(name)

  useEffect(() => { void window.desk.loadItems(session.id).then((x) => setItems(x as ExportItem[])) }, [session.id])
  const turns = useMemo(() => (items ? splitTurns(items) : []), [items])
  useEffect(() => { setPicked(new Set(turns.map((_, i) => i))) }, [turns])

  const selected = all ? turns.map((_, i) => i) : [...picked]
  const toMd = () => exportMarkdown(items ?? [], { title: session.title, cwd: session.cwd, model: session.model, turns: all ? undefined : selected, includeTools: tools, includeThinking: thinking })
  const toggle = (i: number) => setPicked((p) => { const n = new Set(p); n.has(i) ? n.delete(i) : n.add(i); return n })

  const save = async () => { const p = await window.desk.saveExport(session.title, toMd()); if (p) setSaved(p) }
  const copy = async () => { await window.desk.copyText(toMd()); setCopied(true); setTimeout(() => setCopied(false), 1500) }

  const makeDraft = async () => {
    setBusy('generate'); setErr(''); setSaved(null); setFindings(null)
    try {
      const d = await window.desk.draftSkill(session.id, { turns: all ? undefined : selected, name, instruction })
      setDraft(d); setMd(d.md); setFindings(d.findings); setTab(SKILL_TAB)
      setFiles(d.files.map((f) => ({ ...f, on: f.suggested, text: f.content })))
    } catch (e: any) { setErr(e.message ?? String(e)) } finally { setBusy('') }
  }
  const patch = (id: string, p: Partial<PackFile>) => setFiles((l) => l.map((f) => (f.id === id ? { ...f, ...p } : f)))
  const open = async (f: PackFile) => {
    setTab(f.id)
    if (f.text === undefined && f.source) { const t = await window.desk.readSkillFile(f.source); patch(f.id, { text: t }) }
  }
  const addFiles = async () => {
    setBusy('add'); setErr('')
    try {
      const add = await window.desk.addSkillFiles(session.cwd, files.map((f) => f.target))
      const fresh = add.filter((a) => !files.some((f) => f.id === a.id))
      setFiles((l) => [...l, ...fresh.map((f) => ({ ...f, on: f.exists }))])
      if (add.some((f) => !f.exists)) setErr('Some files are larger than 1 MB and were left out.')
    } finally { setBusy('') }
  }
  const chosen = files.filter((f) => f.on && f.exists)
  const out = (): SkillFileOut[] => chosen.map((f) => (f.edited || f.content !== undefined ? { target: f.target, content: f.text ?? f.content ?? '' } : { target: f.target, source: f.source }))
  const targetErr = chosen.find((f) => !validTarget(f.target)) ? 'File names must look like scripts/<name> or assets/<name>.'
    : chosen.find((f, i) => chosen.findIndex((g) => g.target === f.target) !== i) ? 'Two files have the same name.' : ''
  const saveSkill = async () => {
    setBusy('save'); setErr('')
    try {
      const body = finalizeSkillMd(md, name)
      const f = await window.desk.scanSkill(body, out())
      if (f.length && JSON.stringify(f) !== JSON.stringify(findings)) { setFindings(f); setErr('Possible secrets or personal data found (listed above). Remove them, or click Save again to save anyway.'); return }
      setSaved(await window.desk.saveSkill({ cwd: session.cwd, dest, name, md: body, files: out() }))
    } catch (e: any) { setErr(e.message ?? String(e)) } finally { setBusy('') }
  }
  const cur = files.find((f) => f.id === tab)
  const fileRow = (f: PackFile, label: string, bad = false) => (
    <div key={f.id} className={`skill-file d2${tab === f.id ? ' on' : ''}${f.on && f.exists ? '' : ' off'}${bad ? ' bad' : ''}`} title={`${f.source ?? f.target} · ${ORIGIN[f.origin]}`}>
      <input type="checkbox" disabled={!f.exists || !!busy} checked={f.on && f.exists} onChange={() => patch(f.id, { on: !f.on })} aria-label={`Include ${f.target}`} />
      <button disabled={!f.exists} onClick={() => void open(f)}><code>{label || '(no name)'}</code>{f.edited && ' ✎'}<span className="muted small"> {f.exists ? kb(f.size) : 'missing or > 1 MB'}</span></button>
    </div>
  )

  return (
    <Dialog id="share" className="share" title="Share session" onClose={onClose} closable={!busy}>
        <div className="seg">
          <button className={kind === 'md' ? 'on' : ''} onClick={() => setKind('md')} title="The conversation as a plain Markdown document">Export session as raw Markdown</button>
          <button className={kind === 'skill' ? 'on' : ''} onClick={() => setKind('skill')} title="A reusable skill: SKILL.md plus the scripts and files the chat used">Export to skill pack</button>
        </div>
        {kind === 'md'
          ? <p className="muted">Exports to a Markdown file. Anyone can read it, and any {BRAND.title} chat can attach it as <b>memory</b>.</p>
          : <p className="muted">Turns the selected turns into a reusable <b>skill</b>: instructions in <code>SKILL.md</code> plus the scripts and files the chat wrote or ran. Agents load it when a task matches.</p>}
        <div className="seg">
          <button className={all ? 'on' : ''} onClick={() => setAll(true)}>All turns ({turns.length})</button>
          <button className={!all ? 'on' : ''} onClick={() => setAll(false)}>Select turns</button>
        </div>
        {!all && (
          <div className="turn-pick">
            <div className="turn-pick-bar">
              <button onClick={() => setPicked(new Set(turns.map((_, i) => i)))}>Select all</button>
              <button onClick={() => setPicked(new Set())}>Clear</button>
              <span className="muted">{picked.size} selected</span>
            </div>
            {turns.map((t, i) => (
              <label key={i} className="turn-row">
                <input type="checkbox" checked={picked.has(i)} onChange={() => toggle(i)} />
                <span className="turn-no">{i + 1}</span>
                <span className="turn-text">{(t[0] as { text: string }).text.replace(/\s+/g, ' ')}</span>
              </label>
            ))}
          </div>
        )}
        {kind === 'md' ? <>
        <div className="opts">
          <label><input type="checkbox" checked={tools} onChange={(e) => setTools(e.target.checked)} /> Include tool calls &amp; outputs</label>
          <label><input type="checkbox" checked={thinking} onChange={(e) => setThinking(e.target.checked)} /> Include model thinking</label>
        </div>
        {saved && <div className="saved">Saved <code>{saved}</code> <button className="link" onClick={() => window.desk.revealFile(saved)}>Show in Finder</button></div>}
        <div className="actions">
          <button onClick={onClose}>Close</button>
          <button onClick={copy} disabled={!items || !selected.length}>{copied ? 'Copied ✓' : 'Copy Markdown'}</button>
          <button className="primary" onClick={save} disabled={!items || !selected.length}>Save .md…</button>
        </div>
        </> : <>
        <div className="skill-form">
          <label>Skill name
            <input value={name} placeholder="e.g. carey-weekly-sales-report" onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, '-'))} onBlur={() => setName(skillName(name))} disabled={!!busy} />
          </label>
          {name && nameErr && <div className="error">{nameErr}</div>}
          <div className="muted small">Tip: start it with your name (e.g. <code>carey-</code>) to keep your skills apart from shared ones.</div>
          <label>Skill instructions <span className="muted small">(optional)</span>
            <textarea rows={3} value={instruction} disabled={!!busy} onChange={(e) => setInstruction(e.target.value)}
              placeholder={'How should the turns be codified? e.g. "Focus on the weekly sales pull only, skip the charting. Make store number and week inputs. Turn the SQL into scripts/query.sql."'} />
          </label>
          <div className="opts">
            <label><input type="radio" checked={dest === 'folder'} onChange={() => setDest('folder')} /> This folder: <code>.github/skills/{name || '…'}</code></label>
            <label><input type="radio" checked={dest === 'personal'} onChange={() => setDest('personal')} /> All my folders: <code>~/.copilot/skills/{name || '…'}</code></label>
          </div>
        </div>
        {busy === 'generate' && <ProgressBar label={`Generating skill from ${selected.length} turn${selected.length === 1 ? '' : 's'}…`} hint="The memory-compaction model is writing SKILL.md and finding the scripts and files to bundle. This can take a minute." />}
        {draft && <>
          <div className="skill-review-head"><b>Review &amp; edit the skill pack</b> <span className="muted small">Ticked files go in the pack; scratch files (temp folders, inline snippets) start unticked. Click a file to view or edit it, rename it, or add more, then Save. Drafted by {draft.model}.</span></div>
          <div className="skill-pack">
            <div className="skill-tree" role="tree">
              <div className="tree-dir root" title={`${dest === 'folder' ? '.github/skills' : '~/.copilot/skills'}/${name}`}>📁 <b>{name || 'skill'}/</b></div>
              <div className={`skill-file d1${tab === SKILL_TAB ? ' on' : ''}`} title="Always included">
                <span className="tree-icon" aria-hidden>📄</span>
                <button onClick={() => setTab(SKILL_TAB)}><code>SKILL.md</code>{md !== draft?.md && ' ✎'}</button>
              </div>
              {(['scripts', 'assets'] as const).map((dir) => {
                const inDir = files.filter((f) => f.target.split('/')[0] === dir && (showAll || f.on || f.id === tab))
                return inDir.length > 0 && <div key={dir} role="group">
                  <div className="tree-dir d1">📁 {dir}/ <span className="muted small">{inDir.filter((f) => f.on && f.exists).length} included</span></div>
                  {inDir.map((f) => fileRow(f, f.target.slice(dir.length + 1)))}
                </div>
              })}
              {files.filter((f) => !/^(scripts|assets)\//.test(f.target)).map((f) => fileRow(f, f.target, true))}
              {files.some((f) => !f.on) && <button className="link" onClick={() => setShowAll(!showAll)}>{showAll ? 'Hide unticked files' : `Show ${files.filter((f) => !f.on).length} more from the chat (temp files, inline code)…`}</button>}
              <button className="link" disabled={!!busy} onClick={() => void addFiles()}>{busy === 'add' ? <Busy text="Adding…" /> : '+ Add files…'}</button>
            </div>
            <div className="skill-editor">
              {tab === SKILL_TAB || !cur
                ? <textarea className="skill-md" value={md} onChange={(e) => setMd(e.target.value)} spellCheck={false} disabled={!!busy} />
                : <>
                  <div className="skill-file-bar">
                    <input value={cur.target} disabled={!!busy} onChange={(e) => patch(cur.id, { target: e.target.value.replace(/\s+/g, '-') })} aria-label="File name in the skill" />
                    <span className="muted small">{ORIGIN[cur.origin]}{cur.source && <> · from <span title={cur.source}>{cur.source.split('/').slice(-2).join('/')}</span></>}</span>
                  </div>
                  {cur.text === undefined ? <div className="working"><span className="spinner" /> Opening…</div>
                    : cur.text === null ? <div className="muted small">Binary or large file: it is copied as is and can't be edited here.</div>
                    : <textarea className="skill-md" value={cur.text} onChange={(e) => patch(cur.id, { text: e.target.value, edited: true })} spellCheck={false} disabled={!!busy} />}
                </>}
            </div>
          </div>
          <div className="muted small">Saves <code>SKILL.md</code>{chosen.length ? ` + ${chosen.length} file${chosen.length === 1 ? '' : 's'}` : ''}. Edits here change only the skill's copy, not the original files.</div>
          {targetErr && <div className="error">{targetErr}</div>}
          {!!findings?.length && <div className="warn">⚠ Possible secrets or personal data: {findings.map((f) => `${f.kind} (${f.sample})`).join(', ')}. Edit them out before saving.</div>}
        </>}
        {busy === 'save' && <ProgressBar label="Checking for secrets and saving the skill…" />}
        {err && <div className="error">{err}</div>}
        {saved && <div className="saved">Saved skill <code>{saved}</code> <button className="link" onClick={() => window.desk.revealFile(saved + '/SKILL.md')}>Show in Finder</button><br /><span className="muted small">New chats in {dest === 'folder' ? 'this folder' : 'any folder'} can use it.</span></div>}
        <div className="actions">
          <button onClick={onClose}>Close</button>
          {draft && <button onClick={makeDraft} disabled={!!busy || !items || !selected.length || !!nameErr}>{busy === 'generate' ? <Busy text="Regenerating…" /> : 'Regenerate'}</button>}
          {draft
            ? <button className="primary" onClick={saveSkill} disabled={!!busy || !md.trim() || !!saved || !!nameErr || !!targetErr}>{busy === 'save' ? <Busy text="Saving…" /> : 'Save skill'}</button>
            : <button className="primary" onClick={makeDraft} disabled={!!busy || !items || !selected.length || !!nameErr}>{busy === 'generate' ? <Busy text="Generating…" /> : 'Generate & review'}</button>}
        </div>
        </>}
    </Dialog>
  )
}
