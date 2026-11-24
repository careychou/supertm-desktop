import type { Turn } from './compact'
import type { ToolDef } from './tools/types'

/** One turn as stored in the recall index. `turn` is the 0-based turn number shown in the chat (stable across compactions). */
export interface RecallEntry { turn: number; user: string; answer: string; tools: string; ts: number }
/** A search result. `inContext` is set for the current chat only: true = still in the conversation, false = removed by compaction. */
export interface RecallHit extends RecallEntry { sessionId: string; title: string; cwd: string; current: boolean; inContext?: boolean }
export type RecallScope = 'session' | 'folder' | 'all'
/** `chat` narrows the search to chats whose name matches it (any folder). A string result is a message for the model, e.g. no chat has that name. */
export type RecallSearch = (query: string, scope: RecallScope, limit: number, chat?: string) => RecallHit[] | string

export const HINTS_OPEN = '<recall_hints>'
export const HINTS_CLOSE = '</recall_hints>'
const HINTS_RE = /\s*<recall_hints>[\s\S]*?<\/recall_hints>/g
const ATTACH_RE = /<attachment name="([^"]*)"[^>]*>[\s\S]*?<\/attachment>/g
const NOTIFY_RE = /<system_notification>[\s\S]*?<\/system_notification>/g

const STOP = new Set('thanks thank ok okay good great nice fine sure look looks looking take let lets now go ahead make want need like see yeah yep cool perfect attached file files image the a an and or but if then else for to of in on at by with from into is are was were be been it this that these those you your we our they them he she his her its as not no yes do does did can could should would will just so than too very have has had what which who when where why how all any some more most other about again also please there here get got use used using make made need want like know see let now one two'.split(' '))

/** Removes the harness-attached hint block from a user message. */
export const stripHints = (s: string) => s.replace(HINTS_RE, '')
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s)
const flat = (s: string) => s.replace(/\s+/g, ' ').trim()

/** Search terms of a text: lower-case words and numbers of 2+ characters, without common words. */
export function terms(s: string): string[] {
  return [...new Set((s.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []).filter((w) => !STOP.has(w)))]
}
const stem = (w: string) => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, '') : w)

/** FTS5 MATCH expression for a free-text query (each term quoted, joined with OR), or '' when it has no usable term. */
export function ftsQuery(q: string): string {
  return terms(q).slice(0, 24).map((t) => `"${t}"`).join(' OR ')
}

/** Index entry for one turn: the prompt (attachment bodies and hints left out), the final answer and the tool names. */
export function entryOf(t: Turn, uiTurn: number, ts: number): RecallEntry | null {
  const user = flat(stripHints(t.user).replace(NOTIFY_RE, '').replace(ATTACH_RE, '[attached: $1]'))
  const answer = flat(t.answer)
  if (!user && !answer) return null
  return { turn: uiTurn, user: clip(user, 2000), answer: clip(answer, 4000), tools: t.tools.join(' '), ts }
}

/** Index entries rebuilt from a chat's saved transcript items, for turns that compaction removed from the history before they were indexed. */
export function entriesFromItems(items: Array<{ t: string; agentId?: string; text?: string; name?: string }>, ts: number): RecallEntry[] {
  const out: RecallEntry[] = []
  let cur: { user: string; answer: string; tools: string[] } | null = null
  let turn = -1
  const flush = () => {
    if (!cur) return
    const user = flat(stripHints(cur.user)), answer = flat(cur.answer)
    if (user || answer) out.push({ turn, user: clip(user, 2000), answer: clip(answer, 4000), tools: [...new Set(cur.tools)].join(' '), ts })
  }
  for (const it of items) {
    if (it.t === 'user') { flush(); turn++; cur = { user: it.text ?? '', answer: '', tools: [] } }
    else if (!cur || (it.agentId ?? 'main') !== 'main') continue
    else if (it.t === 'assistant' && it.text?.trim()) cur.answer = it.text
    else if (it.t === 'tool' && it.name) cur.tools.push(it.name)
  }
  flush()
  return out
}

/** Share of the query's terms that appear in the hit, and how many did. */
export function coverage(query: string, hit: Pick<RecallEntry, 'user' | 'answer'>): { matched: number; share: number } {
  const q = [...new Set(terms(query).map(stem))]
  if (!q.length) return { matched: 0, share: 0 }
  const have = new Set(terms(`${hit.user} ${hit.answer}`).map(stem))
  const matched = q.filter((t) => have.has(t)).length
  return { matched, share: matched / q.length }
}

const day = (ts: number) => (ts ? new Date(ts).toISOString().slice(0, 10) : '')
const where = (h: RecallHit) =>
  h.current
    ? `this chat, turn ${h.turn + 1} (${h.inContext ? 'still in the conversation above' : 'removed by compaction'})`
    : `chat "${clip(h.title, 60)}", turn ${h.turn + 1}${h.ts ? `, ${day(h.ts)}` : ''}`

export interface HintOptions { max?: number; minMatched?: number; minShare?: number }

/**
 * Hits worth attaching to a new prompt: enough of the prompt's terms must appear in the hit (otherwise nothing is attached).
 * Callers leave out turns the model has just seen.
 */
export function pickHints(prompt: string, hits: RecallHit[], o: HintOptions = {}): RecallHit[] {
  const { max = 4, minMatched = 2, minShare = 0.5 } = o
  return hits.filter((h) => { const c = coverage(prompt, h); return c.matched >= minMatched && c.share >= minShare }).slice(0, max)
}

/** The short block attached after a prompt; '' when there is nothing to attach. */
export function formatHints(hits: RecallHit[]): string {
  if (!hits.length) return ''
  const lines = hits.map((h) => `- ${where(h)}: "${clip(h.user || h.answer, 110)}"`)
  return `${HINTS_OPEN}\nEarlier turns that may relate to this request (keyword match, added automatically — ignore them if they don't help). Call the recall tool to read one that is not in the conversation.\n${lines.join('\n')}\n${HINTS_CLOSE}`
}

/** Tool output for a search. */
export function formatResults(query: string, hits: RecallHit[]): string {
  if (!hits.length) return `No earlier turns match "${query}". Try other keywords or a wider scope ("folder" or "all").`
  return hits.map((h, i) => {
    const head = `[${i + 1}] ${where(h)}`
    if (h.current && h.inContext) return `${head}\nUSER: ${clip(h.user, 200)}\n(The full turn is in the conversation above.)`
    return `${head}\nUSER: ${clip(h.user, 600)}\nASSISTANT: ${clip(h.answer, 1500)}${h.tools ? `\nTOOLS: ${h.tools.replace(/ /g, ', ')}` : ''}`
  }).join('\n\n')
}

/** Note left in the compaction summary message so the model knows removed turns can still be searched. */
export const RECALL_NOTE_RE = /<recall_note>(\d+) earlier turn/
export const recallNote = (removed: number) =>
  `<recall_note>${removed} earlier turn${removed === 1 ? ' was' : 's were'} removed from this conversation. The summary above is lossy; the original prompts and answers can still be searched with the recall tool.</recall_note>`

export const RECALL_PROMPT = `# Recall
Every turn of every chat is kept in a searchable index, including turns that compaction removed from this conversation. Use the recall tool when the user refers to something you cannot see (an earlier decision, number, file, name or result), when a compaction summary lacks a detail you need, or when earlier work in this folder would help — and before asking the user to repeat something. Recall is not limited to this chat: when the user or the session memory names another chat ("the Vertex Model session"), call recall with that name in "chat" plus keywords. A <recall_hints> block after a prompt lists earlier turns that matched it by keyword; it is added automatically, is not written by the user, and may be irrelevant.`

export function recallTool(search: RecallSearch): ToolDef {
  return {
    name: 'recall',
    description: 'Search earlier turns of this chat and of other chats (prompts and final answers) by keyword. Finds turns that compaction removed from the conversation and work done in other chats. To search a chat the user or the session memory refers to by name, pass its name in `chat`. Use it when the user refers to something not visible in the conversation, when a summary is missing a detail, or before asking the user to repeat a fact. Results give the prompt and the answer of each matching turn; tool output is not stored. Use specific keywords (names, numbers, file names), not a full question.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords to look for, e.g. "retry limit decision" or a file name' },
        scope: { type: 'string', enum: ['session', 'folder', 'all'], description: 'session = this chat only (default); folder = every chat in this working folder; all = every chat' },
        chat: { type: 'string', description: 'Name (or part of the name) of another chat to search, as the user wrote it, e.g. "Vertex Model". Searches that chat in any folder; scope is ignored.' },
        limit: { type: 'number', description: 'Maximum results (default 5, at most 10)' }
      },
      required: ['query']
    },
    summarize: (a) => `recall "${a?.query ?? ''}"${a?.chat ? ` in "${a.chat}"` : ''}`,
    async run(a) {
      const query = String(a.query ?? '').trim()
      if (!ftsQuery(query)) return 'Give at least one keyword of 2 or more characters.'
      const scope: RecallScope = a.scope === 'folder' || a.scope === 'all' ? a.scope : 'session'
      const limit = Math.min(10, Math.max(1, Math.round(Number(a.limit) || 5)))
      const chat = String(a.chat ?? '').trim()
      const hits = search(query, scope, limit, chat || undefined)
      if (typeof hits === 'string') return hits
      if (!hits.length && chat) return `No turns in chats named "${chat}" match "${query}". Try other keywords.`
      return formatResults(query, hits)
    }
  }
}
