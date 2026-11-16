import { useState } from 'react'

/** Remembered per dialog: whether it fills most of the window instead of the default compact size. */
export function useExpand(key: string): [boolean, () => void] {
  const k = `expand.${key}`
  const [on, setOn] = useState(() => localStorage.getItem(k) === '1')
  const toggle = () => setOn((v) => { localStorage.setItem(k, v ? '0' : '1'); return !v })
  return [on, toggle]
}
