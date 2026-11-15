import type { IpcMain } from 'electron'
import type { FolderConfig, PluginsStatus } from '../../shared/plugins'
import { PluginService, type PluginServiceOptions } from './service'
import { pluginsTool } from './tool'
import type { ToolDef } from '../../engine/tools/types'

export type PluginsPush =
  | { type: 'pluginsStatus'; status: PluginsStatus }
  | { type: 'pluginsLog'; folder: string; line: string }
  | { type: 'pluginsOpen'; folder: string }

export interface PluginsHooks extends Pick<PluginServiceOptions, 'getToken' | 'managed' | 'run'> {
  dataHome: string
  push: (e: PluginsPush) => void
  /** Working folders known to the app. */
  folders: () => string[]
  /** Extra listener for status changes (a branded build mirrors them into its own status). */
  onChange?: (folder: string) => void
}

const CHECK_EVERY = 6 * 3600_000
const fail = (e: any) => ({ ok: false, message: String(e?.message ?? e) })

/** Wires folder plugins into the app: IPC handlers, a periodic update check, and the agent tool. */
export function registerPlugins(ipc: IpcMain, h: PluginsHooks): { svc: PluginService; tools: ToolDef[]; checkFolder: (f: string) => void; dispose: () => void } {
  const svc: PluginService = new PluginService({
    dataHome: h.dataHome, run: h.run, getToken: h.getToken, managed: h.managed,
    onLog: (folder, line) => h.push({ type: 'pluginsLog', folder, line }),
    onChange: (folder) => { h.push({ type: 'pluginsStatus', status: svc.status(folder) }); h.onChange?.(folder) }
  })

  ipc.handle('plugins:status', (_e, folder: string) => svc.status(folder))
  ipc.handle('plugins:statuses', () => h.folders().filter((f) => svc.hasPlugins(f)).map((f) => svc.status(f)))
  ipc.handle('plugins:saveConfig', (_e, folder: string, c: FolderConfig) => svc.saveConfig(folder, c))
  ipc.handle('plugins:list', (_e, folder: string, force?: boolean) => svc.listPlugins(folder, force))
  ipc.handle('plugins:install', (_e, folder: string, name: string, mp: string) => svc.installPlugin(folder, name, mp).catch(fail))
  ipc.handle('plugins:uninstall', (_e, folder: string, name: string) => svc.uninstallPlugin(folder, name).catch(fail))
  ipc.handle('plugins:checkUpdates', (_e, folder: string) => svc.checkUpdates(folder).catch(() => undefined))
  ipc.handle('plugins:updateAll', (_e, folder: string) => svc.updateAll(folder).catch(fail))

  const lastCheck = new Map<string, number>()
  const checkFolder = (f: string) => {
    if (Date.now() - (lastCheck.get(f) ?? 0) < 30 * 60_000) return
    lastCheck.set(f, Date.now())
    try { if (Object.keys(svc.status(f).plugins).length && svc.status(f).config.autoCheck) void svc.checkUpdates(f).catch(() => undefined) } catch { /* gone */ }
  }
  const checkAll = () => { for (const f of h.folders()) checkFolder(f) }
  const first = setTimeout(checkAll, 20_000)
  const timer = setInterval(() => { lastCheck.clear(); checkAll() }, CHECK_EVERY)

  return {
    svc,
    tools: [pluginsTool(svc, (folder) => h.push({ type: 'pluginsOpen', folder }))],
    checkFolder,
    dispose: () => { clearTimeout(first); clearInterval(timer); svc.dispose() }
  }
}
