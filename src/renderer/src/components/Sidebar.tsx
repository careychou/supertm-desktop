import { UsageRing, fmtUsd } from './UsageModal'
import { useRef, useState } from 'react'
import type { BookmarkRow, FolderRow, SessionRow } from '../../../shared/api'
import { buildTree, canNest, isWithin, pinnedAncestor, shownParent, subtreeIds, subtreeOf, type TreeNode } from '../../../shared/fork'
import { MoveModal } from './MoveModal'
import { Menu, at, type MenuEntry, type MenuState } from './Menu'
import { BRAND } from '../../../shared/brand'
import { hasMemory, parseMemory } from '../../../shared/memory'

interface Props {
  folders: FolderRow[]
  sessions: SessionRow[]
  bookmarks: BookmarkRow[]
  currentId: string | null
  busyIds: Set<string>
  /** Chats in Bookmarks (and their sub-chats) are left out of their working folder. */
  hidePinned?: boolean
  onOpen(id: string): void
  onNewChat(cwd: string): void
  onDelete(s: SessionRow): void
  onAddFolder(): void
  onRemoveFolder(path: string): void
  onFolderMemory(path: string): void
  onCollapse(): void
  onSettings(): void
  /** Newer app version found by the launch check. */
  appUpdate?: string | null
  onAppUpdate?(): void
  onUsage(): void
  usage: { today: number | null; budget: number }
  onShare(s: SessionRow): void
  onCompact(s: SessionRow): void
  /** Open the Plugins panel for a folder. */
  onPlugins?(path: string): void
  /** Folders with plugin updates available. */
  pluginUpdates?: Set<string>
}

const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p

type Drag = { kind: 'session'; id: string } | { kind: 'bookmark'; id: string }
type Zone = 'before' | 'after' | 'into'
type Ctx = Props & {
  setMenu(m: MenuState | null): void
  editing: string | null
  setEditing(key: string | null): void
  drag: React.MutableRefObject<Drag | null>
  over: { key: string; zone: Zone } | null
  setOver(o: { key: string; zone: Zone } | null): void
  /** Opens the "Move under another chat" picker. */
  setMoving(s: SessionRow | null): void
  /** Session ids that have a pin. */
  pinned: Set<string | null>
  /** Chats shown under Bookmarks (pinned chats and their sub-chats). */
  inBookmarks: Set<string>
  showBookmarks(): void
}

/** Spinning ring shown while a chat runs. `inside` = collapsed row whose running chats are hidden beneath it. */
function Running({ n, inside }: { n: number; inside?: boolean }) {
  if (!n) return null
  return <span className={`run${inside ? ' inside' : ''}`} title={inside ? `${n} running inside` : 'Running…'}>{inside && n > 1 && <b>{n}</b>}</span>
}
const busyCount = (c: Ctx, ids: string[]) => ids.filter((id) => c.busyIds.has(id)).length

/** Where on a row the pointer is: top/bottom half, or (for containers) top quarter / middle / bottom quarter. */
function zoneOf(e: React.DragEvent, container: boolean): Zone {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const y = (e.clientY - r.top) / r.height
  if (!container) return y < 0.5 ? 'before' : 'after'
  return y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'into'
}

/** Drag/drop props for a row. `accept` returns the allowed zone (or null) for the current drag; `drop` performs it. */
function dnd(c: Ctx, key: string, start: Drag, accept: (d: Drag, z: Zone) => Zone | null, drop: (d: Drag, z: Zone) => void, container: boolean | ((d: Drag) => boolean) = false) {
  const cls = c.over?.key === key ? ` drop-${c.over.zone}` : ''
  return {
    cls,
    props: {
      draggable: c.editing === null,
      onDragStart: (e: React.DragEvent) => { c.drag.current = start; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', key); e.stopPropagation() },
      onDragEnd: () => { c.drag.current = null; c.setOver(null) },
      onDragOver: (e: React.DragEvent) => {
        const d = c.drag.current
        if (!d) return
        const z = accept(d, zoneOf(e, typeof container === 'function' ? container(d) : container))
        if (!z) { if (c.over?.key === key) c.setOver(null); return }
        e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'
        if (c.over?.key !== key || c.over.zone !== z) c.setOver({ key, zone: z })
      },
      onDragLeave: (e: React.DragEvent) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node) && c.over?.key === key) c.setOver(null) },
      onDrop: (e: React.DragEvent) => {
        const d = c.drag.current, z = c.over?.key === key ? c.over.zone : null
        c.drag.current = null; c.setOver(null)
        if (!d || !z) return
        e.preventDefault(); e.stopPropagation(); drop(d, z)
      }
    }
  }
}

function InlineEdit({ value, onDone }: { value: string; onDone(v: string | null): void }) {
  const [v, setV] = useState(value)
  return (
    <input className="inline-edit" autoFocus value={v} onChange={(e) => setV(e.target.value)} onClick={(e) => e.stopPropagation()}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => { if (e.key === 'Enter') onDone(v.trim() || null); if (e.key === 'Escape') onDone(null) }}
      onBlur={() => onDone(v.trim() && v.trim() !== value ? v.trim() : null)} />
  )
}

/** Bookmark folders a pin/folder can be moved into (excluding a folder's own subtree). */
function folderTargets(bms: BookmarkRow[], exclude?: string): Array<{ id: string | null; label: string }> {
  const folders = bms.filter((b) => b.kind === 'folder')
  const out: Array<{ id: string | null; label: string }> = [{ id: null, label: 'Bookmarks (top level)' }]
  const walk = (parent: string | null, depth: number) => {
    for (const f of folders.filter((x) => x.parent_id === parent)) {
      if (f.id === exclude) continue
      out.push({ id: f.id, label: `${'  '.repeat(depth)}📁 ${f.name}` })
      walk(f.id, depth + 1)
    }
  }
  walk(null, 1)
  return out
}

function moveEntries(s: SessionRow, c: Ctx): MenuEntry[] {
  return [
    ...(c.sessions.some((x) => x.id !== s.id && canNest(c.sessions, s.id, x.id)) ? [{ label: '⑂ Move under another chat…', onClick: () => c.setMoving(s) }] : []),
    ...(shownParent(c.sessions, s.id) ? [{ label: '⇤ Move to top level', onClick: () => void window.desk.moveSession(s.id, null) }] : [])
  ]
}

function sessionMenu(s: SessionRow, c: Ctx, extra: MenuEntry[] = []): MenuEntry[] {
  const pinned = c.pinned.has(s.id)
  const holder = pinnedAncestor(c.sessions, c.pinned, s.id)
  const holderTitle = holder ? c.sessions.find((x) => x.id === holder)?.title : ''
  const kids = subtreeOf(c.sessions, s.id)?.children.length ?? 0
  const what = kids ? ' (with its sub-chats)' : ''
  // A pin shows the chat's whole tree, so a chat inside a pinned tree is pinned on its own only by moving it out.
  const pinLabel = holder ? `☆ Pin on its own (moves out of “${holderTitle}”)` : `☆ Pin to Bookmarks${what}`
  const move = moveEntries(s, c)
  return [
    { label: '✎ Rename', onClick: () => c.setEditing(`s:${s.id}`) },
    pinned ? { label: '★ Pinned', onClick: () => {}, disabled: true } : { label: pinLabel, onClick: () => window.desk.pinSession(s.id, null) },
    ...folderTargets(c.bookmarks).slice(1).filter(() => !pinned && !holder).map((f) => ({ label: `☆ Pin to ${f.label.trim()}${what}`, onClick: () => window.desk.pinSession(s.id, f.id) })),
    ...extra,
    ...(move.length ? ['sep' as const, ...move] : []),
    'sep',
    { label: '⇪ Share / export…', onClick: () => c.onShare(s) },
    { label: '⇲ Compact history…', onClick: () => c.onCompact(s) },
    'sep',
    { label: '🗑 Delete', danger: true, onClick: () => c.onDelete(s) }
  ]
}

/** Session id a drag carries: a dragged chat, or the chat of a dragged pin. */
const dragSession = (c: Ctx, dr: Drag) => (dr.kind === 'session' ? dr.id : c.bookmarks.find((b) => b.id === dr.id && b.kind === 'pin')?.session_id ?? null)
/** Whether the dragged chat (or pinned chat) may be filed under chat `s`. */
const canDropInto = (c: Ctx, dr: Drag, s: SessionRow) => {
  const id = dragSession(c, dr)
  return !!id && id !== s.id && canNest(c.sessions, id, s.id) && shownParent(c.sessions, id) !== s.id
}

/** A chat row and its sub-chats. `keyPrefix` keeps rows unique when the same chat is drawn in Bookmarks and in its folder. */
function SessionNode({ node, depth, c, keyPrefix = 's' }: { node: TreeNode<SessionRow>; depth: number; c: Ctx; keyPrefix?: string }) {
  const [open, setOpen] = useState(true)
  const s = node.row
  const hasKids = node.children.length > 0
  const menu = (e: React.MouseEvent) => c.setMenu(at(e, sessionMenu(s, c)))
  const d = dnd(c, `${keyPrefix}:${s.id}`, { kind: 'session', id: s.id },
    (dr, z) => {
      const id = dragSession(c, dr)
      if (!id || id === s.id) return null
      const o = c.sessions.find((x) => x.id === id)
      if (!o || o.cwd !== s.cwd) return null
      // Middle of a row: file the dragged chat under this one. Top or bottom edge: place it beside this one, at this one's level.
      if (z === 'into') return canDropInto(c, dr, s) ? z : null
      return canNest(c.sessions, id, shownParent(c.sessions, s.id)) ? z : null
    },
    (dr, z) => {
      const id = dragSession(c, dr)!
      if (z === 'into') { setOpen(true); void window.desk.moveSession(id, s.id) }
      else void window.desk.moveSession(id, shownParent(c.sessions, s.id), s.id, z === 'before')
    }, (dr) => canDropInto(c, dr, s))
  const self = c.busyIds.has(s.id) ? 1 : 0
  const hidden = hasKids && !open ? busyCount(c, subtreeIds(node)) - self : 0
  return (
    <>
      <div className={`session ${c.currentId === s.id ? 'on' : ''}${self ? ' running' : ''}${d.cls}`} {...d.props} style={{ paddingLeft: 12 + depth * 18 }} onClick={() => c.onOpen(s.id)}
        onDoubleClick={() => c.setEditing(`s:${s.id}`)} onContextMenu={menu} title={s.title}>
        {hasKids
          ? <button className="twisty" onClick={(e) => { e.stopPropagation(); setOpen(!open) }}>{open ? '▾' : '▸'}</button>
          : depth > 0 ? <span className="fork-mark">⑂</span> : <span className="dot" />}
        {c.editing === `s:${s.id}`
          ? <InlineEdit value={s.title} onDone={(v) => { c.setEditing(null); if (v) void window.desk.renameSession(s.id, v) }} />
          : <span className="title">{s.title}</span>}
        {hasKids && !open && <span className="count">{node.children.length}</span>}
        {self ? <Running n={1} /> : <Running n={hidden} inside />}
        <button className="more" title="More actions" onClick={menu}>⋯</button>
      </div>
      {open && node.children.map((ch) => <SessionNode key={ch.row.id} node={ch} depth={depth + 1} c={c} keyPrefix={keyPrefix} />)}
    </>
  )
}

function BookmarkNode({ b, depth, c }: { b: BookmarkRow; depth: number; c: Ctx }) {
  const pad = { paddingLeft: 12 + depth * 18 }
  const move: MenuEntry[] = [
    ...folderTargets(c.bookmarks, b.kind === 'folder' ? b.id : undefined).filter((f) => f.id !== b.parent_id)
      .map((f) => ({ label: `→ Move to ${f.label.trim()}`, onClick: () => window.desk.updateBookmark(b.id, { parent_id: f.id }) }))
  ]
  const isFolder = b.kind === 'folder'
  const pinS = b.kind === 'pin' ? c.sessions.find((x) => x.id === b.session_id) : undefined
  const d = dnd(c, `b:${b.id}`, { kind: 'bookmark', id: b.id },
    (dr, z) => {
      if (dr.kind === 'bookmark') {
        if (dr.id === b.id) return null
        const target = z === 'into' ? (isFolder ? b.id : null) : b.parent_id
        if (target && isWithin(c.bookmarks, dr.id, target)) return null
      }
      return z
    },
    (dr, z) => {
      // Middle of a pin: file the dragged chat (with its sub-chats) under the pinned chat. Its own pin goes, as it now shows in this tree.
      if (z === 'into' && pinS) {
        if (b.collapsed) void window.desk.updateBookmark(b.id, { collapsed: 0 })
        void window.desk.moveSession(dragSession(c, dr)!, pinS.id)
        return
      }
      const parent = z === 'into' ? b.id : b.parent_id
      const targetId = z === 'into' ? null : b.id
      if (dr.kind === 'session') void window.desk.pinSession(dr.id, parent, targetId, z === 'before')
      else void window.desk.placeBookmark(dr.id, parent, targetId, z === 'before')
      if (z === 'into' && b.collapsed) void window.desk.updateBookmark(b.id, { collapsed: 0 })
    }, isFolder || ((dr) => !!pinS && canDropInto(c, dr, pinS)))
  if (b.kind === 'pin') {
    const s = pinS
    // Already drawn inside another pin's tree (pins are pruned to one per tree; this covers the moment before that).
    if (!s || pinnedAncestor(c.sessions, c.pinned, s.id)) return null
    const tree = subtreeOf(c.sessions, s.id)
    const kids = tree?.children ?? []
    const open = !b.collapsed
    const nest = moveEntries(s, c)
    const menu = (e: React.MouseEvent) => c.setMenu(at(e, [
      { label: '✎ Rename', onClick: () => c.setEditing(`b:${b.id}`) },
      { label: kids.length ? '★ Unpin (with its sub-chats)' : '★ Unpin', onClick: () => window.desk.removeBookmark(b.id) },
      ...(move.length ? ['sep' as const, ...move] : []),
      ...(nest.length ? ['sep' as const, ...nest] : []), 'sep',
      { label: '⇪ Share / export…', onClick: () => c.onShare(s) },
      { label: '⇲ Compact history…', onClick: () => c.onCompact(s) }
    ]))
    const self = c.busyIds.has(s.id) ? 1 : 0
    const hidden = kids.length && !open && tree ? busyCount(c, subtreeIds(tree)) - self : 0
    return (
      <>
        <div className={`session pin ${c.currentId === s.id ? 'on' : ''}${self ? ' running' : ''}${d.cls}`} {...d.props} style={pad} onClick={() => c.onOpen(s.id)}
          onDoubleClick={() => c.setEditing(`b:${b.id}`)} onContextMenu={menu} title={`${s.title}\n${s.cwd}`}>
          {kids.length
            ? <button className="twisty" title={open ? 'Hide sub-chats' : 'Show sub-chats'} onClick={(e) => { e.stopPropagation(); void window.desk.updateBookmark(b.id, { collapsed: open ? 1 : 0 }) }}>{open ? '▾' : '▸'}</button>
            : <span className="twisty" />}
          <span className="pin-mark">★</span>
          {c.editing === `b:${b.id}`
            ? <InlineEdit value={s.title} onDone={(v) => { c.setEditing(null); if (v) void window.desk.renameSession(s.id, v) }} />
            : <span className="title">{s.title}</span>}
          {kids.length > 0 && !open && <span className="count">{kids.length}</span>}
          <span className="pin-folder">{base(s.cwd)}</span>
          {self ? <Running n={1} /> : <Running n={hidden} inside />}
          <button className="more" title="More actions" onClick={menu}>⋯</button>
        </div>
        {open && kids.map((ch) => <SessionNode key={ch.row.id} node={ch} depth={depth + 2} c={c} keyPrefix={`p${b.id}`} />)}
      </>
    )
  }
  const kids = c.bookmarks.filter((x) => x.parent_id === b.id)
  const open = !b.collapsed
  const inFolder = (id: string): string[] => c.bookmarks.filter((x) => x.parent_id === id).flatMap((x) => {
    if (x.kind === 'folder') return inFolder(x.id)
    const t = x.session_id ? subtreeOf(c.sessions, x.session_id) : null
    return t ? subtreeIds(t) : []
  })
  const hidden = open ? 0 : busyCount(c, inFolder(b.id))
  const menu = (e: React.MouseEvent) => c.setMenu(at(e, [
    { label: '✎ Rename folder', onClick: () => c.setEditing(`b:${b.id}`) },
    { label: '＋ New subfolder', onClick: () => window.desk.addBookmarkFolder('New folder', b.id) },
    ...(move.length ? ['sep' as const, ...move] : []), 'sep',
    { label: '🗑 Delete folder (keeps pins)', danger: true, onClick: () => window.desk.removeBookmark(b.id) }
  ]))
  return (
    <>
      <div className={`session bm-folder${d.cls}`} {...d.props} style={pad} onClick={() => window.desk.updateBookmark(b.id, { collapsed: open ? 1 : 0 })}
        onDoubleClick={(e) => { e.stopPropagation(); c.setEditing(`b:${b.id}`) }} onContextMenu={menu}>
        <span className="twisty">{open ? '▾' : '▸'}</span>
        <span className="folder-icon">{open ? '📂' : '📁'}</span>
        {c.editing === `b:${b.id}`
          ? <InlineEdit value={b.name ?? ''} onDone={(v) => { c.setEditing(null); if (v) void window.desk.updateBookmark(b.id, { name: v }) }} />
          : <span className="title">{b.name}</span>}
        {!open && kids.length > 0 && <span className="count">{kids.length}</span>}
        <Running n={hidden} inside />
        <button className="more" title="More actions" onClick={menu}>⋯</button>
      </div>
      {open && (kids.length
        ? kids.map((k) => <BookmarkNode key={k.id} b={k} depth={depth + 1} c={c} />)
        : <div className="session empty-hint" style={{ paddingLeft: 30 + (depth + 1) * 18 }}>Empty, drag chats here</div>)}
    </>
  )
}

function FolderGroup({ folder, sessions, c }: { folder: FolderRow; sessions: SessionRow[]; c: Ctx }) {
  const [open, setOpen] = useState(true)
  const hidden = c.hidePinned ? sessions.filter((x) => c.inBookmarks.has(x.id)) : []
  const shown = hidden.length ? sessions.filter((x) => !c.inBookmarks.has(x.id)) : sessions
  const tree = buildTree(shown)
  const hasMem = hasMemory(parseMemory(folder.memory))
  const menu = (e: React.MouseEvent) => c.setMenu(at(e, [
    { label: '✎ New chat', onClick: () => c.onNewChat(folder.path) },
    { label: hasMem ? '🗂 Edit folder memory…' : '🗂 Add folder memory…', onClick: () => c.onFolderMemory(folder.path) },
    ...(c.onPlugins ? [{ label: '⧉ Plugins…', onClick: () => c.onPlugins!(folder.path) }] : []),
    'sep',
    { label: '× Remove folder', danger: true, onClick: () => c.onRemoveFolder(folder.path) }
  ]))
  // Dropping a nested chat on its folder moves it back to the top level; dropping a pin of this folder's chat unpins it.
  const pinOf = (dr: Drag) => (dr.kind === 'bookmark' ? c.bookmarks.find((x) => x.id === dr.id && x.kind === 'pin' && sessions.some((s) => s.id === x.session_id)) : undefined)
  const d = dnd(c, `f:${folder.path}`, { kind: 'session', id: '' },
    (dr) => ((dr.kind === 'session' && sessions.some((x) => x.id === dr.id) && shownParent(c.sessions, dr.id)) || pinOf(dr) ? 'into' : null),
    (dr) => { setOpen(true); const pin = pinOf(dr); void (pin ? window.desk.removeBookmark(pin.id) : window.desk.moveSession(dr.id, null)) }, true)
  return (
    <div className="folder-group">
      <div className={`folder-row${d.cls}`} onDragOver={d.props.onDragOver} onDragLeave={d.props.onDragLeave} onDrop={d.props.onDrop} onClick={() => setOpen(!open)} onContextMenu={menu} title={folder.path}>
        <span className="folder-icon">{open ? '📂' : '📁'}</span>
        <span className="title">{base(folder.path)}</span>
        {!open && <Running n={busyCount(c, shown.map((x) => x.id))} inside />}
        {c.pluginUpdates?.has(folder.path) && <button className="tm-badge" title="Plugin updates available. Click to review." onClick={(e) => { e.stopPropagation(); c.onPlugins?.(folder.path) }}>⬆</button>}
        {hasMem && <button className="folder-mem" title="Folder memory: shared by every chat in this folder. Click to edit." onClick={(e) => { e.stopPropagation(); c.onFolderMemory(folder.path) }}>🗂</button>}
        <button className="folder-act" title="New chat in this folder" onClick={(e) => { e.stopPropagation(); c.onNewChat(folder.path) }}>＋</button>
        <button className="folder-act" title="More actions: folder memory, remove" onClick={menu}>⋯</button>
      </div>
      {open && (tree.length
        ? tree.map((n) => <SessionNode key={n.row.id} node={n} depth={0} c={c} />)
        : <div className="session empty-hint" onClick={() => c.onNewChat(folder.path)}>Start a chat…</div>)}
      {open && hidden.length > 0 && <div className="session in-bookmarks" title="These chats are listed under Bookmarks. Unpin one to bring it back here, or change this in Settings → General." onClick={c.showBookmarks}>★ {hidden.length} in Bookmarks</div>}
    </div>
  )
}

export function Sidebar(p: Props) {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [bmOpen, setBmOpen] = useState(true)
  const drag = useRef<Drag | null>(null)
  const [over, setOver] = useState<{ key: string; zone: Zone } | null>(null)
  const [moving, setMoving] = useState<SessionRow | null>(null)
  const pinned = new Set(p.bookmarks.filter((b) => b.kind === 'pin').map((b) => b.session_id))
  const inBookmarks = new Set([...pinned].flatMap((id) => { const t = id ? subtreeOf(p.sessions, id) : null; return t ? subtreeIds(t) : [] }))
  const bmRef = useRef<HTMLDivElement>(null)
  const showBookmarks = () => { setBmOpen(true); bmRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }) }
  const c: Ctx = { ...p, setMenu, editing, setEditing, drag, over, setOver, setMoving, pinned, inBookmarks, showBookmarks }
  const bmRoot = dnd(c, 'bm-root', { kind: 'bookmark', id: '' }, () => 'into', (dr) => {
    setBmOpen(true)
    if (dr.kind === 'session') void window.desk.pinSession(dr.id, null, null, false)
    else void window.desk.placeBookmark(dr.id, null, null, false)
  }, true)
  const top = p.bookmarks.filter((b) => b.parent_id === null)
  return (
    <aside className="sidebar">
      <div className="side-top">
        <button className="icon" title="Hide sidebar (⌘B)" onClick={p.onCollapse}>◧</button>
      </div>
      <button className="new-chat" onClick={() => p.onNewChat('')}>✎ New chat</button>
      <div className="sessions">
        <div className="folder-group bookmarks" ref={bmRef}>
          <div className={`folder-row section${bmRoot.cls}`} onDragOver={bmRoot.props.onDragOver} onDragLeave={bmRoot.props.onDragLeave} onDrop={bmRoot.props.onDrop}
            onClick={() => setBmOpen(!bmOpen)} title="Drop a chat here to pin it">
            <span className="folder-icon">★</span>
            <span className="title">Bookmarks</span>
            {!bmOpen && <Running n={busyCount(c, [...inBookmarks])} inside />}
            <button className="folder-act" title="New bookmark folder" onClick={(e) => { e.stopPropagation(); setBmOpen(true); void window.desk.addBookmarkFolder('New folder', null) }}>＋</button>
          </div>
          {bmOpen && (top.length
            ? top.map((b) => <BookmarkNode key={b.id} b={b} depth={0} c={c} />)
            : <div className={`session empty-hint${bmRoot.cls}`} onDragOver={bmRoot.props.onDragOver} onDragLeave={bmRoot.props.onDragLeave} onDrop={bmRoot.props.onDrop}>Drag a chat here, or pin it from its ⋯ menu</div>)}
        </div>
        <div className="side-divider" />
        {p.folders.map((f) => <FolderGroup key={f.path} folder={f} sessions={p.sessions.filter((s) => s.cwd === f.path)} c={c} />)}
        <button className="add-folder" onClick={p.onAddFolder}>＋ Add working folder</button>
      </div>
      <div className="side-bottom">
        <span className="brand">{BRAND.logo && <img src={BRAND.logo} alt="" />}{BRAND.short}</span>
        <button className="usage-btn" onClick={p.onUsage}
          title={`AI usage (⌘⇧U)${p.usage.today !== null ? ` · today ${fmtUsd(p.usage.today)}${p.usage.budget ? ` of ${fmtUsd(p.usage.budget)}` : ''}` : ''}`}>
          <UsageRing frac={p.usage.budget && p.usage.today !== null ? p.usage.today / p.usage.budget : null} />
          {p.usage.today !== null && p.usage.today > 0 && <span>{fmtUsd(p.usage.today)}</span>}
        </button>
        {p.appUpdate && <button className="tm-badge" title={`Version ${p.appUpdate} is available. Click to review.`} onClick={p.onAppUpdate}>⬆</button>}
        <button className="icon" title="Settings" onClick={p.onSettings}>⚙</button>
      </div>
      {menu && <Menu menu={menu} onClose={() => setMenu(null)} />}
      {moving && <MoveModal session={moving} sessions={p.sessions} onClose={() => setMoving(null)} />}
    </aside>
  )
}
