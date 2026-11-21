import type { ChatRequest, Delta, Message, ModelAdapter } from '../types'
import { parseSSE } from './sse'
import { fitRequest, type RequestBudget } from '../content'
import { responsesBody, responsesDeltas } from './responses'
import { anthropicDeltas, toAnthropic, type AnthropicTtl } from './anthropic'
import { outputCap, sendWithOutputRetry } from '../limits'

export interface AdapterConfig {
  baseUrl: string
  apiKey: string
  /** `openai` (default): any OpenAI-compatible endpoint. `azure`: Azure OpenAI deployments. */
  kind?: 'openai' | 'azure'
  /** Azure: api-version query parameter. */
  apiVersion?: string
  /** Azure: deployment names, used as the model ids. */
  deployments?: string[]
  /** Read on every request so settings changes apply to open chats. */
  budget?: () => RequestBudget
  /** Replaces fetch for the chat call (Vertex: Bearer token refresh + retries). */
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  /** Last-moment edit of the request body (Vertex: reasoning field rules). */
  shape?: (body: Record<string, any>) => void
  /** Azure Claude deployments: prompt-cache TTL (`off` disables cache breakpoints). */
  cacheTtl?: AnthropicTtl
}

/** Strips engine-only fields before sending messages upstream. */
// Gemini rejects a tool-call turn sent back without its thought_signature; other endpoints may reject the unknown field
function wireMessages(msgs: Message[], budget?: RequestBudget, keepExtra = false): unknown[] {
  return fitMessages(msgs, budget).map((m) => {
    if (m.role === 'assistant') {
      const { reasoning: _r, ...rest } = m
      if (!keepExtra && rest.tool_calls?.some((c) => c.extra_content !== undefined)) rest.tool_calls = rest.tool_calls.map(({ extra_content: _x, ...c }) => c)
      return rest
    }
    return m
  })
}

export const AZURE_API_VERSION = '2025-04-01-preview'
/** anthropic-version header for Claude on Azure AI Foundry. */
export const AZURE_ANTHROPIC_VERSION = '2023-06-01'

/** Azure deployments served only by the Anthropic Messages API (Claude), judged by name. */
export const isAzureClaude = (deployment: string) => /(^|[-_/])claude/i.test(deployment)

/** Azure resource host without trailing slash or /openai suffix. */
const azureHost = (u: string) => u.trim().replace(/\/+$/, '').replace(/\/openai(\/v1)?$/, '')

export class OpenAIAdapter implements ModelAdapter {
  /** Azure deployments that refused function tools on chat/completions; they go to /openai/v1/responses. */
  private responsesOnly = new Set<string>()
  /** Azure deployments answered by /anthropic/v1/messages: Claude by name, or any that 404s on chat/completions. */
  private anthropic = new Set<string>()
  constructor(private cfg: AdapterConfig) {}

  private get azure() { return this.cfg.kind === 'azure' }

  private headers(): Record<string, string> {
    return this.azure ? { 'api-key': this.cfg.apiKey } : { authorization: `Bearer ${this.cfg.apiKey}` }
  }

  private chatUrl(model: string): string {
    if (!this.azure) return `${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`
    return `${azureHost(this.cfg.baseUrl)}/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=${encodeURIComponent(this.cfg.apiVersion || AZURE_API_VERSION)}`
  }

  async listModels(): Promise<string[]> {
    // Azure's data plane has no deployment listing; the configured deployments are the models
    if (this.azure) {
      if (!this.cfg.baseUrl.trim()) throw new Error('resource host is not set')
      return (this.cfg.deployments ?? []).map((d) => d.trim()).filter(Boolean)
    }
    const r = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/models`, { headers: this.headers() })
    if (!r.ok) throw new Error(`models ${r.status}: ${(await r.text()).slice(0, 300)}`)
    const j: any = await r.json()
    return (j.data ?? []).map((m: any) => m.id)
  }

  async *stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<Delta> {
    if (this.azure && (this.anthropic.has(req.model) || isAzureClaude(req.model))) return yield* this.streamAnthropic(req, signal)
    if (this.azure && this.responsesOnly.has(req.model)) return yield* this.streamResponses(req, signal)
    const body: Record<string, unknown> = {
      model: req.model,
      messages: wireMessages(req.messages, this.cfg.budget?.(), req.model.startsWith('google/')),
      stream: true,
      stream_options: { include_usage: true }
    }
    // Azure reasoning models (o-series, GPT-5) only accept max_completion_tokens; all current Azure models take it
    body[this.azure ? 'max_completion_tokens' : 'max_tokens'] = outputCap(req.model, req.maxTokens)
    if (req.tools?.length) body.tools = req.tools
    if (req.reasoning && req.reasoning !== 'off') {
      body.reasoning_effort = req.reasoning
      if (!this.azure) body.include_reasoning = true
    }
    this.cfg.shape?.(body)
    const think = new ThinkSplitter()
    const post = () => (this.cfg.fetch ?? fetch)(this.chatUrl(req.model), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.headers() },
      body: JSON.stringify(body),
      signal
    })
    const tokKey = this.azure ? 'max_completion_tokens' : 'max_tokens'
    let res = await sendWithOutputRetry(req.model, body, tokKey, post)
    // Claude (and other non-OpenAI models) on Azure AI Foundry: chat/completions says "Requested API is currently not supported"
    if (this.azure && res.status === 404) {
      const t = await res.clone().text().catch(() => '')
      if (/not supported/i.test(t)) {
        this.anthropic.add(req.model)
        return yield* this.streamAnthropic(req, signal)
      }
    }
    // Some Azure models (e.g. gpt-6.1-sol) only take function tools on the Responses API
    if (this.azure && res.status === 400 && body.tools) {
      const t = await res.clone().text().catch(() => '')
      if (/\/responses/i.test(t) && /tool/i.test(t)) {
        this.responsesOnly.add(req.model)
        return yield* this.streamResponses(req, signal)
      }
    }
    // Azure non-reasoning deployments (e.g. gpt-4o) reject reasoning_effort: retry once without it
    if (this.azure && res.status === 400 && body.reasoning_effort) {
      const t = await res.clone().text().catch(() => '')
      if (/reasoning_effort|reasoning\.effort|unsupported_parameter/i.test(t)) { delete body.reasoning_effort; res = await post() }
    }
    await failIfBad(res)
    let served: string | undefined
    for await (const data of parseSSE(res.body as unknown as AsyncIterable<Uint8Array>)) {
      let j: any
      try { j = JSON.parse(data) } catch { continue }
      if (j.error) throw new Error(`upstream: ${j.error.message ?? JSON.stringify(j.error)}`)
      // Azure names the model behind the deployment (e.g. gpt-4.1-mini-2025-04-14): price by that, not the deployment name
      if (this.azure && j.model) served = j.model
      if (j.usage) {
        const d = j.usage.prompt_tokens_details ?? {}
        yield { type: 'usage', prompt: j.usage.prompt_tokens ?? 0, completion: j.usage.completion_tokens ?? 0, cached: d.cached_tokens ?? j.usage.cache_read_input_tokens ?? 0, cacheWrite: d.cache_write_tokens ?? j.usage.cache_creation_input_tokens ?? 0, ...(served ? { model: served } : {}) }
      }
      const ch = j.choices?.[0]
      if (!ch) continue
      const d = ch.delta ?? {}
      if (d.reasoning_content) yield { type: 'reasoning', text: d.reasoning_content }
      if (d.reasoning && typeof d.reasoning === 'string') yield { type: 'reasoning', text: d.reasoning }
      if (d.content) {
        // Gemini on Vertex flags thought chunks; other models may inline <think> tags
        if (d.extra_content?.google?.thought) yield { type: 'reasoning', text: d.content + '\n\n' }
        else yield* think.push(d.content)
      }
      for (const tc of d.tool_calls ?? []) {
        yield { type: 'tool_call', index: tc.index ?? 0, id: tc.id, name: tc.function?.name, args: tc.function?.arguments, ...(tc.extra_content ? { extra: tc.extra_content } : {}) }
      }
      if (ch.finish_reason) yield { type: 'finish', reason: ch.finish_reason }
    }
    yield* think.flush()
  }

  /** Claude on Azure AI Foundry: Anthropic Messages API on the same resource host and key. */
  private async *streamAnthropic(req: ChatRequest, signal: AbortSignal): AsyncIterable<Delta> {
    const body = { ...toAnthropic(fitMessages(req.messages, this.cfg.budget?.()), req, this.cfg.cacheTtl ?? '5m'), model: req.model, stream: true }
    const res = await sendWithOutputRetry(req.model, body, 'max_tokens', () => (this.cfg.fetch ?? fetch)(`${azureHost(this.cfg.baseUrl)}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.cfg.apiKey, 'anthropic-version': AZURE_ANTHROPIC_VERSION },
      body: JSON.stringify(body),
      signal
    }))
    await failIfBad(res)
    yield* anthropicDeltas(parseSSE(res.body as unknown as AsyncIterable<Uint8Array>))
  }

  private async *streamResponses(req: ChatRequest, signal: AbortSignal): AsyncIterable<Delta> {
    const body = responsesBody(req, fitMessages(req.messages, this.cfg.budget?.()))
    const res = await sendWithOutputRetry(req.model, body, 'max_output_tokens', () => (this.cfg.fetch ?? fetch)(`${azureHost(this.cfg.baseUrl)}/openai/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.headers() },
      body: JSON.stringify(body),
      signal
    }))
    await failIfBad(res)
    yield* responsesDeltas(res.body as unknown as AsyncIterable<Uint8Array>)
  }
}

const fitMessages = (msgs: Message[], budget?: RequestBudget) => (budget ? fitRequest(msgs, budget) : msgs)

async function failIfBad(res: Response): Promise<void> {
  if (res.ok && res.body) return
  const t = await res.text().catch(() => '')
  let msg = t
  try { msg = JSON.parse(t).error?.message ?? t } catch { /* raw text */ }
  throw Object.assign(new Error(`HTTP ${res.status}: ${msg.slice(0, 500)}`), { status: res.status })
}

/** Splits streamed text into reasoning (inside <think>…</think>) and visible text, across chunk boundaries. */
export class ThinkSplitter {
  private inThink = false
  private buf = ''

  push(chunk: string): Delta[] {
    const out: Delta[] = []
    this.buf += chunk
    for (;;) {
      const tag = this.inThink ? '</think>' : '<think>'
      const i = this.buf.indexOf(tag)
      if (i >= 0) {
        if (i > 0) out.push(this.emit(this.buf.slice(0, i)))
        this.buf = this.buf.slice(i + tag.length)
        this.inThink = !this.inThink
        continue
      }
      // hold back a possible partial tag at the end
      let keep = 0
      for (let k = Math.min(tag.length - 1, this.buf.length); k > 0; k--) {
        if (tag.startsWith(this.buf.slice(-k))) { keep = k; break }
      }
      const text = this.buf.slice(0, this.buf.length - keep)
      this.buf = this.buf.slice(this.buf.length - keep)
      if (text) out.push(this.emit(text))
      return out
    }
  }

  flush(): Delta[] {
    const out = this.buf ? [this.emit(this.buf)] : []
    this.buf = ''
    return out
  }

  private emit(text: string): Delta {
    return this.inThink ? { type: 'reasoning', text } : { type: 'text', text }
  }
}
