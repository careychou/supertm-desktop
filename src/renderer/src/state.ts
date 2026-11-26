import type { AgentEvent, AttachMeta } from '../../shared/api'

export type Item =
  | { t: 'user'; text: string; attachments?: AttachMeta[] }
  | { t: 'answer'; text: string }
  | { t: 'assistant'; agentId: string; text: string; reasoning: string; closed?: boolean }
  | { t: 'tool'; agentId: string; callId: string; name: string; args: string; output?: string; ok?: boolean }
  | { t: 'agent'; agentId: string; name: string; mode: string; prompt: string; status: string; finalText: string; children: Item[] }
  | { t: 'error'; text: string }
  /** A model call is being tried again; shown while it waits, removed once a reply, step or error arrives. */
  | { t: 'retry'; agentId: string; text: string }
  | { t: 'compact'; auto: boolean; model?: string; summarized: number; dropped: number; before: number; after: number; summary: string; keptTurns?: number[]; summarizedTurns?: number[]; droppedTurns?: number[] }

type AgentItem = Extract<Item, { t: 'agent' }>

function findAgent(items: Item[], id: string): AgentItem | null {
  for (const it of items) {
    if (it.t === 'agent') {
      if (it.agentId === id) return it
      const f = findAgent(it.children, id)
      if (f) return f
    }
  }
  return null
}

function container(items: Item[], agentId: string): Item[] {
  if (agentId === 'main') return items
  return findAgent(items, agentId)?.children ?? items
}

function findTool(items: Item[], callId: string): Extract<Item, { t: 'tool' }> | null {
  for (const it of items) {
    if (it.t === 'tool' && it.callId === callId) return it
    if (it.t === 'agent') { const f = findTool(it.children, callId); if (f) return f }
  }
  return null
}

/** Applies an engine event to the item tree. Returns a new top-level array (children mutated in place on the clone). */
/** Removes this agent's "trying again" note, if any. */
function clearRetry(c: Item[], agentId: string) {
  for (let i = c.length - 1; i >= 0; i--) { const it = c[i]; if (it.t === 'retry' && it.agentId === agentId) c.splice(i, 1) }
}

export function applyEvent(prev: Item[], e: AgentEvent): Item[] {
  const items: Item[] = structuredClone(prev)
  if (e.kind === 'assistant_done' || e.kind === 'tool_start' || e.kind === 'error' || e.kind === 'agent_end') clearRetry(container(items, e.agentId), e.agentId)
  switch (e.kind) {
    case 'retry': {
      const c = container(items, e.agentId)
      clearRetry(c, e.agentId)
      // What the failed try streamed never reached the conversation: drop it.
      const last = c[c.length - 1]
      if (e.discarded && last?.t === 'assistant' && last.agentId === e.agentId && !last.closed) c.pop()
      c.push({ t: 'retry', agentId: e.agentId, text: `${e.reason}. Trying again in ${Math.max(1, Math.round(e.delayMs / 1000))}s (try ${e.attempt} of ${e.of})…` })
      break
    }
    case 'text':
    case 'reasoning': {
      const c = container(items, e.agentId)
      let last = c[c.length - 1]
      if (!last || last.t !== 'assistant' || last.closed || last.agentId !== e.agentId) {
        last = { t: 'assistant', agentId: e.agentId, text: '', reasoning: '' }
        c.push(last)
      }
      if (e.kind === 'text') last.text += e.text
      else last.reasoning += e.text
      break
    }
    case 'assistant_done': {
      const c = container(items, e.agentId)
      const last = c[c.length - 1]
      if (last?.t === 'assistant') last.closed = true
      break
    }
    case 'tool_start':
      if (e.name === 'task') break
      container(items, e.agentId).push({ t: 'tool', agentId: e.agentId, callId: e.callId, name: e.name, args: e.args })
      break
    case 'tool_end': {
      const t = findTool(items, e.callId)
      if (t) { t.output = e.output; t.ok = e.ok }
      break
    }
    case 'agent_start':
      container(items, e.parentId ?? 'main').push({ t: 'agent', agentId: e.agentId, name: e.name, mode: e.mode, prompt: e.prompt, status: 'running', finalText: '', children: [] })
      break
    case 'agent_end': {
      if (e.agentId === 'main') {
        if (e.status === 'cancelled') items.push({ t: 'error', text: 'Stopped.' })
        break
      }
      const a = findAgent(items, e.agentId)
      if (a) { a.status = e.status; a.finalText = e.finalText }
      break
    }
    case 'error':
      items.push({ t: 'error', text: e.message })
      break
  }
  return items
}

/** Marks anything still "running" as interrupted (used when loading a saved session). */
export function settle(items: Item[]): Item[] {
  const walk = (xs: Item[]) => xs.forEach((it) => {
    if (it.t === 'agent') { if (it.status === 'running') it.status = 'cancelled'; walk(it.children) }
    if (it.t === 'tool' && it.output === undefined) { it.output = '(interrupted)'; it.ok = false }
  })
  const drop = (xs: Item[]): Item[] => xs.filter((it) => it.t !== 'retry').map((it) => (it.t === 'agent' ? { ...it, children: drop(it.children) } : it))
  const c = drop(structuredClone(items)); walk(c); return c
}

export function runningBackground(items: Item[]): AgentItem[] {
  const out: AgentItem[] = []
  const walk = (xs: Item[]) => xs.forEach((it) => { if (it.t === 'agent') { if (it.mode === 'background' && it.status === 'running') out.push(it); walk(it.children) } })
  walk(items)
  return out
}
