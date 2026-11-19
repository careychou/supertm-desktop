import { useMemo, useState } from 'react'
import type { SessionRow } from '../../../shared/api'
import { buildTree, canNest, shownParent, type TreeNode } from '../../../shared/fork'
import { Dialog } from './Dialog'

/** Picks the chat another chat is filed under. Lists the chats of the same working folder as they are nested in the sidebar. */
export function MoveModal({ session, sessions, onClose }: { session: SessionRow; sessions: SessionRow[]; onClose(): void }) {
  const [q, setQ] = useState('')
  const inFolder = useMemo(() => sessions.filter((s) => s.cwd === session.cwd), [sessions, session.cwd])
  const current = shownParent(sessions, session.id)
  const rows = useMemo(() => {
    const out: Array<{ s: SessionRow; depth: number }> = []
    const walk = (n: TreeNode<SessionRow>, depth: number) => { if (n.row.id !== session.id) { out.push({ s: n.row, depth }); n.children.forEach((k) => walk(k, depth + 1)) } }
    buildTree(inFolder).forEach((n) => walk(n, 0))
    const k = q.trim().toLowerCase()
    return k ? out.filter((r) => r.s.title.toLowerCase().includes(k)).map((r) => ({ ...r, depth: 0 })) : out
  }, [inFolder, session.id, q])
  const kids = inFolder.filter((s) => shownParent(sessions, s.id) === session.id).length
  const move = async (parent: string | null) => { await window.desk.moveSession(session.id, parent); onClose() }

  return (
    <Dialog id="move" className="move" title="Move under another chat" onClose={onClose}>
      <p className="muted">Choose the chat that <b>{session.title}</b> should sit under. It is listed there like a fork{kids ? `, and its ${kids} own ${kids === 1 ? 'child comes' : 'children come'} along` : ''}. Nothing in either chat changes.</p>
      <input className="sync-filter" autoFocus placeholder="Filter chats in this folder…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="move-list">
        {!q.trim() && (
          <button className="move-row" disabled={current === null} onClick={() => void move(null)}>
            <span className="mark">⇤</span><span className="title">Top level of the folder</span>{current === null && <span className="muted small">here now</span>}
          </button>
        )}
        {rows.map(({ s, depth }) => (
          <button key={s.id} className="move-row" style={{ paddingLeft: 8 + depth * 18 }} disabled={s.id === current || !canNest(sessions, session.id, s.id)} onClick={() => void move(s.id)} title={s.title}>
            <span className="mark">{depth > 0 ? '⑂' : '•'}</span><span className="title">{s.title}</span>{s.id === current && <span className="muted small">here now</span>}
          </button>
        ))}
        {!rows.length && <div className="muted small sync-empty">{q.trim() ? 'No chats match.' : 'No other chats in this folder.'}</div>}
      </div>
      <div className="actions"><button onClick={onClose}>Cancel</button></div>
    </Dialog>
  )
}
