import type { Pricing } from './usage'
import type { MarketplaceRef } from './plugins'
import type { UpdateSource } from './updates'

// Product identity. A branded build can override these values on its own branch.
export const BRAND = {
  name: 'SuperTM Desktop',
  // Display name shown in the UI and used by the agent to name itself.
  title: 'SuperTM Desktop',
  short: 'SuperTM Desktop',
  // ~/Library/Application Support/<dataDir>: Chromium caches (and the oldest data folder, migrated on launch).
  dataDir: 'supertm-desktop',
  // Chats and settings live in ~/<homeDir>/<dbFile>; <envPrefix>_HOME overrides the folder.
  homeDir: '.supertm',
  // Env vars: <envPrefix>_HOME, <envPrefix>_BASE_URL, <envPrefix>_API_KEY.
  envPrefix: 'SUPERTM',
  dbFile: 'supertm.db',
  /** Where Settings → About sends people for newer builds. */
  releasesUrl: 'https://github.com/careychou/supertm-desktop/releases',
  /** Release list that Settings → About → Check for updates reads (public GitHub, no token). */
  updates: { provider: 'github', repo: 'careychou/supertm-desktop', tagPrefix: 'v' } as UpdateSource | null,
  logo: null as string | null,
  /** Name given to the provider migrated from the old single Base URL setting. */
  defaultProviderName: 'Custom endpoint',
  /** Default name of a new Google Vertex AI provider. */
  vertexProviderName: 'Google Vertex AI',
  /** Default model for memory compaction ('' = the chat's own model). */
  defaultCompactModel: '',
  /** Prefill for a new Google Vertex AI provider (model lines: `<publisher>/<model> [@location] [describe]`). */
  vertexDefaults: { project: '', location: 'global', models: [] as string[], visionModel: '' },
  /** Built-in price table for the usage panel, used when no pricing.json is found. */
  pricing: null as Pricing | null,
  /** Per-folder plugin settings file, in <folder>/.github/ (its lock is <name>.lock.json). */
  folderConfig: 'supertm.json',
  /** Marketplaces a folder starts with (users add their own in the Plugins panel). */
  pluginMarketplaces: [] as MarketplaceRef[]
}
