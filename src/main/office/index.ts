import type { IpcMain } from 'electron'
import type { ToolDef } from '../../engine/tools/types'
import { OFFICE_PROMPT, OfficeService, officeTools, type OfficeConfig } from './service'
import { OsaOfficeBackend } from './live'

/** Wires Word and PowerPoint into the app: the agent tools, and the IPC Settings uses. */
export function registerOffice(ipc: IpcMain, cfg: () => OfficeConfig): { svc: OfficeService; tools: () => ToolDef[]; prompt: () => string } {
  const svc = new OfficeService(new OsaOfficeBackend(), cfg)
  const tools = officeTools(svc)
  ipc.handle('office:status', (_e, probe?: boolean) => svc.status(!!probe))
  return { svc, tools: () => (cfg().enabled ? tools : []), prompt: () => (cfg().enabled ? OFFICE_PROMPT : '') }
}
