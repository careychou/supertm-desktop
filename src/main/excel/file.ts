import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type ExcelJS from 'exceljs'
import { addr, cellCount, isFormula, parseRef, type Cell, type Rect, type WorkbookInfo } from '../../shared/excel'
import type { FormatResult, ReadResult, WriteResult } from './live'

export interface FileFormat { fill?: number[] | null; fontColor?: number[]; bold?: boolean; italic?: boolean; numberFormat?: string; autofit?: boolean }

const load = async (): Promise<typeof ExcelJS> => { const m: any = await import('exceljs'); return m.default ?? m }

/** Parts of a workbook this editor cannot carry through a save; editing such a file would silently drop them. */
const RISKY: Array<[RegExp, string]> = [
  [/^xl\/charts\//, 'charts'],
  [/^xl\/pivotTables\//, 'pivot tables'],
  [/^xl\/vbaProject\.bin$/, 'macros'],
  [/^xl\/slicers\//, 'slicers'],
  [/^xl\/drawings\/drawing\d+\.xml$/, 'drawings or shapes'],
  [/^xl\/externalLinks\//, 'links to other workbooks']
]

export function riskyParts(file: string): string[] {
  let entries: string[]
  try { entries = execFileSync('unzip', ['-Z1', file], { maxBuffer: 16 * 1024 * 1024 }).toString('utf8').split('\n') } catch { return [] }
  return [...new Set(RISKY.filter(([re]) => entries.some((e) => re.test(e))).map(([, name]) => name))]
}

/** Excel on the Mac leaves `~$name.xlsx` beside a workbook while it has it open. */
export const lockedByExcel = (file: string): boolean => fs.existsSync(path.join(path.dirname(file), `~$${path.basename(file)}`))

export function assertEditable(file: string): void {
  const ext = path.extname(file).toLowerCase()
  if (ext !== '.xlsx') throw new Error(`Only .xlsx files can be read or edited on disk (got "${ext || 'no extension'}"). Open the workbook in Excel and it can be edited live instead.`)
}

const iso = (d: Date) => {
  const s = d.toISOString()
  return s.endsWith('T00:00:00.000Z') ? s.slice(0, 10) : s.slice(0, 19).replace('T', ' ')
}

function plain(v: ExcelJS.CellValue, formulas: boolean, cell: ExcelJS.Cell): Cell {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return iso(v)
  if (typeof v !== 'object') return v as Cell
  const o = v as any
  if ('formula' in o || 'sharedFormula' in o) {
    if (formulas) return `=${cell.formula ?? o.formula ?? o.sharedFormula}`
    return o.result === undefined ? null : plain(o.result, formulas, cell)
  }
  if ('error' in o) return String(o.error)
  if ('richText' in o) return (o.richText as Array<{ text: string }>).map((t) => t.text).join('')
  if ('text' in o) return String(o.text)
  return JSON.stringify(o)
}

function usedOf(ws: ExcelJS.Worksheet): Rect | null {
  const d = ws.dimensions as any
  if (!ws.actualRowCount || !d || d.bottom < 1) return null
  return { r1: Math.max(1, d.top), c1: Math.max(1, d.left), r2: d.bottom, c2: Math.max(1, d.right) }
}

function sheetOf(wb: ExcelJS.Workbook, file: string, want?: string): ExcelJS.Worksheet {
  if (!wb.worksheets.length) throw new Error(`${path.basename(file)} has no sheets`)
  if (!want) return wb.worksheets[0]
  const ws = wb.worksheets.find((s) => s.name.toLowerCase() === want.toLowerCase())
  if (!ws) throw new Error(`${path.basename(file)} has no sheet named "${want}". Sheets: ${wb.worksheets.map((s) => s.name).join(', ')}`)
  return ws
}

async function open(file: string): Promise<ExcelJS.Workbook> {
  const X = await load()
  const wb = new X.Workbook()
  await wb.xlsx.readFile(file)
  return wb
}

export async function fileInfo(file: string): Promise<WorkbookInfo> {
  const wb = await open(file)
  return { name: path.basename(file), path: file, mode: 'file', sheets: wb.worksheets.map((s) => { const u = usedOf(s); return { name: s.name, used: u ? addr(u) : '' } }) }
}

export async function fileRead(file: string, o: { sheet?: string; range?: string; formulas?: boolean; maxCells: number }): Promise<ReadResult> {
  const wb = await open(file)
  const ws = sheetOf(wb, file, o.sheet)
  const base = { workbook: path.basename(file), path: file, sheet: ws.name }
  const total = o.range ? parseRef(o.range) : usedOf(ws)
  if (!total) return { ...base, range: 'A1', total: '', values: [], truncated: false }
  const cols = total.c2 - total.c1 + 1, rows = total.r2 - total.r1 + 1, keep = Math.max(1, Math.floor(o.maxCells / cols))
  const part: Rect = { ...total, r2: Math.min(total.r2, total.r1 + keep - 1) }
  let pending = false
  const grab = (formulas: boolean) => {
    const out: Cell[][] = []
    for (let r = part.r1; r <= part.r2; r++) {
      const row: Cell[] = []
      for (let c = part.c1; c <= part.c2; c++) {
        const cell = ws.getCell(r, c), v: any = cell.value
        if (!formulas && v && typeof v === 'object' && ('formula' in v || 'sharedFormula' in v) && v.result === undefined) pending = true
        row.push(plain(cell.value, formulas, cell) ?? '')
      }
      out.push(row)
    }
    return out
  }
  const res: ReadResult = { ...base, range: addr(part), total: addr(total), values: grab(false), truncated: rows > keep }
  if (pending) res.note = 'Some formulas show no value: the file has not been opened in Excel since they were written, so they are not calculated yet.'
  if (o.formulas) res.formulas = grab(true).map((r) => r.map((v) => (v === null ? '' : String(v))))
  return res
}

/** A string is entered the way Excel would take it if typed: numbers and ISO dates convert, '-prefixed text stays text. */
function typed(v: Cell): ExcelJS.CellValue {
  if (v === null || v === '') return null
  if (typeof v !== 'string') return v
  if (isFormula(v)) return { formula: v.slice(1) } as ExcelJS.CellFormulaValue
  if (v.startsWith("'")) return v.slice(1)
  const s = v.trim()
  if (/^-?(\d+\.?\d*|\.\d+)$/.test(s) && !/^-?0\d/.test(s) && s.replace(/\D/g, '').length <= 15) return Number(s)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))) return new Date(`${s}T00:00:00.000Z`)
  return v
}

/** Excel shares one formula across a filled-down column; a write into the middle of it would orphan the rest. */
function unshare(ws: ExcelJS.Worksheet): void {
  ws.eachRow((row) => row.eachCell((cell) => {
    const v: any = cell.value
    if (v && typeof v === 'object' && ('sharedFormula' in v || v.shareType === 'shared')) cell.value = { formula: cell.formula, result: v.result } as ExcelJS.CellFormulaValue
  }))
}

function guard(file: string): void {
  assertEditable(file)
  if (!fs.existsSync(file)) return
  if (lockedByExcel(file)) throw new Error(`${path.basename(file)} is open in Excel, so editing the file on disk would conflict with it. Refer to it by name ("${path.basename(file)}") to edit it live, or close it in Excel first.`)
  const risky = riskyParts(file)
  if (risky.length) throw new Error(`${path.basename(file)} contains ${risky.join(', ')}, which a file edit would drop. Open it in Excel and edit it live instead (refer to it by name once it is open).`)
}

export async function fileWrite(file: string, o: { sheet?: string; range: string; values: Cell[][]; create?: boolean }): Promise<WriteResult> {
  guard(file)
  const X = await load()
  let wb: ExcelJS.Workbook, ws: ExcelJS.Worksheet | undefined, created = false
  if (fs.existsSync(file)) {
    wb = await open(file)
    ws = o.sheet ? wb.worksheets.find((s) => s.name.toLowerCase() === o.sheet!.toLowerCase()) : wb.worksheets[0]
    if (!ws && !o.create) sheetOf(wb, file, o.sheet)
  } else {
    if (!o.create) throw new Error(`${file} does not exist. Pass create: true to make a new workbook.`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    wb = new X.Workbook()
  }
  if (!ws) { ws = wb.addWorksheet(o.sheet || 'Sheet1'); created = true } else unshare(ws)
  const q = parseRef(o.range)
  o.values.forEach((row, i) => row.forEach((v, k) => { ws!.getCell(q.r1 + i, q.c1 + k).value = typed(v) }))
  // values of new formulas are unknown until Excel opens the file; ask it to recalculate then
  wb.calcProperties.fullCalcOnLoad = true
  await wb.xlsx.writeFile(file)
  return { workbook: path.basename(file), path: file, sheet: ws.name, range: o.range, created, values: [] }
}

const argb = (c: number[]) => 'FF' + c.map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('').toUpperCase()

export async function fileFormat(file: string, o: { sheet?: string; range: string } & FileFormat): Promise<FormatResult> {
  guard(file)
  if (!fs.existsSync(file)) throw new Error(`${file} does not exist`)
  const wb = await open(file)
  const ws = sheetOf(wb, file, o.sheet), q = parseRef(o.range)
  if (cellCount(q) > 200_000) throw new Error('That range is too large to format in a file; format at most 200,000 cells at a time.')
  for (let r = q.r1; r <= q.r2; r++) for (let c = q.c1; c <= q.c2; c++) {
    const cell = ws.getCell(r, c)
    if (o.fill === null) cell.fill = { type: 'pattern', pattern: 'none' }
    else if (o.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(o.fill) } }
    const font: Partial<ExcelJS.Font> = { ...(cell.font ?? {}) }
    if (o.fontColor) font.color = { argb: argb(o.fontColor) }
    if (typeof o.bold === 'boolean') font.bold = o.bold
    if (typeof o.italic === 'boolean') font.italic = o.italic
    if (o.fontColor || typeof o.bold === 'boolean' || typeof o.italic === 'boolean') cell.font = font
    if (o.numberFormat) cell.numFmt = o.numberFormat
  }
  if (o.autofit) for (let c = q.c1; c <= q.c2; c++) {
    let w = 8
    ws.getColumn(c).eachCell({ includeEmpty: false }, (cell) => { w = Math.max(w, Math.min(60, String(cell.text ?? '').length + 2)) })
    ws.getColumn(c).width = w
  }
  await wb.xlsx.writeFile(file)
  return { workbook: path.basename(file), path: file, sheet: ws.name, range: o.range }
}
