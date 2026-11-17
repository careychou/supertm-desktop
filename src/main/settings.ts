import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { app, safeStorage } from 'electron'
import { defaultProvider } from '../engine/config'
import { migrateProviders, type ProviderEntry } from '../shared/providers'
import { BRAND } from '../shared/brand'
import { DEFAULT_LIMITS, type AttachLimits } from '../shared/attach'

export interface Settings extends AttachLimits {
  /** Model providers; the first one's models appear unprefixed, others as `<id>::<model>`. */
  providers: ProviderEntry[]
  defaultModel: string
  defaultCwd: string
  maxConcurrency: number
  maxTurnsMain: number
  maxTurnsSub: number
  reasoning: 'off' | 'low' | 'medium' | 'high'
  /** Mode for new chats: autopilot runs shell/write/fetch tools without asking. */
  defaultMode: 'interactive' | 'autopilot'
  autoCompact: 'off' | 'suggest' | 'auto'
  compactThreshold: number
  compactKeepRecent: number
  /** Model used to summarize and cluster turns ('' = the chat's own model). */
  compactModel: string
  /** Auto mode: wait until the chat has been idle this long (prompt cache expired) before compacting; 0 = compact as soon as over the threshold. */
  compactIdleMinutes: number
  /** Auto mode: compact regardless of idle time above this many tokens. */
  compactHardLimit: number
  /** Auto mode: skip unless at least this many tokens would be summarized. */
  compactMinGain: number
  /** Request body cap in MB (Vertex rejects > 30 MB). */
  requestMaxMB: number
  /** Re-send images from only the last N user messages (0 = all). */
  imageTurns: number
  /** pricing.json path; blank = <data home>/pricing.json. */
  pricingPath: string
  /** Daily budget in USD for the usage ring (0 = off). */
  dailyBudget: number
  /** Excel tools: read and edit workbooks open in Excel, and .xlsx files. */
  excelEnabled: boolean
  /** Show a workbook change and wait for the user before writing it (autopilot chats never wait). */
  excelConfirm: 'ask' | 'never'
  /** Copy a workbook to name.backup.xlsx before the first edit. */
  excelBackup: boolean
}

let dir = ''
// Sealed secrets that couldn't be opened at load (keychain access refused after an update); saving writes them back unchanged instead of blanking them
const unreadable = new Map<string, { apiKeyEnc?: string; clientSecretEnc?: string }>()
/** Must be called before load/save; points settings.json at the data home. */
export function setSettingsDir(d: string): void { dir = d }
const file = () => path.join(dir || app.getPath('userData'), 'settings.json')

export function loadSettings(): Settings {
  const d = defaultProvider()
  const v = BRAND.vertexDefaults
  // a build that ships Vertex defaults starts with that provider; otherwise a generic OpenAI-compatible endpoint
  const first: ProviderEntry = v.project
    ? { id: 'default', name: BRAND.vertexProviderName, kind: 'vertex', baseUrl: '', apiKey: '', project: v.project, location: v.location, credentialsPath: '', models: [...v.models], visionModel: v.visionModel, cacheTtl: '5m' }
    : { id: 'default', name: BRAND.defaultProviderName, kind: 'openai', baseUrl: d.baseUrl, apiKey: d.apiKey }
  const defaults: Settings = { providers: [first], defaultModel: 'anthropic/claude-sonnet-5', defaultCwd: os.homedir(), maxConcurrency: 4, maxTurnsMain: 50, maxTurnsSub: 30, reasoning: 'medium', defaultMode: 'autopilot', autoCompact: 'suggest', compactThreshold: 80000, compactKeepRecent: 2, compactModel: BRAND.defaultCompactModel, compactIdleMinutes: 5, compactHardLimit: 120000, compactMinGain: 20000, ...DEFAULT_LIMITS, requestMaxMB: 20, imageTurns: 4, pricingPath: '', dailyBudget: 0, excelEnabled: true, excelConfirm: 'ask', excelBackup: true }
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'))
    const open = (enc?: string): string | undefined => {
      if (!enc || !safeStorage.isEncryptionAvailable()) return undefined
      try { return safeStorage.decryptString(Buffer.from(enc, 'base64')) } catch { return undefined }
    }
    unreadable.clear()
    for (const p of Array.isArray(raw.providers) ? raw.providers : []) {
      const keep = {
        ...(p.apiKeyEnc && open(p.apiKeyEnc) === undefined ? { apiKeyEnc: p.apiKeyEnc } : {}),
        ...(p.clientSecretEnc && open(p.clientSecretEnc) === undefined ? { clientSecretEnc: p.clientSecretEnc } : {})
      }
      if (keep.apiKeyEnc || keep.clientSecretEnc) unreadable.set(p.id, keep)
    }
    const dec = open
    return { ...defaults, ...migrateProviders(raw, defaults.providers[0], dec) }
  } catch {
    return defaults
  }
}

export function saveSettings(s: Settings): void {
  const enc = safeStorage.isEncryptionAvailable()
  const seal = (v: string) => safeStorage.encryptString(v).toString('base64')
  const out: any = {
    ...s,
    providers: s.providers.map(({ apiKey, clientSecret, ...p }) => {
      const kept = unreadable.get(p.id) ?? {}
      const key = apiKey ? (enc ? { apiKeyEnc: seal(apiKey) } : { apiKey }) : kept.apiKeyEnc ? { apiKeyEnc: kept.apiKeyEnc } : enc ? { apiKeyEnc: seal('') } : { apiKey: '' }
      const secret = clientSecret ? (enc ? { clientSecretEnc: seal(clientSecret) } : { clientSecret }) : kept.clientSecretEnc ? { clientSecretEnc: kept.clientSecretEnc } : {}
      return { ...p, ...key, ...secret }
    })
  }
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  fs.writeFileSync(file(), JSON.stringify(out, null, 2))
}
