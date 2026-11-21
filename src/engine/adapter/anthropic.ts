import type { ChatRequest, ContentPart, Delta, Message, ToolSchema } from '../types'
import { outputCap } from '../limits'

/** Anthropic Messages API mapping, shared by Claude on Google Vertex and on Azure AI Foundry. */
export type AnthropicTtl = '5m' | '1h' | 'off'

const STOP: Record<string, string> = { end_turn: 'stop', max_tokens: 'length', stop_sequence: 'stop', tool_use: 'tool_calls', pause_turn: 'stop', refusal: 'stop' }

const textOf = (c: string | ContentPart[] | null | undefined) =>
  c == null ? '' : typeof c === 'string' ? c : c.map((p) => (p.type === 'text' ? p.text : '')).join('')

type Block = Record<string, any>

function toBlocks(c: string | ContentPart[] | null | undefined): Block[] {
  if (c == null || typeof c === 'string') return [{ type: 'text', text: c ?? '' }]
  const out: Block[] = []
  for (const p of c) {
    if (p.type === 'text') { if (p.text) out.push({ type: 'text', text: p.text }) }
    else {
      const url = p.image_url?.url ?? ''
      const m = /^data:([^;,]*);base64,(.*)$/s.exec(url)
      if (m) out.push({ type: 'image', source: { type: 'base64', media_type: m[1] || 'image/png', data: m[2] } })
      else if (url) out.push({ type: 'image', source: { type: 'url', url } })
    }
  }
  return out.length ? out : [{ type: 'text', text: '' }]
}

/** OpenAI chat request → Anthropic Messages body (no model / anthropic_version: each host adds its own): system, tools, tool_use/tool_result, images, thinking. */
export function toAnthropic(msgs: Message[], req: Pick<ChatRequest, 'tools' | 'maxTokens' | 'reasoning'> & { model?: string }, cacheTtl: AnthropicTtl = '5m'): Record<string, any> {
  const system: string[] = []
  const out: Array<{ role: 'user' | 'assistant'; content: Block[] }> = []
  const push = (role: 'user' | 'assistant', blocks: Block[]) => {
    const last = out[out.length - 1]
    if (last?.role === role) last.content.push(...blocks)
    else out.push({ role, content: [...blocks] })
  }
  for (const m of msgs) {
    if (m.role === 'system') { if (m.content) system.push(m.content) }
    else if (m.role === 'assistant') {
      const blocks: Block[] = []
      const t = textOf(m.content)
      if (t) blocks.push({ type: 'text', text: t })
      for (const c of m.tool_calls ?? []) {
        let input: unknown = {}
        try { input = JSON.parse(c.function.arguments || '{}') } catch { /* keep {} */ }
        blocks.push({ type: 'tool_use', id: c.id, name: c.function.name, input })
      }
      push('assistant', blocks.length ? blocks : [{ type: 'text', text: '' }])
    } else if (m.role === 'tool') push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: toBlocks(m.content) }])
    else push('user', toBlocks(m.content))
  }
  const body: Record<string, any> = {
    messages: out.length ? out : [{ role: 'user', content: [{ type: 'text', text: '' }] }],
    max_tokens: outputCap(req.model ?? '', req.maxTokens)
  }
  if (system.length) body.system = system.join('\n\n')
  // Claude 5 (Vertex and Azure) only accepts adaptive thinking, and rejects temperature/top_p
  if (req.reasoning && req.reasoning !== 'off') {
    body.thinking = { type: 'adaptive', display: 'summarized' }
    body.output_config = { effort: req.reasoning }
  }
  if (req.tools?.length) body.tools = req.tools.map((t: ToolSchema) => ({ name: t.function.name, description: t.function.description ?? '', input_schema: t.function.parameters ?? { type: 'object', properties: {} } }))
  if (cacheTtl !== 'off') applyPromptCache(body, cacheTtl)
  return body
}

/**
 * Anthropic cache_control breakpoints (max 4). Prefix order is tools → system → messages, so each
 * caches everything before it: last tool, system prompt, last block of the final message (rolling
 * history), last block of the previous user turn (safety net for the 20-block lookback).
 */
export function applyPromptCache(body: Record<string, any>, ttl: '5m' | '1h'): void {
  const mark = () => (ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' })
  if (body.tools?.length) body.tools[body.tools.length - 1].cache_control = mark()
  if (typeof body.system === 'string' && body.system) body.system = [{ type: 'text', text: body.system, cache_control: mark() }]
  const msgs: Array<{ role: string; content: Block[] }> = body.messages
  const targets = msgs.length ? [msgs[msgs.length - 1]] : []
  for (let i = msgs.length - 2; i >= 0; i--) if (msgs[i].role === 'user') { targets.push(msgs[i]); break }
  for (const m of targets) {
    const b = [...m.content].reverse().find((x) => !(x.type === 'text' && !x.text))
    if (b) b.cache_control = mark()
  }
}

/** Anthropic SSE event stream → engine deltas. */
export async function* anthropicDeltas(events: AsyncIterable<string>): AsyncGenerator<Delta> {
  const tools = new Map<number, number>()
  let usage = { input: 0, read: 0, write: 0, output: 0 }
  let stop = ''
  for await (const data of events) {
    let e: any
    try { e = JSON.parse(data) } catch { continue }
    switch (e.type) {
      case 'error': throw new Error(`upstream: ${e.error?.message ?? JSON.stringify(e.error)}`)
      case 'message_start': {
        const u = e.message?.usage ?? {}
        usage = { input: u.input_tokens ?? 0, read: u.cache_read_input_tokens ?? 0, write: u.cache_creation_input_tokens ?? 0, output: u.output_tokens ?? 0 }
        break
      }
      case 'content_block_start': {
        const b = e.content_block ?? {}
        if (b.type === 'tool_use') {
          const i = tools.size
          tools.set(e.index, i)
          yield { type: 'tool_call', index: i, id: b.id, name: b.name }
        } else if (b.type === 'text' && b.text) yield { type: 'text', text: b.text }
        else if (b.type === 'thinking' && b.thinking) yield { type: 'reasoning', text: b.thinking }
        break
      }
      case 'content_block_delta': {
        const d = e.delta ?? {}
        if (d.type === 'text_delta' && d.text) yield { type: 'text', text: d.text }
        else if (d.type === 'thinking_delta' && d.thinking) yield { type: 'reasoning', text: d.thinking }
        else if (d.type === 'input_json_delta' && d.partial_json && tools.has(e.index)) yield { type: 'tool_call', index: tools.get(e.index)!, args: d.partial_json }
        break
      }
      case 'content_block_stop':
        if (tools.has(e.index)) yield { type: 'tool_call', index: tools.get(e.index)!, args: '' }
        break
      case 'message_delta': {
        const u = e.usage ?? {}
        if (u.output_tokens != null) usage.output = u.output_tokens
        if (u.input_tokens != null) usage.input = u.input_tokens
        if (u.cache_read_input_tokens != null) usage.read = u.cache_read_input_tokens
        if (u.cache_creation_input_tokens != null) usage.write = u.cache_creation_input_tokens
        if (e.delta?.stop_reason) stop = e.delta.stop_reason
        break
      }
      case 'message_stop':
        // Anthropic input_tokens excludes cached tokens; the engine's prompt count includes them
        yield { type: 'usage', prompt: usage.input + usage.read + usage.write, completion: usage.output, cached: usage.read, cacheWrite: usage.write }
        yield { type: 'finish', reason: STOP[stop] ?? 'stop' }
        return
    }
  }
}
