import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { useEscape } from '../hooks/useEscape'
import { useExpand } from '../hooks/useExpand'

interface Props {
  /** Remembers this dialog's expanded state and dragged size. */
  id: string
  title?: ReactNode
  /** Replaces the title, e.g. a row of tabs. */
  head?: ReactNode
  className?: string
  onClose(): void
  /** False while work is running that must not be interrupted. */
  closable?: boolean
  children: ReactNode
}

const sizeKey = (id: string) => `size.${id}`

/**
 * Shared frame for app dialogs: a header with expand and close buttons, a drag-to-resize corner whose size is
 * remembered, Esc to close, and a backdrop click that only closes when the press also started on the backdrop
 * (so a resize or text-selection drag that ends outside the dialog does not close it).
 */
export function Dialog({ id, title, head, className = '', onClose, closable = true, children }: Props) {
  const [big, toggleBig] = useExpand(id)
  const ref = useRef<HTMLDivElement>(null)
  const downOnBg = useRef(false)
  useEscape(onClose, closable)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.width = ''; el.style.height = ''
    if (big) return
    try {
      const s = JSON.parse(localStorage.getItem(sizeKey(id)) ?? 'null') as { w: number; h: number } | null
      if (s) { el.style.width = `${s.w}px`; el.style.height = `${s.h}px` }
    } catch { /* ignore a bad saved size */ }
  }, [big, id])

  // the resize corner writes an inline width/height; keep it for next time
  useEffect(() => {
    const el = ref.current
    if (!el || big) return
    let t: ReturnType<typeof setTimeout> | undefined
    const save = () => { if (el.style.width) localStorage.setItem(sizeKey(id), JSON.stringify({ w: el.offsetWidth, h: el.offsetHeight })) }
    const ro = new ResizeObserver(() => { clearTimeout(t); t = setTimeout(save, 300) })
    ro.observe(el)
    // the drag ends with a mouseup, possibly outside the dialog; a backup for when the observer is throttled
    window.addEventListener('mouseup', save)
    return () => { clearTimeout(t); ro.disconnect(); window.removeEventListener('mouseup', save) }
  }, [big, id])
  const toggle = () => { localStorage.removeItem(sizeKey(id)); toggleBig() }
  const reset = () => {
    localStorage.removeItem(sizeKey(id))
    const el = ref.current
    if (el) { el.style.width = ''; el.style.height = '' }
  }

  return (
    <div
      className="modal-bg"
      onMouseDown={(e) => { downOnBg.current = e.target === e.currentTarget }}
      onClick={(e) => { if (closable && downOnBg.current && e.target === e.currentTarget) onClose(); downOnBg.current = false }}
    >
      <div ref={ref} className={`modal resizable ${className}${big ? ' expanded' : ''}`} role="dialog" aria-modal="true">
        <div className="dialog-head">
          {head ?? <h2 className="dialog-title">{title}</h2>}
          <div className="dialog-btns">
            <button className="icon-btn" onClick={toggle} onDoubleClick={reset} title={big ? 'Shrink window' : 'Expand window'} aria-label={big ? 'Shrink window' : 'Expand window'}>{big ? '⤡' : '⤢'}</button>
            <button className="icon-btn close" onClick={onClose} disabled={!closable} title="Close (Esc)" aria-label="Close">✕</button>
          </div>
        </div>
        {children}
      </div>
    </div>
  )
}
