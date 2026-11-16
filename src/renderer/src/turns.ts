import type { Item } from './state'

export interface TurnSummary { prompt: string; reply: string }

const oneLine = (s: string, max: number) => {
  const t = s.replace(/[#>*_`]+/g, '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

/** One entry per user prompt: the prompt and the first line of the main agent's reply. */
export function turnSummaries(items: Item[]): TurnSummary[] {
  const out: TurnSummary[] = []
  for (const it of items) {
    if (it.t === 'user') out.push({ prompt: oneLine(it.text || (it.attachments ?? []).map((a) => a.name).join(', '), 160), reply: '' })
    else if (it.t === 'assistant' && it.agentId === 'main' && it.text.trim() && out.length && !out[out.length - 1].reply) {
      out[out.length - 1].reply = oneLine(it.text.split('\n').find((l) => l.trim()) ?? '', 140)
    }
  }
  return out
}

/**
 * The turn being read: the last prompt at or above the top of the view (`tops` are prompt offsets, ascending).
 * At the very bottom a short last turn can never reach the top, so the last prompt in view wins.
 */
export function currentTurn(tops: number[], scrollTop: number, view?: { height: number; scrollHeight: number }, slack = 24): number {
  let cur = 0
  for (let i = 0; i < tops.length; i++) if (tops[i] <= scrollTop + slack) cur = i
  if (view && scrollTop + view.height >= view.scrollHeight - 4) {
    for (let i = tops.length - 1; i > cur; i--) if (tops[i] < scrollTop + view.height) { cur = i; break }
  }
  return cur
}

/**
 * Where ⌥↑ / ⌥↓ go. Up first returns to the start of the turn being read when its prompt is above the view,
 * so a long reply never hides its own prompt; down goes to the next prompt.
 */
export function jumpTarget(tops: number[], scrollTop: number, dir: -1 | 1): number | null {
  if (!tops.length) return null
  const cur = currentTurn(tops, scrollTop)
  if (dir < 0) return tops[cur] < scrollTop - 8 ? cur : cur > 0 ? cur - 1 : null
  return cur + 1 < tops.length ? cur + 1 : null
}

/** Prompt offsets inside the scroller, in turn order. */
export function promptTops(scroller: HTMLElement): HTMLElement[] {
  return [...scroller.querySelectorAll<HTMLElement>('[data-turn]')]
}

export function offsetIn(scroller: HTMLElement, el: HTMLElement): number {
  return el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
}

export function scrollToTurn(scroller: HTMLElement, i: number, smooth = true) {
  const el = promptTops(scroller)[i]
  if (el) scroller.scrollTo({ top: Math.max(0, offsetIn(scroller, el) - 12), behavior: smooth ? 'smooth' : 'auto' })
}

export function jumpTurn(scroller: HTMLElement, dir: -1 | 1): boolean {
  const tops = promptTops(scroller).map((el) => offsetIn(scroller, el))
  const t = jumpTarget(tops, scroller.scrollTop, dir)
  if (t === null) { if (dir > 0) scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' }); return dir > 0 }
  scrollToTurn(scroller, t)
  return true
}
