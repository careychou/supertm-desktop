import type { IpcMain } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpServerStatus } from '../../shared/mcp'
import { loadFolderServers, loadUserServers, readServerEntry, removeServerEntry, saveServerEntry, serverKey, userConfigFiles } from './config'
import { McpHub, type HubOptions } from './hub'

export interface McpDeps {
  dataHome: string
  appName: string
  appVersion: string
  homeDir: string
  fetch: FetchLike
  openExternal(url: string): Promise<void> | void
  openFile(file: string): Promise<string>
  sealer: HubOptions['sealer']
  push(servers: McpServerStatus[]): void
  folders(): string[]
  enabled(): boolean
  maxOutputChars(): number
  explain?: HubOptions['explain']
}

/** MCP servers: IPC for Settings → MCP servers and model tools for chats. */
export function registerMcp(ipc: IpcMain, d: McpDeps) {
  let timer: NodeJS.Timeout | null = null
  // the app's own file: servers added or edited in Settings live here
  const appFile = () => userConfigFiles(os.homedir(), d.homeDir)[1]
  const rawApp = (): Record<string, any> => {
    try { const j = JSON.parse(fs.readFileSync(appFile(), 'utf8')); return j?.mcpServers ?? j?.servers ?? {} } catch { return {} }
  }
  /** Hub status plus the app file's turned-off servers, so they can be turned back on. */
  const status = (): McpServerStatus[] => {
    const list = hub.status().map((m) => ({ ...m, editable: m.scope === 'user' && m.source === appFile() }))
    const shown = new Set(list.filter((m) => m.scope === 'user').map((m) => m.name))
    for (const [name, e] of Object.entries(rawApp())) {
      if (shown.has(name) || !e || !(e.disabled === true || e.enabled === false)) continue
      const stdio = !!e.command
      list.push({ key: serverKey({ scope: 'user', name }), name, scope: 'user', type: stdio ? 'stdio' : e.type === 'sse' ? 'sse' : 'http', target: stdio ? [e.command, ...(e.args ?? [])].join(' ') : String(e.url ?? ''), source: appFile(), state: 'disabled', tools: [], signedIn: false, oauth: !stdio, editable: true })
    }
    return list
  }
  const hub: McpHub = new McpHub({
    dataHome: d.dataHome, appName: d.appName, appVersion: d.appVersion, fetch: d.fetch, openExternal: d.openExternal, sealer: d.sealer,
    enabled: d.enabled, maxOutputChars: d.maxOutputChars, explain: d.explain,
    servers: () => [...loadUserServers(os.homedir(), d.homeDir), ...d.folders().flatMap((f) => loadFolderServers(f, os.homedir()))],
    // coalesce bursts of state changes into one push
    onChange: () => { if (!timer) timer = setTimeout(() => { timer = null; d.push(status()) }, 50) }
  })
  ipc.handle('mcp:status', () => status())
  ipc.handle('mcp:reload', () => { hub.reload(); return status() })
  ipc.handle('mcp:getServer', (_e, name: string) => readServerEntry(appFile(), name))
  ipc.handle('mcp:saveServer', (_e, name: string, entry: Record<string, unknown>, oldName?: string) => {
    saveServerEntry(appFile(), name, entry, oldName)
    if (oldName && oldName !== name.trim()) hub.forget(serverKey({ scope: 'user', name: oldName }))
    hub.reload()
    return status()
  })
  ipc.handle('mcp:removeServer', (_e, name: string) => {
    removeServerEntry(appFile(), name)
    hub.reload()
    hub.forget(serverKey({ scope: 'user', name }))
    return status()
  })
  // only files servers came from, or the personal config files
  ipc.handle('mcp:openFile', async (_e, file: string) => {
    if (!status().some((m) => m.source === file) && !userConfigFiles(os.homedir(), d.homeDir).includes(file)) throw new Error('Not an MCP config file.')
    const err = await d.openFile(file)
    if (err) throw new Error(err)
  })
  ipc.handle('mcp:signIn', (_e, key: string) => hub.signIn(key))
  ipc.handle('mcp:cancelSignIn', (_e, key: string) => hub.cancelSignIn(key))
  ipc.handle('mcp:signOut', (_e, key: string) => hub.signOut(key))
  ipc.handle('mcp:reconnect', (_e, key: string) => hub.reconnect(key))
  ipc.handle('mcp:configFiles', () => userConfigFiles(os.homedir(), d.homeDir))
  // opens the personal config (Copilot CLI's file), creating an empty one first
  ipc.handle('mcp:openConfig', async () => {
    const file = userConfigFiles(os.homedir(), d.homeDir)[0]
    if (!fs.existsSync(file)) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{\n  "mcpServers": {}\n}\n') }
    const err = await d.openFile(file)
    if (err) throw new Error(err)
    return file
  })
  hub.reload()
  return { hub, dispose: () => hub.dispose() }
}
