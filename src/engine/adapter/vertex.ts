import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatRequest, ContentPart, Delta, Message, ModelAdapter } from '../types'
import { parseSSE } from './sse'
import { filesAsText, fitRequest, type RequestBudget } from '../content'
import { OpenAIAdapter } from './openai'
import { VertexAuth } from './vertex-auth'
import { anthropicDeltas, toAnthropic, type AnthropicTtl } from './anthropic'
import { parseVertexModels, planSpeech, speechPrompt, type VertexModel } from '../../shared/providers'
import { stripHints } from '../recall'
import { sendWithOutputRetry } from '../limits'

export interface VertexConfig {
  project: string
  /** Default region for models without their own (`global` for the Model Bank MaaS models). */
  location?: string
  /** Service-account (or ADC) JSON path; empty = $GOOGLE_APPLICATION_CREDENTIALS / gcloud ADC. */
  credentialsPath?: string
  /** Raw model lines (`id [@location] [describe]`), see parseVertexModels. */
  models: string[]
  /** Model that transcribes images for text-only (`describe`) models. */
  visionModel?: string
  /** Claude prompt-cache TTL; `off` disables cache breakpoints. */
  cacheTtl?: AnthropicTtl
  budget?: () => RequestBudget
  /** Where text-to-speech audio is saved (default: the OS temp folder). */
  mediaDir?: string
  /** Tests only: replaces https://{loc-}aiplatform.googleapis.com. */
  endpoint?: string
}

export { toAnthropic, anthropicDeltas, applyPromptCache } from './anthropic'

export const DEFAULT_VISION_MODEL = 'google/gemini-3.8-flash'
const ANTHROPIC_VERSION = 'vertex-2023-10-16'

const DESCRIBE_PROMPT =
  'You are the eyes for a text-only AI model that cannot see this image. Produce a complete, faithful text rendition of it: ' +
  '(1) transcribe ALL visible text verbatim, preserving structure (headings, tables as markdown, lists, labels, numbers, units); ' +
  '(2) describe layout, charts (axes, series, values, trends), diagrams, UI elements, colors and any other visual content. ' +
  'Be exhaustive and precise; do not add commentary or speculation.'

const textOf = (c: string | ContentPart[] | null | undefined) =>
  c == null ? '' : typeof c === 'string' ? c : c.map((p) => (p.type === 'text' ? p.text : '')).join('')

const VERTEX_EFFORT: Record<string, string> = { off: '', low: 'low', medium: 'medium', high: 'high' }

/** Native Google Vertex AI provider: Claude via Anthropic streamRawPredict, everything else via the OpenAI-compatible endpoint. */
export class VertexAdapter implements ModelAdapter {
  readonly auth: VertexAuth
  private oai = new Map<string, OpenAIAdapter>()
  private described = new Map<string, string>()

  constructor(private cfg: VertexConfig) {
    this.auth = new VertexAuth(cfg.credentialsPath ?? '')
  }

  private get models(): VertexModel[] { return parseVertexModels(this.cfg.models, this.cfg.location || 'global') }
  private model(id: string): VertexModel { return this.models.find((m) => m.id === id) ?? { id, location: this.cfg.location || 'global', vision: true } }

  private host(loc: string): string {
    if (this.cfg.endpoint) return this.cfg.endpoint.replace(/\/$/, '')
    return loc === 'global' ? 'https://aiplatform.googleapis.com' : `https://${loc}-aiplatform.googleapis.com`
  }
  private base(loc: string): string {
    if (!this.cfg.project.trim()) throw new Error('GCP project is not set')
    return `${this.host(loc)}/v1/projects/${encodeURIComponent(this.cfg.project.trim())}/locations/${encodeURIComponent(loc)}`
  }

  async listModels(): Promise<string[]> {
    if (!this.cfg.project.trim()) throw new Error('GCP project is not set')
    return this.models.map((m) => m.id)
  }

  /** Settings → Test: mint a token, then a 1-token request to the first model to prove project access. */
  async verify(): Promise<string[]> {
    const ms = await this.listModels()
    if (!ms.length) throw new Error('no models configured')
    await this.auth.token(true)
    const probe = ms.find((m) => !m.startsWith('anthropic/') && !this.model(m).tts) ?? ms[0]
    for await (const _ of this.stream({ model: probe, messages: [{ role: 'user', content: 'ping' }], maxTokens: 1 }, AbortSignal.timeout(30_000))) { /* drain */ }
    return ms
  }

  /** POST with a Bearer token: refresh once on 401, back off on 429/503. */
  private async post(url: string, body: unknown, signal: AbortSignal): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      const tok = await this.auth.token(attempt === 2)
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: JSON.stringify(body), signal })
      if (r.ok || attempt >= 4 || ![401, 429, 503].includes(r.status) || (r.status === 401 && attempt >= 2)) return r
      await r.body?.cancel().catch(() => {})
      await new Promise((res) => setTimeout(res, r.status === 401 ? 0 : 600 * attempt))
    }
  }

  async *stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<Delta> {
    const m = this.model(req.model)
    if (m.tts) { yield* this.speech(m, req, signal); return }
    let messages = this.cfg.budget ? fitRequest(req.messages, this.cfg.budget()) : req.messages
    const claude = m.id.startsWith('anthropic/')
    // only Claude reads a PDF as a file; every other model gets its text
    if (!claude || m.vision === 'describe') messages = filesAsText(messages)
    if (m.vision === 'describe') messages = await this.describeImages(messages, signal)
    if (claude) yield* this.claude(m, { ...req, messages }, signal)
    else yield* this.openapi(m, { ...req, messages }, signal)
  }

  private async *claude(m: VertexModel, req: ChatRequest, signal: AbortSignal): AsyncIterable<Delta> {
    const body = { ...toAnthropic(req.messages, req, this.cfg.cacheTtl ?? '5m'), anthropic_version: ANTHROPIC_VERSION, stream: true }
    const slug = m.id.slice('anthropic/'.length)
    const res = await sendWithOutputRetry(req.model, body, 'max_tokens', () => this.post(`${this.base(m.location)}/publishers/anthropic/models/${encodeURIComponent(slug)}:streamRawPredict`, body, signal))
    if (!res.ok || !res.body) throw await httpError(res)
    yield* anthropicDeltas(parseSSE(res.body as unknown as AsyncIterable<Uint8Array>))
  }

  private openapi(m: VertexModel, req: ChatRequest, signal: AbortSignal): AsyncIterable<Delta> {
    let a = this.oai.get(m.location)
    if (!a) {
      a = new OpenAIAdapter({
        baseUrl: `${this.base(m.location)}/endpoints/openapi`,
        apiKey: '',
        fetch: (url, init) => this.post(url, JSON.parse(String(init.body)), init.signal as AbortSignal),
        shape: (body) => {
          // Vertex rejects include_reasoning; Gemini only streams thoughts via thinking_config (not alongside reasoning_effort)
          const want = body.include_reasoning
          delete body.include_reasoning
          if (typeof body.reasoning_effort === 'string') body.reasoning_effort = VERTEX_EFFORT[body.reasoning_effort] || undefined
          if (want && String(body.model).startsWith('google/gemini')) {
            delete body.reasoning_effort
            body.extra_body = { google: { thinking_config: { include_thoughts: true } } }
          }
        }
      })
      this.oai.set(m.location, a)
    }
    return a.stream(req, signal)
  }

  /**
   * Text-to-speech (native generateContent with AUDIO output). Reads the last prompt aloud, saves a WAV in
   * mediaDir and replies with a player link. History, system prompt and tools don't apply to a TTS model.
   */
  private async *speech(m: VertexModel, req: ChatRequest, signal: AbortSignal): AsyncIterable<Delta> {
    const last = [...req.messages].reverse().find((x) => x.role === 'user')
    const plan = planSpeech(stripHints(textOf(last?.content)), m.tts!.voice)
    const text = plan.text
    if (!text) throw new Error(`${m.id} reads text aloud: type the text (you can add a style, e.g. "Say warmly: …")`)
    const [pub, slug] = m.id.includes('/') ? [m.id.slice(0, m.id.indexOf('/')), m.id.slice(m.id.indexOf('/') + 1)] : ['google', m.id]
    const pv = (v: string) => ({ prebuiltVoiceConfig: { voiceName: v } })
    const speechConfig = plan.speakers
      ? { multiSpeakerVoiceConfig: { speakerVoiceConfigs: plan.speakers.map((s) => ({ speaker: s.speaker, voiceConfig: pv(s.voice) })) } }
      : { voiceConfig: pv(plan.voice!) }
    const voice = plan.speakers ? `voices ${plan.speakers.map((s) => `${s.speaker}=${s.voice}`).join(', ')}` : `voice ${plan.voice}`
    const body = { contents: [{ role: 'user', parts: [{ text: speechPrompt(plan) }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig } }
    const res = await this.post(`${this.base(m.location)}/publishers/${encodeURIComponent(pub)}/models/${encodeURIComponent(slug)}:generateContent`, body, signal)
    if (!res.ok) throw await httpError(res)
    const j: any = await res.json()
    const part = (j.candidates?.[0]?.content?.parts ?? []).find((p: any) => p.inlineData?.data)
    if (!part) throw new Error(`${m.id} returned no audio${j.candidates?.[0]?.finishReason ? ` (${j.candidates[0].finishReason})` : ''}`)
    const wav = toWav(Buffer.from(part.inlineData.data, 'base64'), String(part.inlineData.mimeType ?? ''))
    const dir = this.cfg.mediaDir || path.join(os.tmpdir(), 'desk-media')
    fs.mkdirSync(dir, { recursive: true })
    const name = `tts-${new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}-${crypto.randomBytes(3).toString('hex')}.wav`
    const file = path.join(dir, name)
    fs.writeFileSync(file, wav)
    const secs = wav.length > 44 ? (wav.length - 44) / (wav.readUInt32LE(28) || 48000) : 0
    yield { type: 'text', text: `🔊 Read aloud by \`${m.id}\` · ${voice}${plan.style ? ` · style “${plan.style}”` : ''} · ${secs.toFixed(1)} s\n\n[${name}](${MEDIA_SCHEME}://media/${name})\n\nSaved to \`${file}\`` }
    const u = j.usageMetadata
    if (u) yield { type: 'usage', prompt: u.promptTokenCount ?? 0, completion: u.candidatesTokenCount ?? 0, model: j.modelVersion ? `${pub}/${j.modelVersion}` : undefined }
    yield { type: 'finish', reason: 'stop' }
  }

  /** Swaps image parts for text transcriptions by the vision model (cached per image). */
  private async describeImages(msgs: Message[], signal: AbortSignal): Promise<Message[]> {
    const vm = this.cfg.visionModel?.trim() || DEFAULT_VISION_MODEL
    if (this.model(vm).vision === 'describe') throw new Error(`vision model ${vm} is itself text-only`)
    return Promise.all(msgs.map(async (msg) => {
      if (msg.role !== 'user' || typeof msg.content === 'string') return msg
      if (!msg.content.some((p) => p.type === 'image_url')) return msg
      const content = await Promise.all(msg.content.map(async (p): Promise<ContentPart> => (p.type === 'image_url' ? { type: 'text', text: await this.describe(p.image_url.url, vm, signal) } : p)))
      return { ...msg, content }
    }))
  }

  private async describe(url: string, vm: string, signal: AbortSignal): Promise<string> {
    const key = crypto.createHash('sha256').update(url).digest('hex')
    const hit = this.described.get(key)
    if (hit) return hit
    let text = ''
    try {
      for await (const d of this.stream({ model: vm, messages: [{ role: 'user', content: [{ type: 'text', text: DESCRIBE_PROMPT }, { type: 'image_url', image_url: { url } }] }] }, signal)) if (d.type === 'text') text += d.text
    } catch (e) {
      if (signal.aborted) throw e
    }
    if (!text.trim()) return '[An image was attached but could not be transcribed.]'
    const out = `[Attached image — transcribed for you by ${vm}]\n${text.trim()}\n[End of image]`
    if (this.described.size > 256) this.described.clear()
    this.described.set(key, out)
    return out
  }
}

/** URL scheme the app serves saved media from (see main: only files inside mediaDir). */
export const MEDIA_SCHEME = 'desk-media'

/** Returns WAV bytes as-is; wraps raw 16-bit PCM (`audio/L16;rate=24000`, `audio/pcm`) in a WAV header. */
export function toWav(data: Buffer, mime: string): Buffer {
  if (data.subarray(0, 4).toString('ascii') === 'RIFF') return data
  const rate = Number(/rate=(\d+)/i.exec(mime)?.[1] ?? 24000)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12)
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

async function httpError(res: Response): Promise<Error> {
  const t = await res.text().catch(() => '')
  let msg = t
  try { const j = JSON.parse(t); msg = j.error?.message ?? j[0]?.error?.message ?? t } catch { /* raw */ }
  return Object.assign(new Error(`HTTP ${res.status}: ${msg.slice(0, 500)}`), { status: res.status })
}
