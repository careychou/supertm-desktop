/**
 * Model output caps and tool payload caps. Tool caps are app-wide settings (Settings → General → Limits),
 * applied with setToolLimits; output caps default to the model's maximum and adapt to what the provider accepts.
 */

export interface ToolLimits {
  /** Shell output kept per call (tail), in chars. */
  shellOutputChars: number
  /** Upper bound for a sync shell command's timeout, in seconds. */
  shellTimeoutMaxSec: number
  /** read_file result cap, in chars. */
  readFileChars: number
  /** Largest max_length web_fetch accepts, in chars. */
  webFetchMaxChars: number
  /** Cap per memory file/notes injected into the system prompt, in chars. */
  memoryCapChars: number
  /** Skill and agent descriptions listed in the system prompt are clipped to this many chars. */
  descriptionChars: number
}

export const DEFAULT_TOOL_LIMITS: ToolLimits = {
  shellOutputChars: 30_000,
  shellTimeoutMaxSec: 600,
  readFileChars: 50_000,
  webFetchMaxChars: 20_000,
  memoryCapChars: 60_000,
  descriptionChars: 250
}

export const toolLimits: ToolLimits = { ...DEFAULT_TOOL_LIMITS }

export function setToolLimits(l: Partial<ToolLimits>): void {
  for (const k of Object.keys(DEFAULT_TOOL_LIMITS) as (keyof ToolLimits)[]) {
    const v = Number(l[k])
    toolLimits[k] = Number.isFinite(v) && v > 0 ? v : DEFAULT_TOOL_LIMITS[k]
  }
}

/** Fallback when the model isn't recognized; a provider that accepts less is learned from its 400 reply. */
export const DEFAULT_MAX_OUTPUT = 32_000

/** Known max output tokens, first match wins (matched against the bare, lowercased model id). */
const MAX_OUTPUT: [RegExp, number][] = [
  [/claude-3-haiku|claude-3-opus|claude-3-sonnet/, 4_096],
  [/claude-3-5/, 8_192],
  [/claude-3-7/, 64_000],
  [/claude-opus-4(-[01])?(-\d{8}|@|$)/, 32_000],
  [/claude-(opus|sonnet)-4-[6-9]|claude-(opus|sonnet|haiku)-[5-9]/, 128_000],
  [/claude/, 64_000],
  [/gpt-4o|chatgpt-4o/, 16_384],
  [/gpt-4\.1/, 32_768],
  [/gpt-4-turbo|gpt-4(\b|-\d)/, 4_096],
  [/gpt-3\.5/, 4_096],
  [/\bo1-mini/, 65_536],
  [/\bo[134](\b|-)/, 100_000],
  [/gpt-[5-9]/, 128_000],
  [/gemini-(1\.|2\.0)/, 8_192],
  [/gemini/, 65_536]
]

/** Caps learned from provider rejections, by bare model id. */
const learned = new Map<string, number>()

const bare = (model: string) => (model.split('::').pop() ?? model).toLowerCase()

export function modelMaxOutput(model: string): number {
  const m = bare(model)
  return MAX_OUTPUT.find(([re]) => re.test(m))?.[1] ?? DEFAULT_MAX_OUTPUT
}

/** max_tokens to send: the requested value (or the model's max), never above what the provider has said it accepts. */
export function outputCap(model: string, requested?: number): number {
  const base = requested && requested > 0 ? requested : modelMaxOutput(model)
  const l = learned.get(bare(model))
  return l ? Math.min(base, l) : base
}

const num = (s: string) => Number(s.replace(/,/g, ''))

/**
 * Given a provider's 400 body, returns a smaller output-token value to retry with, or null if the error
 * isn't about it. A too-large value for the model is remembered; a prompt that leaves too little room in
 * the context window only shrinks this one request.
 */
export function retryOutputCap(model: string, sent: number, body: string): number | null {
  if (!/max_tokens|max_completion_tokens|max_output_tokens|maxOutputTokens|output tokens|completion tokens|context (limit|length|window)/i.test(body)) return null
  if (/unsupported.parameter|is not supported|unrecognized|unknown (field|parameter)/i.test(body)) return null
  // Anthropic: "input length and `max_tokens` exceed context limit: 150000 + 64000 > 200000"
  const sum = body.match(/([\d,]+)\s*\+\s*([\d,]+)\s*>\s*([\d,]+)/)
  // OpenAI: "maximum context length is 128000 tokens. However, you requested 140000 tokens (124000 in the messages, 16000 in the completion)"
  const oai = body.match(/maximum context length is ([\d,]+)[\s\S]*?([\d,]+) in the messages/)
  const room = sum ? num(sum[3]) - num(sum[1]) : oai ? num(oai[1]) - num(oai[2]) : NaN
  if (Number.isFinite(room)) {
    const v = room - 512
    return v >= 1024 && v < sent ? v : null
  }
  const nums = (body.match(/\d[\d,]{2,8}/g) ?? []).map(num).filter((n) => n >= 256 && n < sent)
  const next = nums.length ? Math.max(...nums) : Math.floor(sent / 2)
  if (next < 256) return null
  learned.set(bare(model), next)
  return next
}

/** Sends, and on a 400 that rejects the output-token value retries once with what the provider accepts. Mutates body[key]. */
export async function sendWithOutputRetry(model: string, body: Record<string, any>, key: string, send: () => Promise<Response>): Promise<Response> {
  const res = await send()
  if (res.status !== 400 || typeof body[key] !== 'number') return res
  const t = await res.clone().text().catch(() => '')
  const v = retryOutputCap(model, body[key], t)
  if (v === null) return res
  await res.body?.cancel().catch(() => {})
  body[key] = v
  return send()
}

/** Test hook. */
export function resetLearnedCaps(): void { learned.clear() }
