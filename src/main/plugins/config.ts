import fs from 'node:fs'
import path from 'node:path'
import type { FolderConfig } from '../../shared/plugins'
import { BRAND } from '../../shared/brand'

export const githubDir = (folder: string) => path.join(folder, '.github')
export const configPath = (folder: string) => path.join(githubDir(folder), BRAND.folderConfig)

export function defaultConfig(): FolderConfig {
  return { version: 1, marketplaces: JSON.parse(JSON.stringify(BRAND.pluginMarketplaces)), plugins: [], autoCheck: true }
}

/** Raw JSON of the folder's config file ({} when absent or unreadable). Keeps keys this build doesn't know. */
export function readConfigFile(folder: string): Record<string, any> {
  try { const j = JSON.parse(fs.readFileSync(configPath(folder), 'utf8')); return j && typeof j === 'object' ? j : {} } catch { return {} }
}

/** The folder's config with defaults for anything missing. */
export function loadConfig(folder: string): FolderConfig {
  const d = defaultConfig()
  const c = readConfigFile(folder)
  return {
    ...c,
    version: 1,
    marketplaces: Array.isArray(c.marketplaces) ? c.marketplaces.filter((m: any) => m?.name && m?.url) : d.marketplaces,
    plugins: Array.isArray(c.plugins) ? c.plugins.filter((p: any) => p?.name && p?.marketplace) : [],
    autoCheck: c.autoCheck ?? d.autoCheck
  }
}

/** Writes the config, keeping keys other parts of the app (or other builds) added. */
export function saveConfig(folder: string, c: FolderConfig): void {
  fs.mkdirSync(githubDir(folder), { recursive: true })
  fs.writeFileSync(configPath(folder), JSON.stringify({ ...readConfigFile(folder), ...c }, null, 2) + '\n')
}

export const hasConfig = (folder: string) => fs.existsSync(configPath(folder))
