import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BRAND } from '../shared/brand'

export interface ProviderConfig { baseUrl: string; apiKey: string }

/** Config files that may hold an api_key (first found wins). */
const KEY_FILES = [[BRAND.homeDir, 'provider.json']]

/** Default provider: an OpenAI-compatible endpoint on localhost (override with <envPrefix>_BASE_URL / <envPrefix>_API_KEY or in Settings). */
export function defaultProvider(): ProviderConfig {
  let apiKey = process.env[`${BRAND.envPrefix}_API_KEY`] ?? ''
  for (const parts of KEY_FILES) {
    if (apiKey) break
    try { apiKey = JSON.parse(fs.readFileSync(path.join(os.homedir(), ...parts), 'utf8')).api_key ?? '' } catch { /* none */ }
  }
  return { baseUrl: process.env[`${BRAND.envPrefix}_BASE_URL`] ?? 'http://127.0.0.1:4141/v1', apiKey: apiKey || 'local' }
}
