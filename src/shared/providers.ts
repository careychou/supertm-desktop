/** Model-provider types and pure helpers, shared by the engine router, main process and renderer. */

export type ProviderKind = 'openai' | 'azure' | 'vertex'

/** One configured model provider (Settings → Model providers). */
export interface ProviderEntry {
  id: string
  name: string
  kind: ProviderKind
  /** OpenAI-compatible base URL, or the Azure resource host (https://<resource>.openai.azure.com). */
  baseUrl: string
  apiKey: string
  /** Azure only. */
  apiVersion?: string
  /** Azure only: deployment names (each is a model in the picker). */
  deployments?: string[]
  /** Azure only (usage tab): full ARM resource id; blank = found by the host's resource name via Resource Graph. */
  armResourceId?: string
  /** Azure only (usage tab): Entra service principal. Blank = the signed-in Azure CLI (`az login`). */
  tenantId?: string
  clientId?: string
  /** Stored encrypted, like apiKey. */
  clientSecret?: string
  /** Vertex only: GCP project id. */
  project?: string
  /** Vertex only: default region (`global` for Model Bank MaaS models). */
  location?: string
  /** Vertex only: path to a service-account JSON key (the key itself is never stored). Empty = ADC / gcloud. */
  credentialsPath?: string
  /** Vertex only: model lines, `<publisher>/<model> [@location] [describe]`. */
  models?: string[]
  /** Vertex only: model that transcribes images for text-only (`describe`) models. */
  visionModel?: string
  /** Vertex only: Claude prompt-cache TTL. */
  cacheTtl?: '5m' | '1h' | 'off'
  enabled?: boolean
}

export interface VertexModel {
  id: string; location: string; vision: true | 'describe'
  /** Text-to-speech model: the chat's last prompt is read aloud and the reply is an audio file. */
  tts?: { voice: string }
}

export const DEFAULT_TTS_VOICE = 'Kore'
/** Gemini prebuilt voices (the first few are shown in hints). */
export const TTS_VOICES = ['Kore', 'Puck', 'Charon', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr', 'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat']

export interface SpeechPlan {
  /** Words to speak. */
  text: string
  /** Delivery instruction taken off the front of the prompt (`Say cheerfully`); never read aloud. */
  style?: string
  /** Single speaker. */
  voice?: string
  /** Two-speaker dialogue: each `Name:` line in the text is spoken by that speaker's voice. */
  speakers?: Array<{ speaker: string; voice: string }>
}

const cap = (v: string) => v.charAt(0).toUpperCase() + v.slice(1).toLowerCase()
/** A leading delivery instruction ending in a colon: `Say cheerfully:`, `Read slowly and calmly:`, `In a whisper:`. */
const STYLE = /^((?:say|read|speak|whisper|narrate|announce|tell|shout|sing|in)\b[^:\n]{0,100}):\s*/i
const LABEL = /^\s*([A-Za-z][\w .'-]{0,29}?)\s*:\s*\S/

/**
 * Reads the voice choice from a TTS prompt:
 * - `voice: Puck — Hello team` (or `voice: Puck` on its own first line) picks the voice for this message;
 * - `voices: Carey=Puck, Pearl=Kore` on the first line, then `Carey: …` / `Pearl: …` lines, is a dialogue;
 * - a script where every line is `Name: …` with exactly two names is a dialogue with default voices;
 * - after that, a leading `Say cheerfully:` style becomes `style`, so it steers delivery instead of being spoken.
 */
export function planSpeech(prompt: string, defaultVoice = DEFAULT_TTS_VOICE): SpeechPlan {
  const p = planVoice(prompt.trim(), defaultVoice)
  const st = STYLE.exec(p.text)
  if (!st) return p
  const rest = { ...p, text: p.text.slice(st[0].length).trim() }
  // A style line in front of a dialogue: the remaining lines may now form one.
  if (!rest.speakers && rest.voice === defaultVoice) { const d = planVoice(rest.text, defaultVoice); if (d.speakers) return { ...d, style: st[1].trim() } }
  return { ...rest, style: st[1].trim() }
}

/** The structured prompt Gemini TTS follows without reading the instructions aloud. */
export function speechPrompt(p: SpeechPlan): string {
  return p.style ? `### DIRECTOR'S NOTES\nStyle: ${p.style}\n\n### TRANSCRIPT\n${p.text}` : p.text
}

function planVoice(text: string, defaultVoice: string): SpeechPlan {
  const many = /^voices\s*[:=]\s*([^\n]+)\n([\s\S]*)$/i.exec(text)
  if (many) {
    const speakers = many[1].split(/[,;]/).map((x) => x.split('=').map((s) => s.trim())).filter(([s, v]) => s && v).map(([speaker, v]) => ({ speaker, voice: cap(v) }))
    if (speakers.length > 2) throw new Error('Gemini TTS dialogue supports up to 2 speakers')
    if (speakers.length === 2) return { text: many[2].trim(), speakers }
    if (speakers.length === 1) return { text: many[2].trim(), voice: speakers[0].voice }
  }
  const one = /^voice\s*[:=]\s*([A-Za-z]+)\b\s*(?:[—–:,-]+\s*)?([\s\S]*)$/i.exec(text)
  if (one && TTS_VOICES.includes(cap(one[1]))) return { text: one[2].trim(), voice: cap(one[1]) }
  const lines = text.split('\n').filter((l) => l.trim())
  const names = lines.map((l) => LABEL.exec(l)?.[1].trim())
  const distinct = [...new Set(names)]
  if (lines.length >= 2 && names.every(Boolean) && distinct.length === 2) {
    const second = TTS_VOICES.find((v) => v !== defaultVoice) ?? 'Puck'
    return { text, speakers: [{ speaker: distinct[0]!, voice: defaultVoice }, { speaker: distinct[1]!, voice: second }] }
  }
  return { text, voice: defaultVoice }
}

/** Model ids that are text-to-speech by name (`gemini-3.8-flash-tts`, `gemini-3.1-flash-tts-preview`). */
export const isTtsId = (id: string) => /-tts(-preview)?$/i.test(id)

/**
 * Parses Vertex model lines: `anthropic/claude-sonnet-5`, `google/gemini-2.5-pro @us-central1`,
 * `zai-org/glm-5.2-maas describe` (text-only: images are transcribed by the vision model),
 * `google/gemini-3.8-flash-tts voice=Puck` (text-to-speech; `tts` marks a model whose id doesn't end in -tts).
 * Blank lines and `#` comments are ignored.
 */
export function parseVertexModels(lines: string[], defaultLocation = 'global'): VertexModel[] {
  const out: VertexModel[] = []
  for (const raw of lines) {
    const toks = raw.replace(/#.*/, '').trim().split(/\s+/).filter(Boolean)
    if (!toks.length) continue
    const m: VertexModel = { id: toks[0], location: defaultLocation, vision: true }
    for (const t of toks.slice(1)) {
      if (t.startsWith('@') && t.length > 1) m.location = t.slice(1)
      else if (/^(describe|text-only|novision)$/i.test(t)) m.vision = 'describe'
      else if (/^tts$/i.test(t)) m.tts = m.tts ?? { voice: DEFAULT_TTS_VOICE }
      else if (/^voice=\S+$/i.test(t)) m.tts = { voice: t.slice(6) }
    }
    if (!m.tts && isTtsId(m.id)) m.tts = { voice: DEFAULT_TTS_VOICE }
    if (!out.some((x) => x.id === m.id)) out.push(m)
  }
  return out
}

export interface ModelGroup { provider: string; name: string; kind: ProviderKind; models: string[]; error?: string }

/** Models of every provider after the first are qualified as `<providerId>::<model>`; the first provider's stay bare (so existing chats keep working). */
export const SEP = '::'
export const qualify = (providerId: string, model: string) => `${providerId}${SEP}${model}`
export function splitModel(model: string): { provider: string | null; model: string } {
  const i = model.indexOf(SEP)
  return i > 0 ? { provider: model.slice(0, i), model: model.slice(i + SEP.length) } : { provider: null, model }
}
/** Re-expresses a stored model id after the primary provider changes: the old primary's bare ids get its prefix, the new primary's prefixed ids become bare. */
export function rehomeModel(model: string, oldHome: string | undefined, newHome: string | undefined): string {
  if (!model || oldHome === newHome) return model
  const { provider, model: bare } = splitModel(model)
  const owner = provider ?? oldHome
  if (!owner) return model
  return owner === newHome ? bare : qualify(owner, bare)
}
/** A model of a provider that no longer exists falls back to the same name on the primary (e.g. after replacing an endpoint). */
export function orphanToPrimary(model: string, ids: string[]): string {
  const { provider, model: bare } = splitModel(model)
  return provider && !ids.includes(provider) ? bare : model
}
/** Keeps the provider prefix of the requested id but names the model that actually served it (`azure::recipe_bot` + `gpt-4.1-mini` → `azure::gpt-4.1-mini`). */
export function servedModel(requested: string, served?: string): string {
  if (!served) return requested
  const { provider } = splitModel(requested)
  return provider ? qualify(provider, served) : served
}
/** The model name without any provider prefix (for display and pricing). */
export const bareModel = (model: string) => splitModel(model).model

/** Lower-case slug unique among `taken`. */
export function providerId(name: string, taken: string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'provider'
  let id = base, n = 2
  while (taken.includes(id)) id = `${base}-${n++}`
  return id
}

/**
 * Normalizes stored settings: decrypts per-provider keys, and turns the pre-0.8 single endpoint
 * (`baseUrl` + `apiKey`/`apiKeyEnc`) into the first provider entry. Pure: `dec` decrypts a stored key.
 */
export function migrateProviders(raw: Record<string, any>, fallback: ProviderEntry, dec: (enc?: string) => string | undefined): Record<string, any> & { providers?: ProviderEntry[] } {
  const { baseUrl, apiKey, apiKeyEnc, ...rest } = raw
  if (Array.isArray(rest.providers)) {
    rest.providers = rest.providers.map(({ apiKeyEnc: e, clientSecretEnc: ce, ...p }: any) => {
      const out = { ...p, apiKey: dec(e) ?? p.apiKey ?? '' }
      const cs = dec(ce) ?? p.clientSecret
      if (cs) out.clientSecret = cs
      return out
    })
  } else if (baseUrl || apiKeyEnc || apiKey) {
    const base: ProviderEntry = fallback.kind === 'openai' ? fallback : { id: fallback.id, name: 'Custom endpoint', kind: 'openai', baseUrl: '', apiKey: '' }
    rest.providers = [{ ...base, baseUrl: baseUrl ?? base.baseUrl, apiKey: dec(apiKeyEnc) ?? apiKey ?? base.apiKey }]
  }
  return rest
}
