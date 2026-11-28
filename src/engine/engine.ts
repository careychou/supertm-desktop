import { servedModel } from '../shared/providers'
import type { Hooks, Message, ModelAdapter } from './types'
import { buildUserContent, type Attachment } from './content'
import { loadRegistry, type Registry } from './registry/registry'
import { AgentManager } from './manager'
import { runLoop, AbortedError } from './loop'
import { selectTools } from './tools'
import type { ToolContext, ToolDef } from './tools/types'
import { ShellManager } from './tools/shell'
import { closeSessionDb } from './tools/sql'
import { buildMainSystem } from './prompt'
import type { Memory } from '../shared/memory'
import { applyCompaction, complete, clusterTurns, estimateTokens, planTurns, priorSummary, removedCount, splitHistoryTurns, summarizeTurns, type CompactPlan } from './compact'

export interface SessionOptions {
  adapter: ModelAdapter
  hooks: Hooks
  cwd: string
  model: string
  home?: string
  maxConcurrency?: number
  maxTurnsMain?: number
  maxTurnsSub?: number
  /** Output-token cap per model call; 0/undefined = the model's maximum. */
  maxOutputTokens?: number
  autoApprove?: boolean
  reasoning?: 'off' | 'low' | 'medium' | 'high'
  /** This chat's memory: notes plus files (usually shared chat exports). */
  memory?: Memory
  /** Memory shared by every chat in the working folder. */
  folderMemory?: Memory
  /** Per-chat folder for scratch state (sql tool database). */
  stateDir?: string
  /** Loads an image file for the model (read_file on a PNG shows the picture); without it such reads are refused. */
  loadImage?: ToolContext['loadImage']
  /** Prior conversation (without system message) to resume. */
  history?: Message[]
  /** Waits between tries of a failed model call; default RETRY_DELAYS_MS (2 s, 5 s, 10 s: four tries). */
  retryDelaysMs?: number[]
  /** Model for summarizing/clustering during compaction; read on each use. Empty = the chat's model. */
  compactModel?: () => string
  /** App-specific tools for the main agent (e.g. a branded build's installer). */
  extraTools?: ToolDef[]
  /** Tools that can change between turns (MCP servers); read at each run. A sub-agent passes its agent `tools` list. */
  dynamicTools?: (agentTools?: string[]) => ToolDef[]
  /** Extra guidance appended to the main agent's system prompt. */
  extraPrompt?: string
  /** True when the host provides a recall tool: compaction then notes that removed turns can be searched. */
  recall?: boolean
}

/** agentId used for usage events from compaction calls. */
export const COMPACT_ID = 'compact'

export const MAIN_ID = 'main'

/** One chat session: a persistent main-agent conversation plus its sub-agent tree. */
export class Session {
  readonly registry: Registry
  readonly manager: AgentManager
  readonly messages: Message[]
  readonly shells = new ShellManager()
  private busy = false
  private queue: Array<{ qid?: string; content: Message['content'] }> = []

  constructor(private o: SessionOptions) {
    this.registry = loadRegistry({ cwd: o.cwd, home: o.home })
    this.manager = new AgentManager({
      adapter: o.adapter, hooks: o.hooks, registry: this.registry, cwd: o.cwd, model: o.model,
      maxConcurrency: o.maxConcurrency ?? 4, maxTurnsSub: o.maxTurnsSub ?? 30, maxOutputTokens: o.maxOutputTokens, autoApprove: o.autoApprove, reasoning: o.reasoning ?? 'medium',
      shells: this.shells, stateDir: o.stateDir, loadImage: o.loadImage, dynamicTools: o.dynamicTools, retryDelaysMs: o.retryDelaysMs
    })
    this.messages = [{ role: 'system', content: this.system() }, ...(o.history ?? [])]
    this.manager.onBackgroundDone = (parentId) => {
      if (parentId === MAIN_ID && !this.busy) this.onIdleNotification?.()
    }
  }

  private system() {
    const base = buildMainSystem(this.registry, this.o.cwd, this.o.memory, this.o.folderMemory)
    return this.o.extraPrompt ? `${base}\n\n${this.o.extraPrompt}` : base
  }

  /** Fired when a background sub-agent finishes while the main agent is idle. */
  onIdleNotification?: () => void

  get isBusy() { return this.busy }

  setModel(model: string) { this.o.model = model; this.manager.o.model = model }
  setReasoning(r: 'off' | 'low' | 'medium' | 'high') { this.o.reasoning = r; this.manager.o.reasoning = r }
  /** Applies new limits to this chat right away, including a run in progress and its sub-agents. */
  setLimits(l: { maxConcurrency?: number; maxTurnsMain?: number; maxTurnsSub?: number; maxOutputTokens?: number }) {
    if (l.maxOutputTokens !== undefined) { this.o.maxOutputTokens = l.maxOutputTokens; this.manager.o.maxOutputTokens = l.maxOutputTokens }
    if (l.maxTurnsMain) this.o.maxTurnsMain = l.maxTurnsMain
    if (l.maxTurnsSub) { this.o.maxTurnsSub = l.maxTurnsSub; this.manager.o.maxTurnsSub = l.maxTurnsSub }
    if (l.maxConcurrency) { this.o.maxConcurrency = l.maxConcurrency; this.manager.o.maxConcurrency = l.maxConcurrency; this.manager.sem.setMax(l.maxConcurrency); this.manager.slots.setMax(l.maxConcurrency) }
  }
  /** interactive asks before shell/write/url tools; autopilot approves them automatically. */
  setMode(mode: 'interactive' | 'autopilot') { this.manager.gate.setAutoApprove(mode === 'autopilot') }
  /** Stops background shells and closes the scratch database. */
  dispose() { this.shells.dispose(); if (this.o.stateDir) closeSessionDb(this.o.stateDir) }
  /** Replaces the chat's or the folder's memory; takes effect on the next model call. */
  setMemory(kind: 'session' | 'folder', m: Memory) {
    if (kind === 'session') this.o.memory = m; else this.o.folderMemory = m
    this.messages[0] = { role: 'system', content: this.system() }
  }

  /** Prompts waiting to be added to the conversation. */
  get queued() { return this.queue.map((q) => q.qid) }

  /**
   * Sends a user prompt (or, with no prompt, just delivers pending notifications) and runs the main loop.
   * While a run is in progress the prompt is queued instead: it joins the same conversation before the
   * next model call (after the current tool results), or starts the next run if the agent has just answered.
   * `hints` (recall hints) are appended after the prompt.
   */
  async send(prompt?: string, attachments: Attachment[] = [], qid?: string, hints = ''): Promise<{ status: 'completed' | 'failed' | 'cancelled' | 'queued'; text: string }> {
    if (prompt || attachments.length) this.queue.push({ qid, content: buildUserContent(prompt ?? '', attachments, hints) as Message['content'] })
    if (this.busy) return { status: 'queued', text: '' }
    this.busy = true
    const controller = this.manager.registerMain(MAIN_ID)
    let status: 'completed' | 'failed' | 'cancelled' = 'completed'
    let text = ''
    try {
      do {
        text = await runLoop({
          agentId: MAIN_ID, model: this.o.model, adapter: this.o.adapter, sem: this.manager.sem, hooks: this.o.hooks,
          tools: [...selectTools(undefined, 0), ...(this.o.extraTools ?? []), ...(this.o.dynamicTools?.() ?? [])], signal: controller.signal, maxTurns: () => this.o.maxTurnsMain ?? 50, maxTokens: () => this.o.maxOutputTokens ?? 0, reasoning: this.o.reasoning ?? 'medium',
          ctx: { cwd: this.o.cwd, depth: 0, hooks: this.o.hooks, gate: this.manager.gate, registry: this.registry, agents: this.manager, shells: this.shells, stateDir: this.o.stateDir, loadImage: this.o.loadImage },
          drainNotifications: () => this.manager.drain(MAIN_ID),
          drainInput: () => this.drainQueue(), retryDelaysMs: this.o.retryDelaysMs
        }, this.messages)
      } while (this.queue.length)
    } catch (e: any) {
      status = e instanceof AbortedError || controller.signal.aborted ? 'cancelled' : 'failed'
      text = status === 'cancelled' ? 'cancelled' : (e?.message ?? String(e))
      if (status === 'failed') this.o.hooks.onEvent({ kind: 'error', agentId: MAIN_ID, message: text })
      this.repairHistory()
      const dropped = this.queue.splice(0).flatMap((q) => (q.qid ? [q.qid] : []))
      if (dropped.length) this.o.hooks.onEvent({ kind: 'queue_cleared', agentId: MAIN_ID, qids: dropped })
    } finally {
      this.busy = false
      this.manager.finishMain(MAIN_ID, status, text)
      this.o.hooks.onEvent({ kind: 'agent_end', agentId: MAIN_ID, status, finalText: text })
    }
    if (this.manager.hasPendingNotifications(MAIN_ID)) queueMicrotask(() => this.onIdleNotification?.())
    return { status, text }
  }

  /** Removes a queued prompt before it reaches the model. Returns false if it was already sent. */
  unqueue(qid: string) {
    const i = this.queue.findIndex((q) => q.qid === qid)
    if (i >= 0) this.queue.splice(i, 1)
    return i >= 0
  }

  private drainQueue(): Message[] {
    return this.queue.splice(0).map((q) => {
      if (q.qid) this.o.hooks.onEvent({ kind: 'user_input', agentId: MAIN_ID, qid: q.qid })
      return { role: 'user', content: q.content } as Message
    })
  }

  /** After an interruption, make sure every assistant tool_call has a matching tool result. */
  private repairHistory() {
    const last = [...this.messages].reverse().find((m) => m.role === 'assistant') as Extract<Message, { role: 'assistant' }> | undefined
    if (!last?.tool_calls) return
    const have = new Set(this.messages.filter((m) => m.role === 'tool').map((m) => (m as any).tool_call_id))
    for (const c of last.tool_calls) if (!have.has(c.id)) this.messages.push({ role: 'tool', tool_call_id: c.id, content: 'Error: cancelled' })
  }

  stop() { this.manager.cancelAll() }

  get history(): Message[] { return this.messages.slice(1) }
  get tokenEstimate() { return estimateTokens(this.messages) }

  /** The model compaction uses (Settings → Memory compaction), or the chat's own model. */
  get compactModel(): string { return this.o.compactModel?.().trim() || this.o.model }

  /** The chat adapter, reporting usage of compaction calls under COMPACT_ID. */
  private compactAdapter(model: string): ModelAdapter {
    const inner = this.o.adapter, hooks = this.o.hooks
    return {
      async *stream(req, signal) {
        for await (const d of inner.stream(req, signal)) {
          if (d.type === 'usage') hooks.onEvent({ kind: 'usage', agentId: COMPACT_ID, model: servedModel(model, d.model), prompt: d.prompt, completion: d.completion, cached: d.cached, cacheWrite: d.cacheWrite })
          yield d
        }
      }
    }
  }

  /** Runs `fn` with the compaction model, falling back to the chat model if that fails (e.g. not offered by the provider). */
  private async withCompactModel<T>(fn: (adapter: ModelAdapter, model: string) => Promise<T>): Promise<T & { model: string }> {
    const first = this.compactModel
    try { return { ...(await fn(this.compactAdapter(first), first)), model: first } } catch (e) {
      if (first === this.o.model) throw e
      return { ...(await fn(this.compactAdapter(this.o.model), this.o.model)), model: this.o.model }
    }
  }

  /** One-shot completion with the compaction model (falls back to the chat model). */
  async oneShot(system: string, user: string, signal?: AbortSignal) {
    return this.withCompactModel(async (a, m) => ({ text: await complete(a, m, [{ role: 'system', content: system }, { role: 'user', content: user }], signal) }))
  }

  /** Turn digests plus topic clusters for the compaction picker. */
  async analyzeTurns(signal?: AbortSignal) {
    const turns = splitHistoryTurns(this.history)
    let model = this.compactModel
    let { clusters, method } = await clusterTurns(this.compactAdapter(model), model, turns, signal)
    // clusterTurns swallows model errors (keyword fallback); retry once with the chat's model
    if (method === 'lexical' && model !== this.o.model && turns.length > 2 && !signal?.aborted) {
      const r = await clusterTurns(this.compactAdapter(this.o.model), this.o.model, turns, signal)
      if (r.method !== 'lexical') { ({ clusters, method } = r); model = this.o.model }
    }
    return {
      turns: turns.map((t) => ({ index: t.index, user: t.user, answer: t.answer, tools: t.tools, tokens: estimateTokens(t.messages) })),
      clusters, method, model, hasPriorSummary: !!priorSummary(this.history), tokens: this.tokenEstimate
    }
  }

  /** Keeps `plan.keep` turns verbatim, folds `plan.summarize` into the summary, drops the rest. */
  async compact(plan: CompactPlan, signal?: AbortSignal) {
    if (this.busy) throw new Error('session is busy')
    this.busy = true
    try {
      const before = this.tokenEstimate
      const turns = splitHistoryTurns(this.history)
      const { kept, summarized, dropped } = planTurns(turns, plan)
      const keptIdx = kept.map((t) => t.index)
      if (!summarized.length && !dropped.length) return { before, after: before, summarized: 0, dropped: 0, summary: '', model: '', kept: keptIdx, compacted: [] as number[] }
      const { text: summary, model } = await this.withCompactModel(async (a, m) => ({ text: await summarizeTurns(a, m, summarized, priorSummary(this.history), signal) }))
      const next = applyCompaction(this.history, summary, keptIdx, this.o.recall ? removedCount(this.history) + summarized.length + dropped.length : 0)
      this.messages.splice(1, this.messages.length - 1, ...next)
      return { before, after: this.tokenEstimate, summarized: summarized.length, dropped: dropped.length, summary, model, kept: keptIdx, compacted: [...summarized, ...dropped].map((t) => t.index) }
    } finally { this.busy = false }
  }
}
