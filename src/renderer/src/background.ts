import type { PushEvent } from '../../shared/api'
import { insertBeforeTurn } from '../../shared/fork'
import { applyEvent, type Item } from './state'
import type { AskReq, PermissionReq } from './components/Prompts'

/** What a chat looks like while it keeps running off-screen; only the displayed chat lives in React state. */
export interface BgView { items: Item[]; perms: PermissionReq[]; asks: AskReq[]; tokens?: number }

/** Apply a push event for a chat that is not on screen, so switching back shows everything it streamed meanwhile. */
export function applyBackground(v: BgView, p: PushEvent): BgView {
  switch (p.type) {
    case 'agent': return { ...v, items: applyEvent(v.items, p.event) }
    case 'compacted': return { ...v, items: insertBeforeTurn(v.items, p.item as unknown as Item, p.beforeTurn) }
    case 'tokens': return { ...v, tokens: p.tokens }
    case 'permission': return { ...v, perms: [...v.perms, { requestId: p.requestId, agentId: p.agentId, kind: p.kind, detail: p.detail }] }
    case 'ask': return { ...v, asks: [...v.asks, { requestId: p.requestId, agentId: p.agentId, question: p.question, choices: p.choices }] }
    case 'busy': return p.busy ? v : { ...v, perms: [], asks: [] }
    default: return v
  }
}
