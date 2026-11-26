import { servedModel } from '../shared/providers'
import type { Message, ModelAdapter, Hooks } from './types'
import type { ToolDef, ToolContext } from './tools/types'
import { Assembler } from './adapter/assemble'
import { toSchemas } from './tools'
import type { Semaphore } from './semaphore'
import { RETRY_DELAYS_MS, describeError, isNetworkError, isTransient, retryDelay, sleep } from './retry'

export interface LoopOptions {
  agentId: string
  model: string
  adapter: ModelAdapter
  sem: Semaphore
  hooks: Hooks
  tools: ToolDef[]
  ctx: Omit<ToolContext, 'agentId' | 'signal'>
  signal: AbortSignal
  /** A function is re-read every turn, so a changed setting reaches a running chat. */
  maxTurns: number | (() => number)
  reasoning?: 'off' | 'low' | 'medium' | 'high'
  /** Output-token cap per model call; 0/undefined = the model's maximum. Re-read every call. */
  maxTokens?: number | (() => number)
  /** Returns pending notifications to inject before the next model call. */
  drainNotifications?: () => string[]
  /** Returns user prompts queued while working, injected before the next model call. */
  drainInput?: () => Message[]
  /** Waits between tries of a failed model call (default RETRY_DELAYS_MS); its length + 1 is the number of tries. For tests. */
  retryDelaysMs?: number[]
}

export class AbortedError extends Error { constructor() { super('cancelled') } }

type Reply = Extract<Message, { role: 'assistant' }> & { truncated?: boolean }

/**
 * One model call, tried up to MODEL_ATTEMPTS times (RETRY_DELAYS_MS + 1). A dropped connection, a timeout, rate limiting, a 5xx or
 * a provider "overloaded" error is tried again after a short wait, even when part of the reply had already
 * streamed: nothing is added to the conversation until a reply is complete, so a retry simply asks again.
 * A `retry` event tells the view to drop what it streamed of the failed try. The last error keeps its
 * real cause ("terminated (other side closed, UND_ERR_SOCKET)") and says how many tries were made.
 */
async function callModel(o: LoopOptions, messages: Message[]): Promise<Reply> {
  const release = await o.sem.acquire(o.signal)
  try {
    const delays = o.retryDelaysMs ?? RETRY_DELAYS_MS
    const attempts = delays.length + 1
    let lastErr: any
    let tried = 0
    for (let attempt = 1; attempt <= attempts; attempt++) {
      tried = attempt
      const asm = new Assembler()
      const maxTokens = typeof o.maxTokens === 'function' ? o.maxTokens() : o.maxTokens
      let streamed = false
      try {
        for await (const d of o.adapter.stream({ model: o.model, messages, tools: toSchemas(o.tools), reasoning: o.reasoning, ...(maxTokens ? { maxTokens } : {}) }, o.signal)) {
          asm.push(d)
          if (d.type === 'text') { streamed = true; o.hooks.onEvent({ kind: 'text', agentId: o.agentId, text: d.text }) }
          else if (d.type === 'reasoning') { streamed = true; if (o.reasoning !== 'off') o.hooks.onEvent({ kind: 'reasoning', agentId: o.agentId, text: d.text }) }
          else if (d.type === 'usage') o.hooks.onEvent({ kind: 'usage', agentId: o.agentId, model: servedModel(o.model, d.model), prompt: d.prompt, completion: d.completion, cached: d.cached, cacheWrite: d.cacheWrite })
        }
        const msg: Reply = asm.message()
        if (asm.finishReason === 'length') msg.truncated = true
        return msg
      } catch (e: any) {
        if (o.signal.aborted) throw new AbortedError()
        lastErr = e
        if (!isTransient(e) || attempt === attempts) break
        const delayMs = retryDelay(attempt, delays)
        o.hooks.onEvent({ kind: 'retry', agentId: o.agentId, attempt: attempt + 1, of: attempts, delayMs, reason: describeError(e), discarded: streamed })
        try { await sleep(delayMs, o.signal) } catch { throw new AbortedError() }
      }
    }
    throw modelError(lastErr, tried)
  } finally {
    release()
  }
}

/** The error a run ends with: the real cause, and how many tries were made when there was more than one. */
function modelError(e: any, tried: number): Error {
  const why = describeError(e)
  const message = tried > 1
    ? `${isNetworkError(e) ? 'Lost the connection to the model' : 'The model call failed'} ${tried} times in a row. Last error: ${why}`
    : why
  return Object.assign(new Error(message, { cause: e }), e?.status !== undefined ? { status: e.status } : {})
}

const TRUNCATED = 'your reply hit the output token limit, so this tool call was cut off and NOT run. Re-issue it with less content per call: write a large file in parts (write_file with append=true for each further part), or keep the reply shorter.'

/** Required parameters absent from args (null and undefined count as absent). */
function missingArgs(tool: ToolDef, args: any): string[] {
  const req = (tool.parameters as any)?.required
  return Array.isArray(req) ? req.filter((k: string) => args?.[k] === undefined || args?.[k] === null) : []
}

async function runTool(o: LoopOptions, call: { id: string; function: { name: string; arguments: string } }, truncated = false): Promise<string> {
  const { name, arguments: raw } = call.function
  o.hooks.onEvent({ kind: 'tool_start', agentId: o.agentId, callId: call.id, name, args: raw })
  let output: string
  let ok = true
  try {
    const tool = o.tools.find((t) => t.name === name)
    if (!tool) throw new Error(`unknown tool "${name}"`)
    let args: any
    try { args = raw?.trim() ? JSON.parse(raw) : {} } catch {
      throw new Error(truncated ? TRUNCATED : `invalid JSON arguments (${raw.length} chars): ${raw.slice(0, 200)}${raw.length > 200 ? '…' : ''}`)
    }
    if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new Error('arguments must be a JSON object')
    const missing = missingArgs(tool, args)
    if (missing.length) throw new Error(truncated ? TRUNCATED : `missing required argument${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. Call ${name} again with ${missing.length > 1 ? 'them' : 'it'} set.`)
    if (tool.permission) {
      const detail = tool.summarize ? tool.summarize(args) : raw
      const allowed = await o.ctx.gate.check(o.agentId, tool.permission, detail)
      if (!allowed) throw new Error('the user denied permission for this tool call')
    }
    output = await tool.run(args, { ...o.ctx, agentId: o.agentId, signal: o.signal })
  } catch (e: any) {
    ok = false
    output = `Error: ${e?.message ?? String(e)}`
  }
  if (o.signal.aborted) { ok = false; output = 'Error: cancelled' }
  o.hooks.onEvent({ kind: 'tool_end', agentId: o.agentId, callId: call.id, name, output, ok })
  return output
}

/** Runs model/tool turns until the model answers without tool calls. Mutates `messages`. Returns final text. */
export async function runLoop(o: LoopOptions, messages: Message[]): Promise<string> {
  const max = () => typeof o.maxTurns === 'function' ? o.maxTurns() : o.maxTurns
  for (let turn = 0; turn < max(); turn++) {
    if (o.signal.aborted) throw new AbortedError()
    const notes = o.drainNotifications?.() ?? []
    if (notes.length) messages.push({ role: 'user', content: notes.map((n) => `<system_notification>${n}</system_notification>`).join('\n') })
    messages.push(...(o.drainInput?.() ?? []))
    const msg = await callModel(o, messages)
    const truncated = !!msg.truncated
    delete msg.truncated
    messages.push(msg)
    o.hooks.onEvent({ kind: 'assistant_done', agentId: o.agentId, message: msg })
    if (!msg.tool_calls?.length) return msg.content ?? ''
    if (truncated) o.hooks.onEvent({ kind: 'error', agentId: o.agentId, message: 'The model hit its output token limit mid-reply; cut-off tool calls were not run and the model was asked to retry in smaller parts.' })
    const results = await Promise.all(msg.tool_calls.map((c) => runTool(o, c, truncated)))
    msg.tool_calls.forEach((c, i) => messages.push({ role: 'tool', tool_call_id: c.id, content: results[i] }))
    if (o.signal.aborted) throw new AbortedError()
  }
  throw new Error(`stopped after reaching the max of ${max()} turns`)
}
