import { useMemo, useState, type ReactNode } from 'react'

export interface TreeRow { id: string; title: string; cwd: string; updated_at: number; turns: number; parent_id: string | null; group?: string; turnsAtLeast?: boolean }

interface Folder<T> { key: string; name: string; full: string; folders: Folder<T>[]; sessions: Array<SessionNode<T>>; ids: string[]; latest: number }
interface SessionNode<T> { row: T; forks: Array<SessionNode<T>> }

const when = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
const tidy = (p: string) => p.replace(/^\/Users\/[^/]+(?=\/|$)/, '~')

/** Folder tree from each row's working folder: path segments become nested folders, chains with no sessions collapse into one row ("~/projects/demo"). */
export function buildTree<T extends TreeRow>(rows: T[]): Folder<T> {
  type Raw = { name: string; kids: Map<string, Raw>; rows: T[]; full: string }
  const root: Raw = { name: '', kids: new Map(), rows: [], full: '' }
  for (const r of rows) {
    const path = tidy(r.group || r.cwd || '(no folder)')
    const parts = path.split('/').filter(Boolean)
    let n = root
    parts.forEach((seg, i) => {
      if (!n.kids.has(seg)) n.kids.set(seg, { name: seg, kids: new Map(), rows: [], full: (path.startsWith('/') ? '/' : '') + parts.slice(0, i + 1).join('/') })
      n = n.kids.get(seg)!
    })
    n.rows.push(r)
  }
  const nest = (rs: T[]): Array<SessionNode<T>> => {
    const nodes = new Map(rs.map((r) => [r.id, { row: r, forks: [] as Array<SessionNode<T>> }]))
    const top: Array<SessionNode<T>> = []
    for (const n of nodes.values()) {
      const p = n.row.parent_id && nodes.get(n.row.parent_id)
      ;(p ? p.forks : top).push(n)
    }
    const sort = (a: Array<SessionNode<T>>) => { a.sort((x, y) => y.row.updated_at - x.row.updated_at); a.forEach((n) => sort(n.forks)) }
    sort(top)
    return top
  }
  const conv = (r: Raw, prefix: string): Folder<T> => {
    let name = prefix ? `${prefix}/${r.name}` : r.name
    let cur = r
    while (!cur.rows.length && cur.kids.size === 1) { cur = [...cur.kids.values()][0]; name = name ? `${name}/${cur.name}` : cur.name }
    const folders = [...cur.kids.values()].map((k) => conv(k, ''))
    const ids = [...cur.rows.map((x) => x.id), ...folders.flatMap((f) => f.ids)]
    const latest = Math.max(0, ...cur.rows.map((x) => x.updated_at), ...folders.map((f) => f.latest))
    folders.sort((a, b) => b.latest - a.latest)
    return { key: cur.full || '/', name: name || cur.full || '/', full: cur.full, folders, sessions: nest(cur.rows), ids, latest }
  }
  return conv(root, '')
}

/** Checkbox tree of chats grouped by working folder, with a filter, tri-state folder checkboxes and fork nesting. */
export function SessionTree<T extends TreeRow>({ rows, picked, setPicked, extra, extraLabel, rowClass }: {
  rows: T[]; picked: Set<string>; setPicked(s: Set<string>): void; extra?: (r: T) => ReactNode; extraLabel?: string; rowClass?: (r: T) => string
}) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<Set<string> | null>(null)
  const shown = useMemo(() => {
    const k = q.trim().toLowerCase()
    return k ? rows.filter((r) => `${r.title} ${r.group ?? r.cwd} ${r.id}`.toLowerCase().includes(k)) : rows
  }, [rows, q])
  const tree = useMemo(() => buildTree(shown), [shown])
  // A common prefix with no chats of its own ("~/projects") is shown as one expanded top folder.
  // Chats whose folder is "/" get their own sibling folder instead of making "/" the parent of everything.
  const top = tree.key === '/' && tree.sessions.length
    ? [...tree.folders, { ...tree, key: '/:own', name: '/', folders: [], ids: tree.sessions.flatMap(flat), latest: Math.max(...tree.sessions.map((n) => n.row.updated_at)) }].sort((a, b) => b.latest - a.latest)
    : tree.name ? [tree] : tree.folders
  // Small lists start fully expanded; large ones (Copilot can list hundreds) open only the top folders.
  const defaults = () => new Set((rows.length <= 40 ? top.flatMap(collect) : top).map((x) => x.key))
  const isOpen = (f: Folder<T>) => !!q.trim() || (open ?? defaults()).has(f.key)
  const toggle = (f: Folder<T>) => {
    const base = open ?? defaults()
    const n = new Set(base); n.has(f.key) ? n.delete(f.key) : n.add(f.key); setOpen(n)
  }
  const setMany = (ids: string[], on: boolean) => { const n = new Set(picked); ids.forEach((id) => (on ? n.add(id) : n.delete(id))); setPicked(n) }
  const all = shown.length > 0 && shown.every((r) => picked.has(r.id))
  const some = shown.some((r) => picked.has(r.id))
  const expandAll = (on: boolean) => setOpen(new Set(on ? top.flatMap(collect).map((f) => f.key) : []))

  const out: ReactNode[] = []
  const walk = (f: Folder<T>, depth: number) => {
    const sel = f.ids.filter((id) => picked.has(id)).length
    const exp = isOpen(f)
    out.push(
      <div key={`f:${f.key}`} className="tree-row tree-folder" style={{ paddingLeft: 8 + depth * 18 }}>
        <input type="checkbox" checked={sel === f.ids.length} ref={(el) => { if (el) el.indeterminate = sel > 0 && sel < f.ids.length }} onChange={(e) => setMany(f.ids, e.target.checked)} />
        <button className="tree-toggle" onClick={() => toggle(f)} title={f.full}>
          <span className="tree-chev">{exp ? '▾' : '▸'}</span>📂 <b>{f.name}</b>
          <span className="muted small"> · {plural(f.ids.length, 'session')}{sel ? ` · ${sel} selected` : ''}</span>
        </button>
        <span className="tree-when muted small">{when(f.latest)}</span>
      </div>
    )
    if (!exp) return
    f.folders.forEach((c) => walk(c, depth + 1))
    const sess = (n: SessionNode<T>, d: number) => {
      const r = n.row
      out.push(
        <div key={r.id} className={`tree-row tree-session ${rowClass?.(r) ?? ''}`} style={{ paddingLeft: 8 + d * 18 }}>
          <input type="checkbox" checked={picked.has(r.id)} onChange={(e) => setMany([r.id], e.target.checked)} />
          <div className="tree-main">
            <div className="sync-title">{r.parent_id ? '⑂ ' : ''}{r.title}</div>
            {r.turns > 0 && <div className="muted small" title={r.turnsAtLeast ? 'The source index is behind its log: the full chat is read at import' : undefined}>{r.turnsAtLeast ? `${r.turns}+ turns` : plural(r.turns, 'turn')}</div>}
            {extra && <div className="small tree-extra">{extra(r)}</div>}
          </div>
          <span className="tree-when small">{when(r.updated_at)}</span>
        </div>
      )
      n.forks.forEach((k) => sess(k, d + 1))
    }
    f.sessions.forEach((n) => sess(n, depth + 1))
  }
  top.forEach((f) => walk(f, 0))

  return (
    <>
      <div className="row-actions">
        <input className="sync-filter" placeholder={`Filter ${rows.length} sessions by title, folder or ID…`} value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="link" onClick={() => expandAll(true)}>Expand all</button>
        <button className="link" onClick={() => expandAll(false)}>Collapse all</button>
      </div>
      <div className="sync-scroll tree">
        <div className="tree-row tree-head">
          <input type="checkbox" checked={all} ref={(el) => { if (el) el.indeterminate = some && !all }} title="Select every session shown" onChange={() => setMany(shown.map((r) => r.id), !all)} />
          <span className="tree-main">{picked.size} of {rows.length} selected{extraLabel ? ` · ${extraLabel}` : ''}</span>
          <span className="tree-when">Last updated</span>
        </div>
        {out}
        {!shown.length && <div className="muted small sync-empty">No sessions match.</div>}
      </div>
    </>
  )
}

function collect<T>(f: Folder<T>): Folder<T>[] { return [f, ...f.folders.flatMap(collect)] }
function flat<T extends TreeRow>(n: SessionNode<T>): string[] { return [n.row.id, ...n.forks.flatMap(flat)] }
