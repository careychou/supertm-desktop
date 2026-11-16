import { app, BrowserWindow, ipcMain, dialog, clipboard, net, protocol, shell as eshell } from 'electron'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { Store } from './store'
import { loadSettings, saveSettings, setSettingsDir, type Settings } from './settings'
import { resolveDataHome, migrateDataHome } from './datahome'
import { ProviderRouter } from '../engine/adapter/router'
import { MEDIA_SCHEME } from '../engine/adapter/vertex'
import { orphanToPrimary, rehomeModel, type ProviderEntry } from '../shared/providers'
import { COMPACT_ID, Session } from '../engine/engine'
import { loadRegistry } from '../engine/registry/registry'
import type { Message, PermissionDecision } from '../engine/types'
import type { AppInfo, CompactItem, PushEvent } from '../shared/api'
import { BRAND } from '../shared/brand'
import { parseMemory, serializeMemory, type Memory } from '../shared/memory'
import { insertBeforeTurn, liveTurnMap, orderRows, reorderIds, sliceItemsAtTurn, sliceMessagesAtTurn } from '../shared/fork'
import { prepareAttachment, type AttachInput } from './attachments'
import type { Attachment } from '../engine/content'
import { exportSessions, importSessions, resolveSyncFile, scanSessions } from './sync'
import type { ExternalSource } from '../shared/sync'
import { externalDefaults, importExternal, scanClaude, scanCopilot, copilotRoot } from './import-external'
import { azureLogin, azureUsageProvider, cancelAzureLogin, getAzureUsage, getLocalUsage, getProjectUsage, loadPricing, usageProvider } from './usage'
import { registerPlugins } from './plugins'
import { registerUpdates } from './updates'
import { autoCompactDecision, estimateTokens, keepLastPlan, splitHistoryTurns, type CompactPlan } from '../engine/compact'

// GUI apps launched from Finder get a minimal PATH; give shell tools a usable one.
process.env.PATH = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local/bin')].filter(Boolean).join(':')

let win: BrowserWindow | null = null
let store: Store
let settings: Settings
const live = new Map<string, Session>()
// Folder plugins (marketplace skills + agents in <folder>/.github/)
let plugins: ReturnType<typeof registerPlugins> | null = null
// open permission/ask prompts; Stop resolves a session's prompts with `cancel` so the run can unwind
const pending = new Map<string, { sid: string; kind: 'permission' | 'ask'; resolve: (v: any) => void; cancel: unknown }>()

const push = (e: PushEvent) => win?.webContents.send('push', e)
const listing = () => ({ sessions: store.listSessions(), folders: store.listFolders(), bookmarks: store.listBookmarks() })
const pushSessions = () => push({ type: 'sessions', ...listing() })
type Effort = Settings['reasoning']
const effortOf = (row: { reasoning?: string | null }): Effort => (row.reasoning as Effort) || settings.reasoning
type Mode = Settings['defaultMode']
const modeOf = (row: { mode?: string | null }): Mode => (row.mode as Mode) || settings.defaultMode
const stateDirOf = (id: string) => path.join(dataHome, 'sessions', id)
const folderMemoryOf = (cwd: string) => parseMemory(store.getFolder(cwd)?.memory)
const sharesDir = () => path.join(app.getPath('documents'), BRAND.name, 'shares')
const budget = () => ({ maxBytes: settings.requestMaxMB * 1024 * 1024, imageTurns: settings.imageTurns })
const router = (providers: ProviderEntry[] = settings.providers) => new ProviderRouter(providers, budget, mediaDir())
/** Delegates to a router rebuilt whenever the providers change, so open chats pick up Settings edits. */
let currentRouter: ProviderRouter | null = null
const adapter = () => ({ stream: (req: any, signal: AbortSignal) => (currentRouter ??= router()).stream(req, signal) })
/** Last main/sub-agent model call per chat: the provider's prompt cache is warm for a few minutes after it. */
const lastCall = new Map<string, number>()
const prepare = (inputs: AttachInput[]) => Promise.all(inputs.map((i) => prepareAttachment(i, settings)))

function getLive(id: string): Session {
  let s = live.get(id)
  if (s) return s
  const row = store.getSession(id)
  if (!row) throw new Error(`no session ${id}`)
  s = new Session({
    adapter: adapter(), cwd: row.cwd, model: row.model, history: store.loadMessages(id),
    maxConcurrency: settings.maxConcurrency, maxTurnsMain: settings.maxTurnsMain, maxTurnsSub: settings.maxTurnsSub, reasoning: effortOf(row), memory: parseMemory(row.memories), folderMemory: folderMemoryOf(row.cwd),
    autoApprove: modeOf(row) === 'autopilot', stateDir: stateDirOf(id), compactModel: () => settings.compactModel,
    extraTools: plugins?.tools,
    hooks: {
      onEvent: (event) => {
        if (event.kind === 'usage') {
          if (event.agentId !== COMPACT_ID) lastCall.set(id, Date.now())
          try { store.addUsage({ ts: Date.now(), session_id: id, agent_id: event.agentId, model: event.model ?? row.model, prompt: event.prompt, cached: event.cached ?? 0, cache_write: event.cacheWrite ?? 0, completion: event.completion }) } catch { /* ledger is best-effort */ }
          push({ type: 'usage' })
        }
        push({ type: 'agent', sessionId: id, event })
      },
      requestPermission: (r) => new Promise<PermissionDecision>((resolve) => {
        const requestId = randomUUID()
        pending.set(requestId, { sid: id, kind: 'permission', resolve, cancel: 'deny' })
        push({ type: 'permission', sessionId: id, requestId, ...r })
      }),
      askUser: (r) => new Promise<string>((resolve) => {
        const requestId = randomUUID()
        pending.set(requestId, { sid: id, kind: 'ask', resolve, cancel: '' })
        push({ type: 'ask', sessionId: id, requestId, ...r })
      })
    }
  })
  const sess = s
  sess.onIdleNotification = () => { void run(id, sess) }
  live.set(id, s)
  return s
}

const uiTurnCount = (id: string) => (store.loadUiItems(id) as Array<{ t: string }>).filter((i) => i.t === 'user').length
const parseMap = (j?: string | null): number[] | null => { try { return j ? JSON.parse(j) : null } catch { return null } }
/** UI turn index for each live-history turn of a session. */
const turnMapOf = (id: string, msgs: Message[]) => {
  const row = store.getSession(id)
  return liveTurnMap(splitHistoryTurns(msgs).length, parseMap(row?.turn_map), row?.compact_offset ?? 0)
}

/** Compacts a session per plan, records a marker in the UI log, and tells the renderer. */
async function compactSession(id: string, plan: CompactPlan, auto = false) {
  const s = getLive(id)
  const map = turnMapOf(id, s.history)
  const r = await s.compact(plan)
  if (!r.summarized && !r.dropped) return r
  store.setTurnMap(id, r.kept.map((i) => map[i]))
  store.saveMessages(id, s.history)
  const ui = (xs: number[]) => xs.map((i) => map[i] + 1).sort((a, b) => a - b)
  const sum = new Set(plan.summarize)
  const item: CompactItem = { t: 'compact', auto, summarized: r.summarized, dropped: r.dropped, before: r.before, after: r.after, summary: r.summary, model: r.model,
    keptTurns: ui(r.kept), summarizedTurns: ui(r.compacted.filter((i) => sum.has(i))), droppedTurns: ui(r.compacted.filter((i) => !sum.has(i))) }
  const beforeTurn = uiTurnCount(id)
  store.saveUiItems(id, insertBeforeTurn(store.loadUiItems(id) as Array<{ t: string }>, item, beforeTurn))
  push({ type: 'compacted', sessionId: id, item, beforeTurn })
  push({ type: 'tokens', sessionId: id, tokens: s.tokenEstimate })
  return r
}

async function run(id: string, s: Session, prompt?: string, atts: Attachment[] = [], qid?: string) {
  if (s.isBusy) { if (prompt || atts.length) void s.send(prompt, atts, qid); return }
  push({ type: 'busy', sessionId: id, busy: true })
  try {
    if ((prompt || atts.length) && settings.autoCompact === 'auto') {
      const turns = splitHistoryTurns(s.history)
      const last = lastCall.get(id) ?? store.getSession(id)?.updated_at ?? 0
      const d = autoCompactDecision({ mode: settings.autoCompact, tokens: s.tokenEstimate, threshold: settings.compactThreshold, hardLimit: settings.compactHardLimit,
        idleMinutes: settings.compactIdleMinutes, idleMs: Date.now() - last, turns, keepRecent: settings.compactKeepRecent, minGain: settings.compactMinGain })
      if (d.compact) {
        try { await compactSession(id, keepLastPlan(turns.length, settings.compactKeepRecent), true) }
        catch (e: any) { push({ type: 'agent', sessionId: id, event: { kind: 'error', agentId: 'main', message: `Auto-compact failed: ${e.message}` } }) }
      }
    }
    await s.send(prompt, atts, qid)
  } finally {
    store.saveMessages(id, s.messages.slice(1))
    store.touchSession(id)
    push({ type: 'busy', sessionId: id, busy: false })
    push({ type: 'tokens', sessionId: id, tokens: s.tokenEstimate })
    pushSessions()
  }
}

function registerIpc() {
  ipcMain.handle('listSessions', () => listing())
  ipcMain.handle('addFolder', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'], message: 'Choose a working folder' })
    if (r.canceled) return null
    store.addFolder(r.filePaths[0]); pushSessions()
    return r.filePaths[0]
  })
  ipcMain.handle('removeFolder', (_e, p: string) => {
    for (const s of store.listSessions().filter((x) => x.cwd === p)) { live.get(s.id)?.stop(); live.delete(s.id) }
    store.removeFolder(p); pushSessions()
  })
  ipcMain.handle('forkSession', (_e, id: string, turn: number) => {
    const src = store.getSession(id)
    if (!src) throw new Error(`no session ${id}`)
    const sess = live.get(id)
    const msgs = sess ? sess.messages.slice(1) : store.loadMessages(id)
    const now = Date.now()
    // compaction may have removed turns from the live history: map the UI turn onto the live turns that remain
    const map = turnMapOf(id, msgs)
    const upto = map.filter((u) => u <= turn)
    const compacted = !!src.turn_map || !!src.compact_offset
    const row = { id: randomUUID(), title: `${src.title.replace(/^↳ /, '')} · fork`, cwd: src.cwd, model: src.model, created_at: now, updated_at: now, parent_id: id, fork_turn: turn,
      reasoning: src.reasoning ?? null, mode: src.mode ?? null, memories: src.memories ?? null, turn_map: compacted ? JSON.stringify(upto) : null }
    store.createSession(row)
    store.saveMessages(row.id, sliceMessagesAtTurn(msgs, upto.length - 1))
    store.saveUiItems(row.id, sliceItemsAtTurn(store.loadUiItems(id) as Array<{ t: string }>, turn))
    pushSessions()
    return row
  })
  ipcMain.handle('openSession', (_e, id: string) => {
    const session = store.getSession(id)
    const l = live.get(id)
    if (session) plugins?.checkFolder(session.cwd)
    return { session, items: store.loadUiItems(id), busy: l?.isBusy ?? false, tokens: l ? l.tokenEstimate : estimateTokens(store.loadMessages(id)) }
  })
  ipcMain.handle('createSession', (_e, o: { cwd: string; model: string; reasoning?: Effort; mode?: Mode; memory?: Memory }) => {
    const now = Date.now()
    const row = { id: randomUUID(), title: 'New chat', cwd: o.cwd, model: o.model, created_at: now, updated_at: now, parent_id: null, fork_turn: null,
      reasoning: o.reasoning ?? null, mode: o.mode ?? null, memories: o.memory ? serializeMemory(o.memory) : null }
    store.createSession(row)
    plugins?.checkFolder(o.cwd)
    settings.defaultCwd = o.cwd; settings.defaultModel = o.model; saveSettings(settings)
    return row
  })
  ipcMain.handle('deleteSession', (_e, id: string) => {
    const l = live.get(id)
    l?.stop(); l?.dispose(); live.delete(id); store.deleteSession(id); pushSessions()
    fs.rmSync(stateDirOf(id), { recursive: true, force: true })
  })
  ipcMain.handle('send', (_e, id: string, prompt: string, atts: Attachment[] = [], qid?: string) => {
    const row = store.getSession(id)
    const title = prompt.trim() || atts.map((a) => a.name).join(', ')
    if (row && row.title === 'New chat' && title) store.updateSession(id, { title: title.replace(/\s+/g, ' ').slice(0, 60) })
    void run(id, getLive(id), prompt, atts, qid)
  })
  ipcMain.handle('unqueue', (_e, id: string, qid: string) => live.get(id)?.unqueue(qid) ?? false)
  ipcMain.handle('prepareAttachments', (_e, inputs: AttachInput[]) => prepare(inputs))
  ipcMain.handle('pickAttachments', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openFile', 'multiSelections'], message: 'Attach files: images, PDF, Office, text or code' })
    return r.canceled ? [] : prepare(r.filePaths.map((p) => ({ path: p })))
  })
  ipcMain.handle('stop', (_e, id: string) => {
    live.get(id)?.stop()
    for (const [rid, p] of pending) if (p.sid === id) { pending.delete(rid); p.resolve(p.cancel) }
  })
  ipcMain.handle('saveItems', (_e, id: string, items: unknown[]) => store.saveUiItems(id, items))
  ipcMain.handle('setModel', (_e, id: string, model: string) => { store.updateSession(id, { model }); live.get(id)?.setModel(model); settings.defaultModel = model; saveSettings(settings) })
  ipcMain.handle('renameSession', (_e, id: string, title: string) => { if (title.trim()) { store.updateSession(id, { title: title.trim().slice(0, 120) }); pushSessions() } })
  ipcMain.handle('reorderSession', (_e, id: string, targetId: string, before: boolean) => {
    const row = store.getSession(id), target = store.getSession(targetId)
    if (!row || !target || row.cwd !== target.cwd || (row.parent_id ?? null) !== (target.parent_id ?? null)) return
    const sibs = orderRows(store.listSessions().filter((s) => s.cwd === row.cwd && (s.parent_id ?? null) === (row.parent_id ?? null)))
    store.setOrder(reorderIds(sibs.map((s) => s.id), id, targetId, before)); pushSessions()
  })
  ipcMain.handle('pinSession', (_e, sessionId: string, parentId: string | null, targetId: string | null = null, before = false) => {
    let pid = store.pinId(sessionId)
    if (!pid) { pid = randomUUID(); store.addBookmark({ id: pid, kind: 'pin', name: null, session_id: sessionId, parent_id: parentId }) }
    store.placeBookmark(pid, parentId, targetId, before); pushSessions()
  })
  ipcMain.handle('placeBookmark', (_e, id: string, parentId: string | null, targetId: string | null, before: boolean) => { store.placeBookmark(id, parentId, targetId, before); pushSessions() })
  ipcMain.handle('addBookmarkFolder', (_e, name: string, parentId: string | null) => { store.addBookmark({ id: randomUUID(), kind: 'folder', name: name.trim() || 'New folder', session_id: null, parent_id: parentId }); pushSessions() })
  ipcMain.handle('updateBookmark', (_e, id: string, patch: { name?: string; parent_id?: string | null; collapsed?: number }) => { store.updateBookmark(id, patch); pushSessions() })
  ipcMain.handle('removeBookmark', (_e, id: string) => { store.removeBookmark(id); pushSessions() })
  ipcMain.handle('analyzeTurns', async (_e, id: string) => {
    const s = getLive(id)
    return { ...(await s.analyzeTurns()), uiTurns: turnMapOf(id, s.history) }
  })
  ipcMain.handle('compact', async (_e, id: string, plan: CompactPlan) => {
    const s = getLive(id)
    if (s.isBusy) throw new Error('Wait for the current run to finish before compacting.')
    push({ type: 'busy', sessionId: id, busy: true })
    try { return await compactSession(id, plan) } finally { push({ type: 'busy', sessionId: id, busy: false }); pushSessions() }
  })
  ipcMain.handle('setMode', (_e, id: string, m: Mode) => {
    store.updateSession(id, { mode: m }); live.get(id)?.setMode(m)
    // switching to autopilot approves whatever this chat is currently waiting on
    if (m === 'autopilot') for (const [rid, p] of pending) if (p.sid === id && p.kind === 'permission') { pending.delete(rid); p.resolve('allow') }
  })
  ipcMain.handle('setReasoning', (_e, id: string, r: Effort) => { store.updateSession(id, { reasoning: r }); live.get(id)?.setReasoning(r) })
  ipcMain.handle('setMemory', (_e, id: string, m: Memory) => {
    store.updateSession(id, { memories: serializeMemory(m) }); live.get(id)?.setMemory('session', parseMemory(serializeMemory(m))); pushSessions()
  })
  ipcMain.handle('setFolderMemory', (_e, cwd: string, m: Memory) => {
    store.setFolderMemory(cwd, serializeMemory(m))
    const fm = folderMemoryOf(cwd)
    for (const [id, l] of live) if (store.getSession(id)?.cwd === cwd) l.setMemory('folder', fm)
    pushSessions()
  })
  ipcMain.handle('pickMemories', async () => {
    fs.mkdirSync(sharesDir(), { recursive: true })
    const r = await dialog.showOpenDialog(win!, { defaultPath: sharesDir(), properties: ['openFile', 'multiSelections'], filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }], message: 'Attach files as memory (usually shared chat exports)' })
    return r.canceled ? [] : r.filePaths
  })
  ipcMain.handle('saveExport', async (_e, name: string, md: string) => {
    fs.mkdirSync(sharesDir(), { recursive: true })
    const safe = name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'session'
    const r = await dialog.showSaveDialog(win!, { defaultPath: path.join(sharesDir(), `${safe}.md`), filters: [{ name: 'Markdown', extensions: ['md'] }] })
    if (r.canceled || !r.filePath) return null
    fs.writeFileSync(r.filePath, md)
    return r.filePath
  })
  ipcMain.handle('copyText', (_e, t: string) => clipboard.writeText(t))
  ipcMain.handle('revealFile', (_e, p: string) => eshell.showItemInFolder(p))
  ipcMain.handle('loadItems', (_e, id: string) => store.loadUiItems(id))
  ipcMain.handle('respondPermission', (_e, rid: string, d: PermissionDecision) => { pending.get(rid)?.resolve(d); pending.delete(rid) })
  ipcMain.handle('respondAsk', (_e, rid: string, a: string) => { pending.get(rid)?.resolve(a); pending.delete(rid) })
  ipcMain.handle('listModels', async () => {
    const groups = await (currentRouter ??= router()).listGroups()
    const models = groups.flatMap((g) => g.models)
    const bad = groups.filter((g) => g.error)
    return { models, groups, error: !groups.length ? 'no model provider is configured' : bad.length === groups.length ? bad.map((g) => `${g.name}: ${g.error}`).join('; ') : undefined }
  })
  ipcMain.handle('testProvider', async (_e, p: ProviderEntry) => {
    const [g] = await router([{ ...p, enabled: true }]).listGroups(true)
    return { models: g?.models ?? [], error: g?.error }
  })
  ipcMain.handle('appInfo', (): AppInfo => ({
    name: BRAND.title, version: app.getVersion(), commit: typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : '',
    builtAt: typeof __BUILD_DATE__ === 'string' ? __BUILD_DATE__ : '', electron: process.versions.electron, chrome: process.versions.chrome,
    node: process.versions.node, os: `macOS ${process.getSystemVersion()}`, arch: process.arch, dataHome
  }))
  ipcMain.handle('pickFolder', async (_e, opts?: { defaultPath?: string; title?: string; buttonLabel?: string }) => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory', 'showHiddenFiles'], defaultPath: opts?.defaultPath || undefined, title: opts?.title, buttonLabel: opts?.buttonLabel })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('pickFile', async (_e, opts?: { title?: string; extensions?: string[] }) => {
    const r = await dialog.showOpenDialog(win!, { title: opts?.title, properties: ['openFile', 'showHiddenFiles'], filters: opts?.extensions ? [{ name: 'Files', extensions: opts.extensions }] : undefined })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('getSettings', () => settings)
  ipcMain.handle('getUsage', (_e, days: number) => getLocalUsage(store, days, settings.pricingPath, dataHome))
  ipcMain.handle('getProjectUsage', (_e, days: number) => getProjectUsage(settings.providers, days, settings.pricingPath, dataHome))
  ipcMain.handle('getAzureUsage', (_e, days: number) => getAzureUsage(settings.providers, days, settings.pricingPath, dataHome))
  ipcMain.handle('azureLogin', () => azureLogin(azureUsageProvider(settings.providers)))
  ipcMain.handle('cancelAzureLogin', () => cancelAzureLogin())
  ipcMain.handle('usageInfo', () => ({ project: usageProvider(settings.providers)?.project ?? null, azure: azureUsageProvider(settings.providers)?.baseUrl ?? null, pricing: loadPricing(settings.pricingPath, dataHome).path }))
  ipcMain.handle('saveSettings', (_e, s: Settings) => {
    const oldHome = settings.providers[0]?.id, newHome = s.providers[0]?.id
    const ids = s.providers.map((p) => p.id)
    if (oldHome !== newHome || settings.providers.some((p) => !ids.includes(p.id))) {
      // the primary owns unprefixed model ids: move existing chats and defaults so they keep pointing at the same provider;
      // chats of a removed provider move to the same model name on the primary
      const re = (m: string) => orphanToPrimary(rehomeModel(m, oldHome, newHome), ids)
      store.remapModels(re)
      s = { ...s, defaultModel: re(s.defaultModel), compactModel: re(s.compactModel) }
      for (const [id, sess] of live) { const m = store.getSession(id)?.model; if (m) sess.setModel(m) }
    }
    settings = s; saveSettings(s); currentRouter = null
    for (const [id, sess] of live) {
      const row = store.getSession(id)
      if (!row?.reasoning) sess.setReasoning(s.reasoning)
      if (!row?.mode) sess.setMode(s.defaultMode)
      // idle chats are rebuilt with the new provider settings; keep ones with background shells alive
      if (!sess.isBusy && !sess.shells.list().some((sh) => !sh.done)) { sess.dispose(); live.delete(id) }
    }
  })
  ipcMain.handle('syncExport', (_e, dir: string, ids?: string[]) => exportSessions(store, dir, BRAND.name, Date.now(), ids))
  ipcMain.handle('importDefaults', () => externalDefaults())
  ipcMain.handle('importScan', async (_e, kind: ExternalSource, dir: string) => {
    const root = kind === 'copilot' ? copilotRoot(dir) : dir
    return { root, sessions: kind === 'copilot' ? await scanCopilot(root) : await scanClaude(root) }
  })
  ipcMain.handle('importExternal', async (_e, kind: ExternalSource, root: string, ids: string[], dest?: string) => {
    const r = await importExternal(store, kind, root, ids, settings.defaultModel, dest)
    pushSessions()
    return r
  })
  ipcMain.handle('syncScan', (_e, dir: string) => { const file = resolveSyncFile(dir); return { file, ...scanSessions(store, file) } })
  ipcMain.handle('syncImport', (_e, file: string, picks: Array<{ id: string; choice?: 'overwrite' | 'fork' | 'skip' }>, dest?: string) => {
    // an overwritten chat must not keep running on its old history
    for (const p of picks) if (p.choice === 'overwrite') { const l = live.get(p.id); if (l?.isBusy) throw new Error('A chat you are overwriting is still running; stop it first.'); l?.dispose(); live.delete(p.id) }
    const r = importSessions(store, file, picks, stateDirOf, dest)
    pushSessions()
    return r
  })
  ipcMain.handle('registryInfo', (_e, cwd?: string) => {
    const r = loadRegistry({ cwd })
    return {
      skills: r.skills.map(({ name, description, source }) => ({ name, description, source })),
      agents: r.agents.map(({ name, description, source }) => ({ name, description, source })),
      warnings: r.warnings
    }
  })
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 820, minHeight: 560,
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 16 },
    backgroundColor: '#ffffff',
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), sandbox: false, contextIsolation: true }
  })
  win.webContents.setWindowOpenHandler(({ url }) => { void eshell.openExternal(url); return { action: 'deny' } })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

// Chromium's own caches stay in ~/Library/Application Support/<dataDir>; pinned so a product rename keeps them.
const profileDir = app.commandLine.hasSwitch('user-data-dir') ? app.getPath('userData') : undefined
const legacyDir = path.join(app.getPath('appData'), BRAND.dataDir)
if (!profileDir) app.setPath('userData', legacyDir)
// Chats + settings live in a plain dot-folder (default ~/<BRAND.homeDir>) so the CLI and agents can find them.
const dataHome = resolveDataHome({ env: process.env, home: os.homedir(), profileDir })
/** Audio made by text-to-speech models; served to the chat only through MEDIA_SCHEME. */
const mediaDir = () => path.join(dataHome, 'media')
protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])

app.whenReady().then(() => {
  app.setName(BRAND.name)
  app.setAboutPanelOptions({
    applicationName: BRAND.title, applicationVersion: app.getVersion(),
    version: [typeof __BUILD_COMMIT__ === 'string' && __BUILD_COMMIT__, typeof __BUILD_DATE__ === 'string' && __BUILD_DATE__.slice(0, 10)].filter(Boolean).join(' · ')
  })
  if (!profileDir) {
    try { const moved = migrateDataHome(legacyDir, dataHome); if (moved.length) console.log(`Copied ${moved.join(', ')} from ${legacyDir} to ${dataHome}`) }
    catch (e) { console.error('Data migration failed; starting with the new folder', e) }
  }
  // Serves only plain files directly inside mediaDir (no subfolders, no path tricks).
  protocol.handle(MEDIA_SCHEME, (req) => {
    const name = decodeURIComponent(new URL(req.url).pathname.replace(/^\//, ''))
    const file = path.join(mediaDir(), name)
    if (!name || name !== path.basename(name) || !/\.(wav|mp3|ogg)$/i.test(name) || !fs.existsSync(file)) return new Response('not found', { status: 404 })
    return net.fetch(pathToFileURL(file).toString(), { headers: req.headers })
  })
  setSettingsDir(dataHome)
  settings = loadSettings()
  store = new Store(dataHome)
  registerIpc()
  plugins = registerPlugins(ipcMain, { dataHome, push, folders: () => store.listFolders().map((f) => f.path) })
  registerUpdates(ipcMain, { push, getToken: () => undefined }).checkInBackground()
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('before-quit', () => { for (const s of live.values()) s.dispose(); plugins?.dispose() })

app.on('window-all-closed', () => {
  for (const s of live.values()) { s.stop(); s.dispose() }
  if (process.platform !== 'darwin') app.quit()
})
