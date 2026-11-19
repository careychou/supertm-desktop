import type { UpdateCheck, UpdateState } from './updates'
import type { UsageReport } from './usage'
import type { AgentEvent, PermissionDecision, PermissionKind } from '../engine/types'
import type { SessionRow, FolderRow, BookmarkRow } from '../main/store'
import type { Memory } from './memory'
import type { ExternalSource, SyncCandidate, SyncChoice, SyncImportResult, SyncManifest } from './sync'
import type { Settings } from '../main/settings'
import type { ModelGroup, ProviderEntry } from './providers'
import type { Attachment } from '../engine/content'
import type { AttachMeta } from './attach'
import type { ExcelStatus } from './excel'
import type { FolderConfig, MarketPlugin, PluginResult, PluginsStatus, PluginUpdates } from './plugins'

export type { Attachment, AttachMeta }
export interface AttachInput { path?: string; name?: string; data?: Uint8Array }
export interface PreparedAttachment { id: string; att?: Attachment; meta: AttachMeta; error?: string }
export type { Memory }
export type { AgentEvent, SessionRow, FolderRow, BookmarkRow, Settings, PermissionDecision, ModelGroup, ProviderEntry }
export interface Listing { sessions: SessionRow[]; folders: FolderRow[]; bookmarks: BookmarkRow[] }
export interface CompactItem { t: 'compact'; auto: boolean; model?: string; summarized: number; dropped: number; before: number; after: number; summary: string; keptTurns?: number[]; summarizedTurns?: number[]; droppedTurns?: number[] }
export interface TurnInfo { index: number; user: string; answer: string; tools: string[]; tokens: number }
export interface TurnAnalysis { turns: TurnInfo[]; clusters: Array<{ label: string; reason?: string; turns: number[] }>; method: 'model' | 'lexical'; model: string; hasPriorSummary: boolean; tokens: number; uiTurns: number[] }

/** Messages pushed from main to renderer. */
export type PushEvent =
  | { type: 'agent'; sessionId: string; event: AgentEvent }
  | { type: 'permission'; sessionId: string; requestId: string; agentId: string; kind: PermissionKind; detail: string }
  | { type: 'ask'; sessionId: string; requestId: string; agentId: string; question: string; choices?: string[] }
  | { type: 'busy'; sessionId: string; busy: boolean }
  | ({ type: 'sessions' } & Listing)
  | { type: 'compacted'; sessionId: string; item: CompactItem; beforeTurn: number }
  | { type: 'tokens'; sessionId: string; tokens: number }
  | { type: 'usage' }
  | { type: 'pluginsStatus'; status: PluginsStatus }
  | { type: 'pluginsLog'; folder: string; line: string }
  | { type: 'pluginsOpen'; folder: string }
  | { type: 'update'; state: UpdateState }
  | { type: 'updateAvailable'; version: string }
  | { type: 'importProgress'; phase: 'scan' | 'import'; done: number; total: number }

export interface RegistryInfo { skills: Array<{ name: string; description: string; source: string }>; agents: Array<{ name: string; description: string; source: string }>; warnings: string[] }

export interface DeskApi {
  listSessions(): Promise<Listing>
  addFolder(): Promise<string | null>
  removeFolder(path: string): Promise<void>
  forkSession(id: string, turn: number): Promise<SessionRow>
  openSession(id: string): Promise<{ session: SessionRow; items: unknown[]; busy: boolean; tokens: number }>
  renameSession(id: string, title: string): Promise<void>
  reorderSession(id: string, targetId: string, before: boolean): Promise<void>
  pinSession(sessionId: string, parentId: string | null, targetId?: string | null, before?: boolean): Promise<void>
  placeBookmark(id: string, parentId: string | null, targetId: string | null, before: boolean): Promise<void>
  addBookmarkFolder(name: string, parentId: string | null): Promise<void>
  updateBookmark(id: string, patch: { name?: string; parent_id?: string | null; collapsed?: number }): Promise<void>
  removeBookmark(id: string): Promise<void>
  analyzeTurns(id: string): Promise<TurnAnalysis>
  compact(id: string, plan: { keep: number[]; summarize: number[] }): Promise<{ before: number; after: number; summarized: number; dropped: number }>
  createSession(opts: { cwd: string; model: string; reasoning?: Settings['reasoning']; mode?: Settings['defaultMode']; memory?: Memory }): Promise<SessionRow>
  setReasoning(sessionId: string, r: Settings['reasoning']): Promise<void>
  setMode(sessionId: string, m: Settings['defaultMode']): Promise<void>
  /** This chat's memory (notes + files). */
  setMemory(sessionId: string, memory: Memory): Promise<void>
  /** Memory shared by every chat in a working folder. */
  setFolderMemory(cwd: string, memory: Memory): Promise<void>
  pickMemories(): Promise<string[]>
  saveExport(name: string, markdown: string): Promise<string | null>
  copyText(text: string): Promise<void>
  revealFile(path: string): Promise<void>
  /** For each path a chat mentions (absolute, ~/ or relative to cwd): its absolute form if it exists, else null. */
  pathsExist(paths: string[], cwd: string): Promise<(string | null)[]>
  /** Opens a file a chat links to in its default app; types that could run code, or reveal=true, show it in Finder instead. */
  openPath(path: string, cwd: string, reveal?: boolean): Promise<{ ok: boolean; path: string; revealed?: boolean; error?: string }>
  loadItems(sessionId: string): Promise<unknown[]>
  deleteSession(id: string): Promise<void>
  /** Sends a prompt. While the chat is working it is queued under `qid` and joins at the next step. */
  send(sessionId: string, prompt: string, attachments?: Attachment[], qid?: string): Promise<void>
  /** Withdraws a queued prompt; false if it already reached the model. */
  unqueue(sessionId: string, qid: string): Promise<boolean>
  prepareAttachments(inputs: AttachInput[]): Promise<PreparedAttachment[]>
  pickAttachments(): Promise<PreparedAttachment[]>
  /** Absolute path of a dropped/pasted File ('' when it has none, e.g. a screenshot). */
  pathForFile(f: File): string
  stop(sessionId: string): Promise<void>
  saveItems(sessionId: string, items: unknown[]): Promise<void>
  setModel(sessionId: string, model: string): Promise<void>
  respondPermission(requestId: string, decision: PermissionDecision): Promise<void>
  respondAsk(requestId: string, answer: string): Promise<void>
  listModels(): Promise<{ models: string[]; groups: ModelGroup[]; error?: string }>
  /** Lists the models of an unsaved provider entry (Settings → Model providers → Test). */
  testProvider(p: ProviderEntry): Promise<{ models: string[]; error?: string }>
  appInfo(): Promise<AppInfo>
  /** Lists releases newer than this build (Settings → About). */
  checkUpdates(): Promise<UpdateCheck>
  updateState(): Promise<UpdateState>
  /** Downloads and verifies a release's macOS zip; progress arrives as `update` push events. */
  downloadUpdate(version: string): Promise<{ ok: boolean; error?: string }>
  cancelUpdate(): Promise<boolean>
  /** Quits, replaces this app with the downloaded one and reopens it. */
  installUpdate(): Promise<{ ok: boolean; error?: string }>
  openRelease(url: string): Promise<void>
  pickFolder(opts?: { defaultPath?: string; title?: string; buttonLabel?: string }): Promise<string | null>
  pickFile(opts?: { title?: string; extensions?: string[] }): Promise<string | null>
  getSettings(): Promise<Settings>
  getUsage(days: number): Promise<UsageReport>
  getProjectUsage(days: number): Promise<UsageReport>
  getAzureUsage(days: number): Promise<UsageReport>
  usageInfo(): Promise<{ project: string | null; azure: string | null; pricing: string | null }>
  /** Runs `az login` (browser sign-in) so the Azure usage tab can read Azure Monitor / Cost Management. */
  azureLogin(): Promise<{ ok: boolean; error?: string; cancelled?: boolean }>
  cancelAzureLogin(): Promise<boolean>
  saveSettings(s: Settings): Promise<void>
  /** Sync sessions: copy the session database (every chat, or just `ids`) plus a manifest into a folder. */
  syncExport(dir: string, ids?: string[]): Promise<SyncManifest>
  /** Lists the sessions in an exported folder, flagging UUIDs that already exist here. */
  syncScan(dir: string): Promise<{ file: string; manifest: SyncManifest | null; sessions: SyncCandidate[] }>
  syncImport(file: string, picks: Array<{ id: string; choice?: SyncChoice }>, dest?: string): Promise<SyncImportResult>
  /** Where GitHub Copilot / Claude Code keep their sessions on this Mac, when present. */
  importDefaults(): Promise<Record<ExternalSource, string | null>>
  /** Lists another tool's chats (candidate ids are Copilot session ids or Claude .jsonl paths). */
  importScan(kind: ExternalSource, dir: string): Promise<{ root: string; sessions: SyncCandidate[] }>
  /** Imports them with new UUIDs, so they never conflict. */
  importExternal(kind: ExternalSource, root: string, ids: string[], dest?: string): Promise<SyncImportResult>
  /** Omit `cwd` for personal (~/.copilot) items only. */
  registryInfo(cwd?: string): Promise<RegistryInfo>
  onPush(cb: (e: PushEvent) => void): () => void
  /** Marketplace plugins installed into a working folder's .github/. */
  plugins: PluginsApi
  excel: ExcelApi
}

export type { ExcelStatus }
export interface ExcelApi {
  /** Is Excel installed / running, and which workbooks are open. `probe` talks to Excel, which makes macOS ask for permission the first time. */
  status(probe?: boolean): Promise<ExcelStatus>
  /** A composer chip for a workbook open in Excel (sheets and current selection, not the data). */
  attach(name: string): Promise<PreparedAttachment>
}

export interface PluginsApi {
  status(folder: string): Promise<PluginsStatus>
  /** Status of every working folder with plugins. */
  statuses(): Promise<PluginsStatus[]>
  saveConfig(folder: string, c: FolderConfig): Promise<void>
  list(folder: string, force?: boolean): Promise<{ plugins: MarketPlugin[]; errors: string[] }>
  install(folder: string, name: string, marketplace: string): Promise<PluginResult>
  uninstall(folder: string, name: string): Promise<PluginResult>
  checkUpdates(folder: string): Promise<PluginUpdates | undefined>
  updateAll(folder: string): Promise<PluginResult>
}

/** Settings → About and the macOS About panel. */
export interface AppInfo {
  name: string
  version: string
  commit: string
  builtAt: string
  electron: string
  chrome: string
  node: string
  os: string
  arch: string
  dataHome: string
}
