import { useEffect, useRef } from 'react'

// Only the most recently opened layer reacts, so Esc in a menu over a dialog closes just the menu.
const stack: symbol[] = []

export function useEscape(onEscape: () => void, enabled = true): void {
  const cb = useRef(onEscape)
  cb.current = onEscape
  useEffect(() => {
    if (!enabled) return
    const id = Symbol('escape')
    stack.push(id)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing || stack[stack.length - 1] !== id) return
      e.preventDefault()
      e.stopPropagation()
      cb.current()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      stack.splice(stack.indexOf(id), 1)
    }
  }, [enabled])
}
