import type { ChatRequest, Delta, Message } from '../types'
import { parseSSE } from './sse'

/**
 * OpenAI Responses API (/v1/responses) mapping. Used for Azure deployments that refuse function tools
 * on chat/completions (e.g. gpt-6.1-sol with reasoning). Stateless: store=false, full history each turn.
 */
export function responsesBody(req: ChatRequest, messages: Message[]): Record<string, unknown> {
  const input: unknown[] = []
  for (const m of messages) {
    if (m.role === 'system') input.push({ role: 'system', content: m.content })
    else if (m.role === 'user') {
      input.push({
        role: 'user',
        content: typeof m.content === 'string' ? m.content : m.content.map((p) =>
          p.type === 'text' ? { type: 'input_text', text: p.text } : { type: 'input_image', image_url: p.image_url.url })
      })
    } else if (m.role === 'assistant') {
      if (m.content) input.push({ role: 'assistant', content: m.content })
      for (const tc of m.tool_calls ?? []) input.push({ type: 'function_call', call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments || '{}' })
    } else input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: m.content })
  }
  const body: Record<string, any> = { model: req.model, input, stream: true, store: false, max_output_tokens: req.maxTokens ?? 16000 }
  if (req.tools?.length) body.tools = req.tools.map((t) => ({ type: 'function', name: t.function.name, description: t.function.description, parameters: t.function.parameters }))
  if (req.reasoning && req.reasoning !== 'off') body.reasoning = { effort: req.reasoning, summary: 'auto' }
  return body
}

/** Converts the Responses SSE event stream into engine deltas. */
export async function* responsesDeltas(stream: AsyncIterable<Uint8Array>): AsyncGenerator<Delta> {
  const toolIndex = new Map<number, number>()
  for await (const data of parseSSE(stream)) {
    let e: any
    try { e = JSON.parse(data) } catch { continue }
    switch (e.type) {
      case 'response.output_text.delta': if (e.delta) yield { type: 'text', text: e.delta }; break
      case 'response.reasoning_summary_text.delta': if (e.delta) yield { type: 'reasoning', text: e.delta }; break
      case 'response.reasoning_summary_part.done': yield { type: 'reasoning', text: '\n\n' }; break
      case 'response.output_item.added':
        if (e.item?.type === 'function_call') {
          const i = toolIndex.size
          toolIndex.set(e.output_index, i)
          yield { type: 'tool_call', index: i, id: e.item.call_id, name: e.item.name, args: e.item.arguments || undefined }
        }
        break
      case 'response.function_call_arguments.delta': {
        const i = toolIndex.get(e.output_index)
        if (i !== undefined && e.delta) yield { type: 'tool_call', index: i, args: e.delta }
        break
      }
      case 'response.completed':
      case 'response.incomplete': {
        const u = e.response?.usage
        if (u) yield { type: 'usage', prompt: u.input_tokens ?? 0, completion: u.output_tokens ?? 0, cached: u.input_tokens_details?.cached_tokens ?? 0, cacheWrite: u.input_tokens_details?.cache_write_tokens ?? 0 }
        yield { type: 'finish', reason: e.type === 'response.incomplete' ? 'length' : toolIndex.size ? 'tool_calls' : 'stop' }
        return
      }
      case 'response.failed':
        throw new Error(`upstream: ${e.response?.error?.message ?? 'response failed'}`)
      case 'error':
        throw new Error(`upstream: ${e.message ?? e.error?.message ?? JSON.stringify(e)}`)
    }
  }
}
