import { useState } from 'react'
import { Dialog } from './Dialog'
import type { Memory } from '../../../shared/memory'

interface Props {
  kind: 'session' | 'folder'
  /** Chat title or folder path, for the heading. */
  target: string
  memory: Memory
  onSave(m: Memory): void
  onClose(): void
}

const fileName = (p: string) => p.split('/').pop() ?? p

/** Edits a chat's or a working folder's memory: free-text notes plus attached files. */
export function MemoryModal({ kind, target, memory, onSave, onClose }: Props) {
  const [notes, setNotes] = useState(memory.notes)
  const [files, setFiles] = useState(memory.files)
  const add = async () => { const p = await window.desk.pickMemories(); if (p.length) setFiles((f) => [...new Set([...f, ...p])]) }
  const dirty = notes !== memory.notes || files.join('\n') !== memory.files.join('\n')
  const folder = kind === 'folder'
  return (
    <Dialog id="memory" className="share memory" title={<>{folder ? '🗂 Folder memory' : '🧠 Session memory'}</>} onClose={onClose}>
        <p className="muted">
          {folder
            ? <>Shared by <b>every chat</b> in <code title={target}>{fileName(target)}</code>, new and existing. Use it for standing facts, preferences and decisions about this project.</>
            : <>Only for this chat (<b>{target}</b>). Folder memory still applies; where they disagree, session memory wins.</>}
          {' '}The agent reads it at the start of every turn.
        </p>
        <label className="mem-label">Notes</label>
        <textarea className="mem-notes" value={notes} onChange={(e) => setNotes(e.target.value)} autoFocus rows={8}
          placeholder={folder ? 'e.g. Fiscal weeks start on Sunday. Report sales in $K. Use st-data-point-of-sale for store sales.' : 'e.g. We are comparing Q3 vs Q4 for Austin stores only.'} />
        <label className="mem-label">Files <span className="muted">(usually shared chat exports, .md or .txt)</span></label>
        <div className="mem-files">
          {files.length === 0 && <div className="muted">No files attached.</div>}
          {files.map((f) => (
            <div key={f} className="mem-file" title={f}>
              <span>📄 {fileName(f)}</span><span className="muted path">{f}</span>
              <button onClick={() => setFiles(files.filter((x) => x !== f))} title="Detach">×</button>
            </div>
          ))}
          <button onClick={add}>＋ Attach files…</button>
        </div>
        <div className="actions">
          {(memory.notes || memory.files.length > 0) && <button className="danger" onClick={() => { onSave({ files: [], notes: '' }); onClose() }}>Clear</button>}
          <div className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!dirty} onClick={() => { onSave({ files, notes }); onClose() }}>Save</button>
        </div>
    </Dialog>
  )
}
