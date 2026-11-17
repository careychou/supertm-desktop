import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ToolContext, ToolDef } from '../../engine/tools/types'
import { head, resolvePath } from '../../engine/tools/util'
import {
  addr, blockRect, cellCount, cellTest, clip, matchAreas, gridText, isEmpty, isFormula, normalizeValues, parseColor, parseRef, selectionRef, sheetRef, workbookNote,
  type Cell, type ExcelPreview, type ExcelStatus, type Rect, type WorkbookInfo
} from '../../shared/excel'
import type { AttachMeta } from '../../shared/attach'
import type { Attachment } from '../../engine/content'
import { LiveError, type FormatResult, type LiveBackend, type LiveReq, type LiveStatus, type ReadResult, type WriteResult } from './live'
import { fileFormat, fileInfo, fileRead, fileWrite, lockedByExcel, type FileFormat } from './file'

export interface ExcelConfig {
  enabled: boolean
  /** 'ask': show the change and wait for the user before writing (autopilot chats never wait). */
  confirm: 'ask' | 'never'
  /** Copy a workbook to name.backup.xlsx before the first edit. */
  backup: boolean
}

const READ_DEFAULT = 5_000
const READ_MAX = 50_000
const WRITE_MAX = 200_000
const OUT_MAX = 60_000

type Target = { mode: 'live'; workbook?: string; path?: string } | { mode: 'file'; file: string }

/** Rows that have a hit, as runs of consecutive rows across columns c1..c2. */
function mergeRows(hits: Rect[], c1: number, c2: number): Rect[] {
  const rows = [...new Set(hits.flatMap((h) => Array.from({ length: h.r2 - h.r1 + 1 }, (_, i) => h.r1 + i)))].sort((a, b) => a - b)
  const out: Rect[] = []
  for (const r of rows) {
    const last = out[out.length - 1]
    if (last && last.r2 === r - 1) last.r2 = r; else out.push({ r1: r, c1: Math.min(c1, c2), r2: r, c2: Math.max(c1, c2) })
  }
  return out
}

const dims = (q: Rect) => `${(q.r2 - q.r1 + 1).toLocaleString('en-US')} row${q.r2 === q.r1 ? '' : 's'} × ${q.c2 - q.c1 + 1} column${q.c2 === q.c1 ? '' : 's'}`
const isPathLike = (s: string) => s.includes('/') || s.startsWith('~')

/** In a live workbook Excel reads a string as if it were typed, which would turn an ID such as "00123" into 123. */
const liveValue = (v: Cell): Cell => (typeof v === 'string' && !isFormula(v) && /^\s*(0\d+|\d{16,})\s*$/.test(v) ? `'${v}` : v)

export class ExcelService {
  private permission: ExcelStatus['permission'] = 'unknown'
  private backedUp = new Set<string>()
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private live: LiveBackend, private cfg: () => ExcelConfig) {}

  /** `probe` talks to Excel, which makes macOS ask for permission the first time; without it only installed/running are reported. */
  async status(probe: boolean): Promise<ExcelStatus> {
    const st: ExcelStatus = { enabled: this.cfg().enabled, installed: this.live.installed(), running: this.live.running(), permission: this.permission, workbooks: [] }
    if (!st.running || !(probe || this.permission === 'granted')) return st
    try {
      const r = await this.live.call<LiveStatus>({ op: 'status' })
      this.permission = 'granted'
      return { ...st, permission: 'granted', workbooks: r.workbooks, active: r.active }
    } catch (e: any) {
      if (e instanceof LiveError && e.code === 'permission') this.permission = 'needed'
      return { ...st, permission: this.permission, error: e?.message ?? String(e) }
    }
  }

  /** A chip for a workbook open in Excel: the model gets a reference (sheets, selection), not the data. */
  async attach(name: string): Promise<{ id: string; att?: Attachment; meta: AttachMeta; error?: string }> {
    const id = randomUUID()
    const st = await this.status(true)
    const w = st.workbooks.find((b) => b.name === name)
    if (!w) return { id, meta: { name, kind: 'doc', info: 'Not open in Excel', excel: 'live' }, error: st.error ?? `${name} is no longer open in Excel` }
    const where = selectionRef(w) || w.activeSheet || `${w.sheets.length} sheet${w.sheets.length === 1 ? '' : 's'}`
    return { id, att: { kind: 'text', name: w.name, text: workbookNote(w), note: 'Excel workbook, open in Excel' }, meta: { name: w.name, kind: 'doc', info: where, excel: 'live' } }
  }

  /** Marks a dropped .xlsx so the model can also reach it with the tools, beyond the text that was inlined. */
  decorate<T extends { att?: Attachment; meta: AttachMeta; error?: string }>(p: T, file?: string): T {
    if (!this.cfg().enabled || !file || p.error || path.extname(file).toLowerCase() !== '.xlsx') return p
    p.meta.excel = 'file'
    if (p.att?.kind === 'text') p.att.note = [p.att.note, `file on disk: ${file} (use the excel_* tools with this path to read more or to edit it)`].filter(Boolean).join('; ')
    return p
  }

  /** Where a workbook reference leads: the running Excel when it has that workbook open, otherwise the file. */
  private async route<T>(cwd: string, workbook: string | undefined, o: { mayCreate?: boolean }, onLive: (t: Extract<Target, { mode: 'live' }>) => Promise<T>, onFile: (file: string) => Promise<T>): Promise<T> {
    const file = workbook ? resolvePath(cwd, workbook) : undefined
    const fileOk = !!file && (fs.existsSync(file) || (!!o.mayCreate && path.extname(file).toLowerCase() === '.xlsx'))
    if (this.live.running()) {
      try {
        const r = await onLive({ mode: 'live', workbook, path: file })
        this.permission = 'granted'
        return r
      } catch (e) {
        if (!(e instanceof LiveError)) throw e
        if (e.code === 'permission') {
          this.permission = 'needed'
          if (!fileOk || lockedByExcel(file!)) throw e
        } else if (e.code === 'not_open') {
          if (!fileOk) throw new Error(workbook ? `"${workbook}" is not open in Excel and no such file exists${isPathLike(workbook) ? '' : ` in ${cwd}`}. Open workbooks: ${e.names.join(', ') || 'none'}.` : e.message)
        } else if (e.code !== 'not_running') throw new Error(e.code === 'no_sheet' ? `${e.message} Sheets: ${e.names.join(', ')}` : e.message)
      }
    }
    if (!file) throw new Error('Excel is not running, so there is no open workbook. Pass the path of an .xlsx file as "workbook".')
    if (!fileOk) throw new Error(`${file} does not exist${o.mayCreate ? ' (new workbooks must end in .xlsx)' : ''}.`)
    return onFile(file)
  }

  /**
   * Runs Excel work one call at a time, in the order the calls were made. A model often issues a write and a
   * follow-up read or format in the same step; run side by side, the second would see the sheet before the first landed.
   */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn)
    this.tail = run.catch(() => undefined)
    return run
  }

  queued<T>(fn: () => Promise<T>): Promise<T> { return this.serial(fn) }

  private check() { if (!this.cfg().enabled) throw new Error('Working with Excel is turned off in Settings → Excel.') }

  private backup(file: string | undefined): string {
    if (!this.cfg().backup || !file || !path.isAbsolute(file) || this.backedUp.has(file) || !fs.existsSync(file)) return ''
    const ext = path.extname(file), copy = `${file.slice(0, file.length - ext.length)}.backup${ext}`
    try { fs.copyFileSync(file, copy); this.backedUp.add(file); return copy } catch { return '' }
  }

  private async confirm(ctx: ToolContext, p: ExcelPreview): Promise<void> {
    if (this.cfg().confirm !== 'ask') return
    if (!(await ctx.gate.check(ctx.agentId, 'excel', JSON.stringify(p)))) throw new Error('the user declined this change; nothing was written')
  }

  async info(cwd: string, workbook?: string): Promise<string> {
    this.check()
    const describe = (w: WorkbookInfo, active?: string) => [
      `- ${w.name}${w.mode === 'live' ? (w.name === active ? ' (live, active)' : ' (live)') : ' (file, not open in Excel)'}${w.path ? ` · ${w.path}` : w.mode === 'live' ? ' · never saved' : ''}`,
      `  Sheets: ${w.sheets.map((s) => `${s.name} (${s.used ? `used ${s.used}` : 'empty'})`).join(', ') || 'none'}`,
      w.activeSheet ? `  Active sheet: ${w.activeSheet}${w.selection ? ` · selection ${selectionRef(w)}` : ''}` : ''
    ].filter(Boolean).join('\n')
    if (!workbook) {
      if (!this.live.running()) return 'Excel is not running. Pass the path of an .xlsx file as "workbook" to read or edit it on disk.'
      const st = await this.status(true)
      if (st.error) throw new Error(st.error)
      return st.workbooks.length ? `Open in Excel:\n${st.workbooks.map((w) => describe(w, st.active)).join('\n')}` : 'Excel is running with no workbook open.'
    }
    return this.route(cwd, workbook, {},
      async (t) => {
        const st = await this.live.call<LiveStatus>({ op: 'status' })
        const w = st.workbooks.find((b) => b.name.toLowerCase() === workbook.toLowerCase() || (!!t.path && b.path.toLowerCase() === t.path.toLowerCase()))
        if (!w) throw new LiveError('not_open', `No open workbook is named "${workbook}".`, st.workbooks.map((b) => b.name))
        return describe(w, st.active)
      },
      async (file) => describe(await fileInfo(file)))
  }

  async read(cwd: string, a: { workbook?: string; sheet?: string; range?: string; formulas?: boolean; max_cells?: number }): Promise<string> {
    this.check()
    const ref = a.range ? parseRef(a.range) : undefined
    const sheet = a.sheet ?? ref?.sheet, range = ref ? addr(ref) : undefined
    const maxCells = Math.max(1, Math.min(READ_MAX, Math.floor(a.max_cells ?? READ_DEFAULT)))
    let mode = 'live' as 'live' | 'file'
    const r = await this.route<ReadResult>(cwd, a.workbook, {},
      (t) => this.live.call<ReadResult>({ op: 'read', workbook: t.workbook, path: t.path, sheet, range, formulas: !!a.formulas, maxCells }),
      (file) => { mode = 'file'; return fileRead(file, { sheet, range, formulas: !!a.formulas, maxCells }) })
    const label = `${r.workbook} (${mode})`
    if (!r.values.length) return `${label} · sheet "${r.sheet}" is empty.`
    const q = parseRef(r.range)
    const lines = [`${label} · ${sheetRef(r.sheet, q)} · ${dims(q)}`]
    if (r.truncated) lines.push(`Only the first ${r.values.length.toLocaleString('en-US')} rows of ${r.total} are shown. Read the rest with range "${addr({ ...parseRef(r.total), r1: q.r2 + 1 })}", or raise max_cells (up to ${READ_MAX.toLocaleString('en-US')}).`)
    if (r.note) lines.push(r.note)
    lines.push('--- values ---', gridText(q.r1, q.c1, r.values))
    if (r.formulas) lines.push('--- formulas ---', gridText(q.r1, q.c1, r.formulas))
    return head(lines.join('\n'), OUT_MAX)
  }

  async write(ctx: ToolContext, a: { workbook?: string; sheet?: string; start?: string; values?: unknown; create?: boolean }): Promise<string> {
    this.check()
    const values = normalizeValues(a.values)
    const at = parseRef(a.start ?? 'A1')
    const sheet = a.sheet ?? at.sheet
    const q = blockRect(at.r1, at.c1, values), range = addr(q), cells = cellCount(q)
    if (cells > WRITE_MAX) throw new Error(`That is ${cells.toLocaleString('en-US')} cells; write at most ${WRITE_MAX.toLocaleString('en-US')} per call.`)
    const formulas = values.flat().filter(isFormula).length

    // what is there now: shown to the user before the change, and returned so the change can be put back
    let mode = 'live' as 'live' | 'file', before: string[][] = [], bookName = a.workbook ? path.basename(a.workbook) : 'the active workbook', bookPath = '', sheetName = sheet ?? '', newSheet = false
    try {
      const r = await this.route<ReadResult>(ctx.cwd, a.workbook, { mayCreate: !!a.create },
        (t) => this.live.call<ReadResult>({ op: 'read', workbook: t.workbook, path: t.path, sheet, range, formulas: true, maxCells: 2_000 }),
        async (file) => { mode = 'file'; bookName = path.basename(file); bookPath = file; return fs.existsSync(file) ? fileRead(file, { sheet, range, formulas: true, maxCells: 2_000 }) : { workbook: bookName, path: file, sheet: sheet ?? 'Sheet1', range, total: '', values: [], formulas: [], truncated: false } })
      before = r.formulas ?? []; bookName = r.workbook; bookPath = r.path; sheetName = r.sheet
    } catch (e: any) {
      // a sheet that does not exist yet is fine when the caller asked to create it
      if (!(a.create && sheet && /has no sheet named/.test(String(e?.message)))) throw e
      newSheet = true; sheetName = sheet
    }
    const overwrites = before.flat().filter((v) => !isEmpty(v)).length
    const where = sheetRef(sheetName || 'Sheet1', q)
    const summary = `Write ${cells.toLocaleString('en-US')} cell${cells === 1 ? '' : 's'} to ${where}${formulas ? ` (${formulas} formula${formulas === 1 ? '' : 's'})` : ''}${newSheet ? `, on a new sheet "${sheetName}"` : ''}${overwrites ? `. ${overwrites} cell${overwrites === 1 ? ' already holds' : 's already hold'} data and will be replaced` : ''}.`
    await this.confirm(ctx, { action: 'write', workbook: bookName, mode, range: where, summary, overwrites, after: gridText(q.r1, q.c1, clip(values, 8, 6)), before: overwrites ? gridText(q.r1, q.c1, clip(before, 8, 6)) : undefined,
      clipped: values.length > 8 || values[0].length > 6 ? `Showing the first ${Math.min(8, values.length)} of ${values.length.toLocaleString('en-US')} rows${values[0].length > 6 ? ` and 6 of ${values[0].length} columns` : ''}` : undefined })

    const saved = this.backup(bookPath)
    const w = await this.route<WriteResult>(ctx.cwd, a.workbook, { mayCreate: !!a.create },
      (t) => this.live.call<WriteResult>({ op: 'write', workbook: t.workbook, path: t.path, sheet, range, values: values.map((row) => row.map(liveValue)), create: !!a.create, echoCells: 240 }),
      (file) => fileWrite(file, { sheet, range, values, create: !!a.create }))
    const out = [`Wrote ${cells.toLocaleString('en-US')} cell${cells === 1 ? '' : 's'}${formulas ? ` (${formulas} formula${formulas === 1 ? '' : 's'})` : ''} to ${sheetRef(w.sheet, q)} in ${w.workbook} (${mode}).${w.created ? (mode === 'file' && !before.length && !newSheet ? ' Created the workbook.' : ` Created sheet "${w.sheet}".`) : ''}${saved ? ` Backup of the file as it was: ${saved}` : ''}`]
    if (mode === 'live') out.push('The workbook is changed in Excel but not saved; the user saves it.')
    else if (formulas) out.push('Formula results appear once the file is opened in Excel; reading it back before then shows them empty.')
    if (w.values.length) out.push('--- now ---', gridText(q.r1, q.c1, w.values))
    if (overwrites) out.push('--- before ---', gridText(q.r1, q.c1, clip(before, 200, 50)), 'To undo, write the "before" block back to the same range.')
    else out.push('The cells were empty before.')
    return head(out.join('\n'), OUT_MAX)
  }

  async format(ctx: ToolContext, a: { workbook?: string; sheet?: string; range?: string; fill?: string; font_color?: string; bold?: boolean; italic?: boolean; number_format?: string; autofit?: boolean; only_if?: string; whole_row?: string }): Promise<string> {
    this.check()
    if (!a.range) throw new Error('range is required, e.g. "G2:G40"')
    // several areas ("A3:G3,A7:G8") are formatted in one call, so the user approves them once
    let refs = String(a.range).split(',').map((r) => parseRef(r))
    const ref = refs[0], sheet = a.sheet ?? ref.sheet
    const test = a.only_if ? cellTest(a.only_if) : undefined
    const f: FileFormat = {
      fill: a.fill === undefined ? undefined : /^(none|clear)$/i.test(a.fill) ? null : parseColor(a.fill),
      fontColor: a.font_color ? parseColor(a.font_color) : undefined,
      bold: a.bold, italic: a.italic, numberFormat: a.number_format, autofit: a.autofit
    }
    const what = [f.fill === null ? 'clear fill' : a.fill && `fill ${a.fill}`, a.font_color && `font ${a.font_color}`, a.bold !== undefined && (a.bold ? 'bold' : 'not bold'), a.italic !== undefined && (a.italic ? 'italic' : 'not italic'), a.number_format && `number format ${a.number_format}`, a.autofit && 'fit column widths'].filter(Boolean)
    if (!what.length) throw new Error('nothing to format: pass fill, font_color, bold, italic, number_format or autofit')
    // one cell is read first to learn which workbook and sheet this lands on, so the user is asked about the right one
    let mode = 'live' as 'live' | 'file'
    const probe = addr({ r1: ref.r1, c1: ref.c1, r2: ref.r1, c2: ref.c1 })
    const at = await this.route<ReadResult>(ctx.cwd, a.workbook, {},
      (t) => this.live.call<ReadResult>({ op: 'read', workbook: t.workbook, path: t.path, sheet, range: probe, maxCells: 1 }),
      (file) => { mode = 'file'; return fileRead(file, { sheet, range: probe, maxCells: 1 }) })
    // only_if: the tool, not the model, decides which cells qualify, from the values in the sheet
    let matched = ''
    if (test) {
      const all = refs, hits: Rect[] = []
      let total = 0
      for (const r of all) {
        const range = addr(r)
        const got = await this.route<ReadResult>(ctx.cwd, a.workbook, {},
          (t) => this.live.call<ReadResult>({ op: 'read', workbook: t.workbook, path: t.path, sheet, range, maxCells: READ_MAX }),
          (file) => fileRead(file, { sheet, range, maxCells: READ_MAX }))
        if (got.truncated) throw new Error(`${range} is too large to test in one call; use a range of at most ${READ_MAX.toLocaleString('en-US')} cells.`)
        total += cellCount(r)
        hits.push(...matchAreas(r, got.values, test))
      }
      const n = hits.reduce((t, r) => t + cellCount(r), 0)
      if (!n) return `No cell in ${at.sheet}!${all.map((r) => addr(r)).join(', ')} matches ${a.only_if}; nothing was formatted.`
      matched = `${n} of ${total.toLocaleString('en-US')} cells match ${a.only_if}`
      // whole_row: paint these columns of each matching row (e.g. "A:G"), not just the tested cell
      const span = a.whole_row ? /^\s*([A-Za-z]{1,3})\s*:\s*([A-Za-z]{1,3})\s*$/.exec(a.whole_row) : null
      if (a.whole_row && !span) throw new Error('whole_row is a column span such as "A:G"')
      refs = span ? mergeRows(hits, parseRef(`${span[1]}1`).c1, parseRef(`${span[2]}1`).c1) : hits
    }
    if (refs.length > 500) throw new Error(`That is ${refs.length} separate areas; format at most 500 per call (narrow the range).`)
    const where = refs.map((r) => addr(r)).join(', ')
    if (matched) what.push(`where ${matched}`)
    await this.confirm(ctx, { action: 'format', workbook: at.workbook, mode, range: `${at.sheet}!${where}`, summary: `Format ${at.sheet}!${where}: ${what.join(', ')}. Cell contents do not change.`, overwrites: 0 })
    let done: FormatResult | undefined
    for (const r of refs) {
      const range = addr(r)
      done = await this.route<FormatResult>(ctx.cwd, a.workbook, {},
        (t) => { const req: LiveReq = { op: 'format', workbook: t.workbook, path: t.path, sheet, range, ...f }; return this.live.call<FormatResult>(req) },
        (file) => { this.backup(file); return fileFormat(file, { sheet, range, ...f }) })
    }
    return `Formatted ${done!.sheet}!${where} in ${done!.workbook} (${mode}): ${what.join(', ')}.`
  }
}

const WB = { type: 'string', description: 'Name of a workbook open in Excel (e.g. "Budget.xlsx"), or the path of an .xlsx file. Omit for the active workbook in Excel.' }
const SHEET = { type: 'string', description: 'Sheet name. Omit for the active sheet (live) or the first sheet (file).' }

export const EXCEL_PROMPT = `# Excel
Use the excel_info, excel_read, excel_write and excel_format tools for Excel workbooks: a workbook open in Excel is read and edited live (the user watches the change and Excel recalculates), and a closed .xlsx file is read and edited on disk. Prefer these tools over writing scripts or looking at screenshots. Read only the range you need. Write formulas (strings starting with "=") where the user would expect a number that stays up to date. When a workbook is attached to the prompt, its note names the sheets and the user's current selection.`

export function excelTools(svc: ExcelService): ToolDef[] {
  return [
    {
      name: 'excel_info',
      description: 'List the workbooks open in Excel with their sheets, used ranges, the active sheet and the user\'s current selection. Pass "workbook" for one workbook or an .xlsx file path.',
      parameters: { type: 'object', properties: { workbook: WB } },
      run: (a, ctx) => svc.queued(() => svc.info(ctx.cwd, a.workbook))
    },
    {
      name: 'excel_read',
      description: `Read cells from a workbook open in Excel, or from an .xlsx file. Returns a tab-separated grid with column letters and row numbers. Omit "range" for the whole used range; at most max_cells cells come back (default ${READ_DEFAULT.toLocaleString('en-US')}), with the range to ask for next when there are more. Set formulas: true to also get each cell's formula.`,
      parameters: { type: 'object', properties: { workbook: WB, sheet: SHEET, range: { type: 'string', description: 'A1 range such as "A1:F40" or "Sales!A1:F40".' }, formulas: { type: 'boolean' }, max_cells: { type: 'integer' } } },
      run: (a, ctx) => svc.queued(() => svc.read(ctx.cwd, a))
    },
    {
      name: 'excel_write',
      description: 'Write a block of cells into a workbook open in Excel (changed live, not saved) or into an .xlsx file on disk. "values" is an array of rows; the block starts at "start" (its top-left cell). Use JSON numbers for numbers, strings starting with "=" for formulas (e.g. "=SUM(E2:E40)"), and null to clear a cell. Other strings are entered as if typed, so "2026-11-17" becomes a date; start a string with an apostrophe to force text. Set create: true to add the sheet (or the .xlsx file) when it does not exist. The result shows what the cells hold now and what they held before.',
      parameters: { type: 'object', properties: { workbook: WB, sheet: SHEET, start: { type: 'string', description: 'Top-left cell of the block, e.g. "G1". Default A1.' }, values: { type: 'array', items: { type: 'array', items: {} }, description: 'Rows of cells, e.g. [["Margin %"],["=(E2-F2)/E2"]].' }, create: { type: 'boolean' } }, required: ['values'] },
      run: (a, ctx) => svc.queued(() => svc.write(ctx, a))
    },
    {
      name: 'excel_format',
      description: 'Format a range (or several, comma-separated: "A3:G3,A7:G8") without changing its contents: fill colour (to highlight), font colour, bold, italic, number format (e.g. "0.0%", "#,##0.00", "yyyy-mm-dd") or fit column widths. Colours are "#RRGGBB" or yellow, red, green, blue, orange, gray; fill "none" clears a highlight. To format only the cells that meet a condition, pass only_if ("<0.2", ">=100", "<20%", "=Closed", "blank", "not blank"): the tool tests each cell in the range itself, which is exact; do not work out the matching rows yourself. Add whole_row (a column span such as "A:G") to format those columns of every matching row.',
      parameters: { type: 'object', properties: { workbook: WB, sheet: SHEET, range: { type: 'string' }, fill: { type: 'string' }, font_color: { type: 'string' }, bold: { type: 'boolean' }, italic: { type: 'boolean' }, number_format: { type: 'string' }, autofit: { type: 'boolean' }, only_if: { type: 'string', description: 'Condition each cell must meet, e.g. "<0.2".' }, whole_row: { type: 'string', description: 'With only_if: column span to format on each matching row, e.g. "A:G".' } }, required: ['range'] },
      run: (a, ctx) => svc.queued(() => svc.format(ctx, a))
    }
  ]
}
