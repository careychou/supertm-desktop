import { useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

const WIDTH = 340

/** A small ⓘ next to a label: hover, focus or click shows an explanation. Rendered in a portal so a scrolling modal can't clip it. */
export function Info({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null)
  const [pinned, setPinned] = useState(false)
  const show = () => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    const left = Math.max(8, Math.min(r.left - 12, window.innerWidth - WIDTH - 8))
    setPos(r.bottom > window.innerHeight - 220 ? { left, bottom: window.innerHeight - r.top + 6 } : { left, top: r.bottom + 6 })
  }
  const hide = () => { if (!pinned) setPos(null) }
  return (
    <span
      ref={ref}
      className="info"
      role="button"
      tabIndex={0}
      aria-label="What is this?"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={() => { setPinned(false); setPos(null) }}
      // inside a <label>, a click would otherwise focus the field
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (pinned) { setPinned(false); setPos(null) } else { setPinned(true); show() } }}
      onKeyDown={(e) => { if (e.key === 'Escape') { setPinned(false); setPos(null) } }}
    >
      i
      {pos && createPortal(<div className="info-pop" role="tooltip" style={{ ...pos, width: WIDTH }}>{children}</div>, document.body)}
    </span>
  )
}

/** Label text with an ⓘ that explains the setting and gives an example. */
export function Lbl({ text, tip, ex }: { text: ReactNode; tip: ReactNode; ex?: ReactNode }) {
  return <span className="lbl">{text}<Info>{tip}{ex && <div className="info-ex"><b>Example:</b> {ex}</div>}</Info></span>
}
