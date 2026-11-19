import { useEffect, useRef, useState } from 'react'
import { hasMemory, type Memory } from '../../../shared/memory'
import type { AttachInput, ExcelStatus, ModelGroup, PreparedAttachment } from '../../../shared/api'
import { OFFICE_NAME, officeWhere, type OfficeApp, type OfficeStatus } from '../../../shared/office'
import { BRAND } from '../../../shared/brand'
import { useEscape } from '../hooks/useEscape'
import { bareModel, isTtsId, TTS_VOICES } from '../../../shared/providers'

type Chip = PreparedAttachment & { pending?: boolean }

interface Props {
  busy: boolean
  /** Text to put back in the box (e.g. queued prompts dropped by Stop); `n` changes on every restore. */
  restore?: { text: string; n: number }
  model: string
  models: string[]
  /** Models per provider; shown as option groups when more than one provider is configured. */
  groups?: ModelGroup[]
  cwd: string
  onModel(m: string): void
  onPickFolder?: () => void
  onSend(text: string, attachments: PreparedAttachment[]): void
  onStop(): void
  autoFocus?: boolean
  effort: Effort
  onEffort(e: Effort): void
  mode: Mode
  onMode(m: Mode): void
  memory: Memory
  folderMemory: Memory
  onEditMemory(kind: 'session' | 'folder'): void
  onShare?: () => void
  tokens?: number
  onCompact?: () => void
}

export type Mode = 'interactive' | 'autopilot'
export type Effort = 'off' | 'low' | 'medium' | 'high'
const EFFORTS: Array<[Effort, string]> = [['off', 'Thinking off'], ['low', 'Low effort'], ['medium', 'Medium effort'], ['high', 'High effort']]
const TTS_EXAMPLES: Array<[string, string, string]> = [
  ['Style', 'Say cheerfully: ', 'Steer tone, pace or accent in plain words'],
  ['Voice', 'voice: Puck — ', 'Pick the voice for this message'],
  ['Dialogue', 'voices: Carey=Puck, Pearl=Kore\nCarey: \nPearl: ', 'Two speakers: one Name: line each']
]
const fileName = (p: string) => p.split('/').pop() ?? p
const memLabel = (m: Memory) => [m.notes.trim() && 'Notes', m.files.length === 1 ? fileName(m.files[0]) : m.files.length > 1 && `${m.files.length} files`].filter(Boolean).join(' · ')
const memSummary = (m: Memory) => [m.notes.trim() && `Notes: ${m.notes.trim().slice(0, 120)}${m.notes.trim().length > 120 ? '…' : ''}`, ...m.files.map((f) => `📄 ${fileName(f)}`)].filter(Boolean).join('\n')

const short = (m: string) => bareModel(m).split('/').pop() ?? m
const folderName = (p: string) => p.split('/').filter(Boolean).pop() ?? p

export function Composer(p: Props) {
  const [text, setText] = useState('')
  const tts = isTtsId(bareModel(p.model))
  const ta = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { if (p.autoFocus) ta.current?.focus() }, [p.autoFocus])
  useEffect(() => {
    const el = ta.current
    if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 260) + 'px' }
  }, [text])

  useEffect(() => {
    if (p.restore?.n && p.restore.text) setText((t) => (t.trim() ? `${p.restore!.text}\n\n${t}` : p.restore!.text))
  }, [p.restore?.n])

  const [atts, setAtts] = useState<Chip[]>([])
  const [dragging, setDragging] = useState(false)
  const ready = atts.filter((a) => a.att && !a.pending)
  const preparing = atts.some((a) => a.pending)

  const add = async (inputs: AttachInput[], names: string[]) => {
    if (!inputs.length) return
    const temp: Chip[] = names.map((name) => ({ id: `tmp-${Math.random()}`, meta: { name, kind: 'doc', info: 'Preparing…' }, pending: true }))
    setAtts((a) => [...a, ...temp])
    const done = await window.desk.prepareAttachments(inputs)
    setAtts((a) => [...a.filter((x) => !temp.includes(x)), ...done])
    ta.current?.focus()
  }
  const addFiles = async (files: File[]) => {
    const inputs: AttachInput[] = [], names: string[] = []
    for (const f of files) {
      const fp = window.desk.pathForFile(f)
      const name = fp ? fp.split('/').pop()! : f.name && f.name !== 'image.png' ? f.name : `pasted-${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`
      inputs.push(fp ? { path: fp } : { name, data: new Uint8Array(await f.arrayBuffer()) })
      names.push(name)
    }
    await add(inputs, names)
  }
  const pick = async () => { const r = await window.desk.pickAttachments(); if (r.length) setAtts((a) => [...a, ...r]) }

  // Excel, Word, PowerPoint: the paperclip opens a menu that also lists what is open in each app
  const [xl, setXl] = useState<ExcelStatus | null>(null)
  const [off, setOff] = useState<OfficeStatus | null>(null)
  const [xlMenu, setXlMenu] = useState(false)
  const [xlLoading, setXlLoading] = useState(false)
  const [offLoading, setOffLoading] = useState(false)
  const xlOn = !!xl?.enabled && xl.installed
  const offApps = (['word', 'powerpoint'] as OfficeApp[]).filter((a) => off?.[a].enabled && off[a].installed)
  useEffect(() => {
    void window.desk.excel.status(false).then(setXl).catch(() => setXl(null))
    void window.desk.office.status(false).then(setOff).catch(() => setOff(null))
  }, [])
  useEscape(() => setXlMenu(false), xlMenu)
  const openClip = async () => {
    const [st, os] = await Promise.all([window.desk.excel.status(false).catch(() => null), window.desk.office.status(false).catch(() => null)])
    setXl(st); setOff(os)
    const hasXl = !!st?.enabled && st.installed, hasOff = !!os && (['word', 'powerpoint'] as OfficeApp[]).some((a) => os[a].enabled && os[a].installed)
    if (!hasXl && !hasOff) return pick()
    setXlMenu(true)
    // the apps are asked separately so a slow one does not hold up the others
    if (hasXl && st!.running) {
      setXlLoading(true)
      void window.desk.excel.status(true).catch(() => st).then((r) => { setXl(r); setXlLoading(false) })
    }
    if (hasOff && (os!.word.running || os!.powerpoint.running)) {
      setOffLoading(true)
      void window.desk.office.status(true).catch(() => os).then((r) => { setOff(r); setOffLoading(false) })
    }
  }
  const useWorkbook = async (name: string) => {
    setXlMenu(false)
    const r = await window.desk.excel.attach(name)
    setAtts((a) => [...a.filter((x) => !(x.meta.excel === 'live' && x.meta.name === name)), r])
    ta.current?.focus()
  }
  const useDocument = async (app: OfficeApp, name: string) => {
    setXlMenu(false)
    const r = await window.desk.office.attach(app, name)
    setAtts((a) => [...a.filter((x) => !(x.meta.office === app && x.meta.name === name)), r])
    ta.current?.focus()
  }

  // files can be dropped anywhere in the window, not just on the box
  useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files')
    const over = (e: DragEvent) => { if (hasFiles(e)) { e.preventDefault(); setDragging(true) } }
    const leave = (e: DragEvent) => { if (!e.relatedTarget) setDragging(false) }
    const drop = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); setDragging(false); void addFiles([...e.dataTransfer!.files]) }
    window.addEventListener('dragover', over); window.addEventListener('dragleave', leave); window.addEventListener('drop', drop)
    return () => { window.removeEventListener('dragover', over); window.removeEventListener('dragleave', leave); window.removeEventListener('drop', drop) }
  })

  const sending = useRef(false)
  const submit = async () => {
    if ((!text.trim() && !ready.length) || preparing || sending.current) return
    sending.current = true
    try {
      // a live workbook, document or presentation chip follows the selection: look it up again at the moment of sending
      const fresh = await Promise.all(ready.map(async (a) => {
        if (a.meta.excel !== 'live' && !a.meta.office) return a
        const r = await (a.meta.office ? window.desk.office.attach(a.meta.office, a.meta.name) : window.desk.excel.attach(a.meta.name)).catch(() => null)
        return r?.att ? r : a
      }))
      p.onSend(text.trim(), fresh)
      setText(''); setAtts([])
    } finally { sending.current = false }
  }

  return (
    <div className="composer-wrap">
      {xlMenu && (
        <>
          <div className="menu-back" onClick={() => setXlMenu(false)} />
          <div className="xl-menu" role="menu">
            <button onClick={() => { setXlMenu(false); void pick() }}>📎 Attach files…</button>
            <div className="menu-sep" />
            {xlOn && <><div className="xl-menu-h"><span className="xl-dot">X</span> Use a workbook open in Excel</div>
            {!xl?.running ? <div className="xl-menu-note">Excel isn't running. Open a workbook in Excel, then come back here.</div>
              : xlLoading ? <div className="xl-menu-note">Asking Excel…</div>
              : xl.permission === 'needed' ? <div className="xl-menu-note">macOS hasn't allowed {BRAND.title} to control Excel yet. Turn it on in System Settings → Privacy &amp; Security → Automation, then try again.</div>
              : xl.error ? <div className="xl-menu-note">{xl.error}</div>
              : !xl.workbooks.length ? <div className="xl-menu-note">No workbook is open in Excel.</div>
              : xl.workbooks.map((w) => (
                <button key={w.name} className="xl-wb" onClick={() => void useWorkbook(w.name)} title={w.path || 'Not saved yet'}>
                  <span className="xl-wb-name">{w.name}</span>
                  <span className="muted">{w.activeSheet ? `${w.activeSheet}${w.selection ? ` · ${w.selection} selected` : ''}` : `${w.sheets.length} sheet${w.sheets.length === 1 ? '' : 's'}`}</span>
                </button>))}</>}
            {offApps.map((app, k) => {
              const a = off![app], name = OFFICE_NAME[app], unit = app === 'word' ? 'document' : 'presentation'
              return (
                <div key={app}>
                  {(xlOn || k > 0) && <div className="menu-sep" />}
                  <div className="xl-menu-h"><span className={`xl-dot ${app}`}>{app === 'word' ? 'W' : 'P'}</span> Use a {unit} open in {name}</div>
                  {!a.running ? <div className="xl-menu-note">{name} isn't running. Open a {unit} in {name}, then come back here.</div>
                    : offLoading ? <div className="xl-menu-note">Asking {name}…</div>
                    : a.permission === 'needed' ? <div className="xl-menu-note">macOS hasn't allowed {BRAND.title} to control {name} yet. Turn it on in System Settings → Privacy &amp; Security → Automation, then try again.</div>
                    : a.error ? <div className="xl-menu-note">{a.error}</div>
                    : !a.docs.length ? <div className="xl-menu-note">No {unit} is open in {name}.</div>
                    : a.docs.map((d) => (
                      <button key={d.name} className="xl-wb" onClick={() => void useDocument(app, d.name)} title={d.path || 'Not saved yet'}>
                        <span className="xl-wb-name">{d.name}</span>
                        <span className="muted">{officeWhere(app, d)}</span>
                      </button>))}
                </div>)
            })}
          </div>
        </>
      )}
      {dragging && <div className="drop-hint">Drop files to attach: images, PDF, Office, text or code</div>}
      <div className={`composer${dragging ? ' dragging' : ''}`}>
        {atts.length > 0 && (
          <div className="att-row">
            {atts.map((a) => (
              <div key={a.id} className={`att-chip${a.error ? ' err' : ''}${a.pending ? ' pending' : ''}${a.meta.excel ? ` xl ${a.meta.excel}` : ''}${a.meta.office ? ` xl live ${a.meta.office}` : ''}`} title={a.error ?? `${a.meta.name}\n${a.meta.info}${a.meta.office ? `\nOpen in ${OFFICE_NAME[a.meta.office]}: ${BRAND.title} reads and edits it in place.` : a.meta.excel === 'live' ? `\nOpen in Excel: ${BRAND.title} reads and edits it in place.` : a.meta.excel === 'file' ? `\nA file on disk: ${BRAND.title} can read more of it or edit it.` : ''}`}>
                {a.meta.thumb ? <img src={a.meta.thumb} alt="" /> : <span className="att-ico">{a.pending ? '⋯' : a.error ? '⚠' : a.meta.excel ? 'X' : a.meta.office === 'word' ? 'W' : a.meta.office ? 'P' : '📄'}</span>}
                <span className="att-text"><span className="att-name">{a.meta.name}{a.meta.excel && !a.error && <span className={`xl-badge ${a.meta.excel}`}>{a.meta.excel === 'live' ? 'Live' : 'File'}</span>}{a.meta.office && !a.error && <span className={`xl-badge live ${a.meta.office}`}>Live</span>}</span><span className="att-info">{a.error ?? a.meta.info}{(a.meta.excel === 'live' || a.meta.office) && !a.error ? ' · follows your selection' : ''}</span></span>
                {!a.pending && <button onClick={() => setAtts(atts.filter((x) => x !== a))} title="Remove">×</button>}
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={ta}
          rows={1}
          placeholder={p.busy ? 'Queue a follow-up: it joins at the agent\'s next step (Enter)' : tts ? 'Type text to read aloud…' : 'Ask anything, or describe a task…'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const f = [...e.clipboardData.files]
            // Office apps put a rendered picture next to copied text; keep that a text paste
            if (!f.length || (e.clipboardData.getData('text/plain').trim() && !f.some((x) => window.desk.pathForFile(x)))) return
            e.preventDefault(); void addFiles(f)
          }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit() } }}
        />
        {tts && (
          <div className="tts-hint" title={`Voices: ${TTS_VOICES.join(', ')}`}>
            <span>🔊 Reads your text aloud.</span>
            {TTS_EXAMPLES.map(([label, tpl, tip]) => (
              <button key={label} title={`${tip}. Click to insert:\n${tpl}`} onClick={() => { setText(text.trim() ? `${tpl}${text}` : tpl); ta.current?.focus() }}>
                {label}: <code>{tpl.split('\n')[0].trim()} …</code>
              </button>
            ))}
            <span className="muted">Voices: {TTS_VOICES.slice(0, 6).join(', ')}…</span>
          </div>
        )}
        <div className="composer-bar">
          <button className="clip" onClick={() => void openClip()} title={`Attach files (or paste / drop them). Images are downscaled and documents trimmed to save tokens.${xlOn || offApps.length ? ` Also lists what is open in ${[xlOn && 'Excel', ...offApps.map((a) => OFFICE_NAME[a])].filter(Boolean).join(', ')}.` : ''}`}>📎</button>
          <select className="model-pick" value={p.model} onChange={(e) => p.onModel(e.target.value)} title={p.model}>
            {!p.models.includes(p.model) && <option value={p.model}>{short(p.model)}</option>}
            {(p.groups?.length ?? 0) > 1
              ? p.groups!.filter((g) => g.models.length).map((g) => <optgroup key={g.provider} label={g.name}>{g.models.map((m) => <option key={m} value={m}>{short(m)}</option>)}</optgroup>)
              : p.models.map((m) => <option key={m} value={m}>{short(m)}</option>)}
          </select>
          <div className="spacer" />
          {p.busy && <button className="send stop" onClick={p.onStop} title="Stop (queued prompts go back in the box)">■</button>}
          {(!p.busy || text.trim() || ready.length > 0) && (
            <button className="send" onClick={() => void submit()} disabled={(!text.trim() && !ready.length) || preparing}
              title={preparing ? 'Preparing attachments…' : p.busy ? 'Queue: joins the conversation at the next step' : 'Send'}>↑</button>
          )}
        </div>
      </div>
      <div className="folder">
        <button className="fbtn" onClick={p.onPickFolder} disabled={!p.onPickFolder} title={p.cwd}>
          <span>🗀</span> {folderName(p.cwd)}
        </button>
        <select className={`effort-pick run-mode ${p.mode}`} value={p.mode} onChange={(e) => p.onMode(e.target.value as Mode)} title="Interactive asks before running shell commands, writing files or fetching URLs. Autopilot approves them automatically.">
          <option value="interactive">✋ Interactive</option>
          <option value="autopilot">🚀 Autopilot</option>
        </select>
        <select className="effort-pick" value={p.effort} onChange={(e) => p.onEffort(e.target.value as Effort)} title="Reasoning effort / model thinking for this chat">
          {EFFORTS.map(([v, l]) => <option key={v} value={v}>💭 {l}</option>)}
        </select>
        {hasMemory(p.folderMemory) && (
          <button className="mem-chip fmem clickable" onClick={() => p.onEditMemory('folder')} title={`Folder memory for ${folderName(p.cwd)}: shared by every chat in this folder. Click to edit.\n${memSummary(p.folderMemory)}`}>🗂 Folder memory</button>
        )}
        {hasMemory(p.memory)
          ? <button className="mem-chip clickable" onClick={() => p.onEditMemory('session')} title={`Session memory: only this chat. Click to edit.\n${memSummary(p.memory)}`}>🧠 {memLabel(p.memory)}</button>
          : <button className="fbtn" onClick={() => p.onEditMemory('session')} title="Add notes or files (e.g. shared chat exports) as memory for this chat">＋ Memory</button>}
        <div className="spacer" />
        {p.onCompact && <button className="fbtn" onClick={p.onCompact} title="Context size (estimated). Click to compact history: choose which turns to summarize.">⇲ {p.tokens ? `${Math.round(p.tokens / 1000)}k` : ''} Compact</button>}
        {p.onShare && <button className="fbtn" onClick={p.onShare} title="Export this chat to Markdown">⇪ Share</button>}
      </div>
    </div>
  )
}
