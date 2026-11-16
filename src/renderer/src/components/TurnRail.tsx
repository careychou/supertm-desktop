import { useEffect, useMemo, useState, type RefObject } from 'react'
import type { Item } from '../state'
import { currentTurn, offsetIn, promptTops, scrollToTurn, turnSummaries } from '../turns'

/** Copilot-style turn navigation: a tick per prompt on the right edge, plus the current prompt pinned on top. */
export function TurnRail({ scroller, items }: { scroller: RefObject<HTMLDivElement | null>; items: Item[] }) {
  const turns = useMemo(() => turnSummaries(items), [items])
  const [pos, setPos] = useState({ active: 0, pinned: false })
  const [hover, setHover] = useState<number | null>(null)

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    let raf = 0
    const measure = () => {
      raf = 0
      const nodes = promptTops(el)
      if (!nodes.length) return
      const tops = nodes.map((n) => offsetIn(el, n))
      const active = currentTurn(tops, el.scrollTop, { height: el.clientHeight, scrollHeight: el.scrollHeight })
      const pinned = tops[active] + nodes[active].offsetHeight < el.scrollTop + 4
      setPos((p) => (p.active === active && p.pinned === pinned ? p : { active, pinned }))
    }
    const queue = () => { if (!raf) raf = requestAnimationFrame(measure) }
    measure()
    el.addEventListener('scroll', queue, { passive: true })
    const ro = new ResizeObserver(queue)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    return () => { el.removeEventListener('scroll', queue); ro.disconnect(); if (raf) cancelAnimationFrame(raf) }
  }, [scroller, turns.length])

  if (!turns.length) return null
  const go = (i: number) => { if (scroller.current) scrollToTurn(scroller.current, i) }
  const cur = turns[Math.min(pos.active, turns.length - 1)]
  const step = Math.max(3, Math.min(14, 360 / turns.length))
  return (
    <>
      {pos.pinned && cur && (
        <button className="turn-sticky" onClick={() => go(pos.active)} title="Back to the start of this turn (⌥↑)">
          <span className="turn-sticky-n">Turn {pos.active + 1}</span>
          <span className="turn-sticky-text">{cur.prompt}</span>
        </button>
      )}
      {turns.length > 1 && (
        <nav className="turn-rail" aria-label="Turns" onMouseLeave={() => setHover(null)}>
          {turns.map((t, i) => (
            <button
              key={i}
              className={`turn-tick${i === pos.active ? ' on' : ''}`}
              style={{ height: step }}
              aria-label={`Turn ${i + 1}: ${t.prompt}`}
              onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              onClick={() => go(i)}
            >
              <span />
              {hover === i && (
                <span className="turn-tip" role="tooltip">
                  <span className="turn-tip-n">Turn {i + 1} of {turns.length}</span>
                  <span className="turn-tip-q">{t.prompt}</span>
                  {t.reply && <span className="turn-tip-a">{t.reply}</span>}
                </span>
              )}
            </button>
          ))}
        </nav>
      )}
    </>
  )
}
