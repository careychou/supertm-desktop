import type { IpcMain } from 'electron'
import type { ToolDef } from '../../engine/tools/types'
import { EXCEL_PROMPT, ExcelService, excelTools, type ExcelConfig } from './service'
import { OsaBackend } from './live'

/** Wires Excel into the app: the agent tools, and the IPC the composer and Settings use. */
export function registerExcel(ipc: IpcMain, cfg: () => ExcelConfig): { svc: ExcelService; tools: () => ToolDef[]; prompt: () => string } {
  const svc = new ExcelService(new OsaBackend(), cfg)
  const tools = excelTools(svc)
  ipc.handle('excel:status', (_e, probe?: boolean) => svc.status(!!probe))
  ipc.handle('excel:attach', (_e, name: string) => svc.attach(name))
  return { svc, tools: () => (cfg().enabled ? tools : []), prompt: () => (cfg().enabled ? EXCEL_PROMPT : '') }
}
