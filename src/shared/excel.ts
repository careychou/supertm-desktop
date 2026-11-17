/** Pure Excel helpers (no Electron / fs), shared by the main process, the renderer and tests. */

export type ExcelMode = 'live' | 'file'
export type Cell = string | number | boolean | null

export interface SheetInfo { name: string; used: string }
export interface WorkbookInfo {
  name: string
  /** Full path; '' for a workbook that was never saved, a URL for one opened from OneDrive/SharePoint. */
  path: string
  mode: ExcelMode
  sheets: SheetInfo[]
  activeSheet?: string
  selection?: string
}

export interface ExcelStatus {
  enabled: boolean
  installed: boolean
  running: boolean
  /** macOS Automation permission to control Excel: unknown until the first connection is tried. */
  permission: 'granted' | 'needed' | 'unknown'
  workbooks: WorkbookInfo[]
  active?: string
  error?: string
}

/** What the approval card shows before a write; sent as JSON in the permission request's `detail`. */
export interface ExcelPreview {
  action: 'write' | 'format'
  workbook: string
  mode: ExcelMode
  range: string
  summary: string
  /** Grid text (see gridText) of the first rows; `before` is omitted when every target cell is empty. */
  before?: string
  after?: string
  overwrites: number
  /** Set when the grids show only the first rows / columns of a larger block. */
  clipped?: string
}

export interface Rect { r1: number; c1: number; r2: number; c2: number }
export interface Ref extends Rect { sheet?: string }

export const MAX_ROWS = 1_048_576
export const MAX_COLS = 16_384

export function colName(n: number): string {
  let s = ''
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

export function colIndex(s: string): number {
  let n = 0
  for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n
}

const CELL = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/

/** Parses "A1", "A1:C3", "Sheet1!A1:C3" or "'My sheet'!$A$1:$C$3"; whole-column / whole-row ranges are not accepted. */
export function parseRef(input: string): Ref {
  let s = String(input ?? '').trim()
  let sheet: string | undefined
  const bang = s.lastIndexOf('!')
  if (bang >= 0) {
    sheet = s.slice(0, bang).trim()
    if (sheet.startsWith("'") && sheet.endsWith("'")) sheet = sheet.slice(1, -1).replace(/''/g, "'")
    s = s.slice(bang + 1)
  }
  const [a, b = a, extra] = s.split(':')
  const m1 = CELL.exec(a ?? ''), m2 = CELL.exec(b ?? '')
  if (!m1 || !m2 || extra !== undefined) throw new Error(`"${input}" is not a cell range; use A1 notation such as B2 or A1:F40`)
  const c = [colIndex(m1[1]), colIndex(m2[1])], r = [Number(m1[2]), Number(m2[2])]
  const out = { sheet, r1: Math.min(...r), c1: Math.min(...c), r2: Math.max(...r), c2: Math.max(...c) }
  if (out.r1 < 1 || out.r2 > MAX_ROWS || out.c2 > MAX_COLS) throw new Error(`"${input}" is outside the sheet`)
  return out
}

export const addr = (q: Rect): string => (q.r1 === q.r2 && q.c1 === q.c2 ? `${colName(q.c1)}${q.r1}` : `${colName(q.c1)}${q.r1}:${colName(q.c2)}${q.r2}`)
export const sheetRef = (sheet: string, q: Rect): string => `${/^[A-Za-z_][\w.]*$/.test(sheet) ? sheet : `'${sheet.replace(/'/g, "''")}'`}!${addr(q)}`
export const cellCount = (q: Rect): number => (q.r2 - q.r1 + 1) * (q.c2 - q.c1 + 1)

/** Rectangle covered by a block of values whose top-left cell is (r1, c1). */
export function blockRect(r1: number, c1: number, values: unknown[][]): Rect {
  const w = Math.max(1, ...values.map((r) => r.length))
  return { r1, c1, r2: r1 + Math.max(1, values.length) - 1, c2: c1 + w - 1 }
}

/** Validates tool input and pads ragged rows, so every row has the same width. */
export function normalizeValues(v: unknown): Cell[][] {
  if (!Array.isArray(v) || !v.length) throw new Error('values must be a non-empty array of rows, e.g. [["Store","Units"],["S001",12]]')
  const rows = v.map((r) => (Array.isArray(r) ? r : [r]))
  const w = Math.max(1, ...rows.map((r) => r.length))
  return rows.map((r) => Array.from({ length: w }, (_, i) => {
    const x = r[i]
    if (x === undefined || x === null) return null
    if (typeof x === 'number' || typeof x === 'boolean' || typeof x === 'string') return x
    return JSON.stringify(x)
  }))
}

export const isFormula = (v: unknown): boolean => typeof v === 'string' && v.length > 1 && v.startsWith('=')
export const isEmpty = (v: unknown): boolean => v === null || v === undefined || v === ''

const clean = (v: unknown): string => {
  if (isEmpty(v)) return ''
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e10) / 1e10)
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  return String(v).replace(/\t/g, ' ').replace(/\r?\n/g, '↵')
}

/**
 * Tab-separated block with column letters on the first line and the row number first on each row.
 * It is what the model reads and what the chat renders as a grid.
 */
export function gridText(r1: number, c1: number, rows: unknown[][]): string {
  const w = Math.max(0, ...rows.map((r) => r.length))
  const head = ['', ...Array.from({ length: w }, (_, i) => colName(c1 + i))].join('\t')
  return [head, ...rows.map((r, i) => [r1 + i, ...Array.from({ length: w }, (_, k) => clean(r[k]))].join('\t'))].join('\n')
}

export interface Grid { cols: string[]; rows: Array<{ n: string; cells: string[] }> }

export function parseGrid(text: string): Grid | null {
  const lines = text.split('\n').filter((l) => l.length)
  if (lines.length < 2 || !lines[0].startsWith('\t')) return null
  const cols = lines[0].split('\t').slice(1)
  if (!cols.length || cols.some((c) => !/^[A-Z]{1,3}$/.test(c))) return null
  const rows = lines.slice(1).map((l) => { const [n, ...cells] = l.split('\t'); return { n, cells } })
  return rows.every((r) => /^\d+$/.test(r.n)) ? { cols, rows } : null
}

/** A tool result: a summary line, then named grid sections ("--- values ---"). */
export function sections(output: string): { summary: string; parts: Array<{ title: string; body: string }> } {
  const chunks = output.split(/^--- (.+?) ---$/m)
  const parts: Array<{ title: string; body: string }> = []
  for (let i = 1; i + 1 < chunks.length; i += 2) parts.push({ title: chunks[i], body: chunks[i + 1].replace(/^\n+|\s+$/g, '') })
  return { summary: chunks[0].trim(), parts }
}

/** Trims a block to at most `maxRows` × `maxCols` for previews. */
export function clip<T>(rows: T[][], maxRows: number, maxCols: number): T[][] {
  return rows.slice(0, maxRows).map((r) => r.slice(0, maxCols))
}

/**
 * A test for one cell, written the way a person would: "<0.2", ">=100", "<20%", "=Closed", "<>Closed", "blank", "not blank".
 * Numbers compare as numbers; anything else compares as text, ignoring case.
 */
export function cellTest(rule: string): (v: unknown) => boolean {
  const s = String(rule ?? '').trim()
  if (/^(blank|empty)$/i.test(s)) return isEmpty
  if (/^not\s+(blank|empty)$/i.test(s)) return (v) => !isEmpty(v)
  const m = /^(<=|>=|<>|!=|<|>|==?)?\s*(.*)$/.exec(s)!
  const op = m[1] === '!=' ? '<>' : m[1] === '==' || !m[1] ? '=' : m[1], raw = m[2].trim()
  if (!raw) throw new Error(`"${rule}" is not a condition; use e.g. "<0.2", ">=100", "=Closed", "blank" or "not blank"`)
  const pct = /^-?[\d.]+%$/.test(raw), num = Number(pct ? raw.slice(0, -1) : raw.replace(/,/g, '')) / (pct ? 100 : 1)
  if (Number.isFinite(num)) return (v) => {
    if (typeof v !== 'number') return op === '<>' && !isEmpty(v)
    return op === '<' ? v < num : op === '<=' ? v <= num : op === '>' ? v > num : op === '>=' ? v >= num : op === '=' ? v === num : v !== num
  }
  if (op !== '=' && op !== '<>') throw new Error(`"${rule}" compares text with ${op}; text can only be tested with = or <>`)
  const want = raw.replace(/^"(.*)"$/, '$1').toLowerCase()
  return (v) => (String(v ?? '').toLowerCase() === want) === (op === '=')
}

/** Groups matching cells into the fewest vertical runs, column by column ("G3", "G7:G8"). */
export function matchAreas(q: Rect, values: unknown[][], test: (v: unknown) => boolean): Rect[] {
  const out: Rect[] = []
  for (let c = 0; c <= q.c2 - q.c1; c++) {
    let start = -1
    for (let r = 0; r <= values.length; r++) {
      const hit = r < values.length && test(values[r]?.[c])
      if (hit && start < 0) start = r
      if (!hit && start >= 0) { out.push({ r1: q.r1 + start, c1: q.c1 + c, r2: q.r1 + r - 1, c2: q.c1 + c }); start = -1 }
    }
  }
  return out
}

/** "#RRGGBB" (or a few names) → [r, g, b]. */
export function parseColor(input: string): [number, number, number] {
  const names: Record<string, string> = { yellow: '#FFEB9C', red: '#FFC7CE', green: '#C6EFCE', blue: '#DDEBF7', orange: '#FCE4D6', gray: '#EDEDED', grey: '#EDEDED', white: '#FFFFFF', black: '#000000' }
  const s = (names[String(input).trim().toLowerCase()] ?? String(input).trim()).replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}$/.test(s)) throw new Error(`"${input}" is not a colour; use #RRGGBB or one of ${Object.keys(names).join(', ')}`)
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)) as [number, number, number]
}

/** "Sales!B2:F40" for a workbook's selection; multi-area or whole-column selections are passed through as Excel gave them. */
export function selectionRef(w: WorkbookInfo): string {
  if (!w.selection) return ''
  try { return w.activeSheet ? sheetRef(w.activeSheet, parseRef(w.selection)) : w.selection } catch { return w.activeSheet ? `${w.activeSheet}!${w.selection}` : w.selection }
}

/** The reference the model gets when the user attaches a workbook: enough to call the excel_* tools, not the data. */
export function workbookNote(w: WorkbookInfo): string {
  const lines = [
    w.mode === 'live' ? `This workbook is open in Excel right now. Use the excel_* tools with workbook "${w.name}"; edits appear live and Excel recalculates.` : `This workbook is a file on disk. Use the excel_* tools with workbook "${w.path}".`,
    w.path && w.mode === 'live' ? `Path: ${w.path}` : '',
    `Sheets: ${w.sheets.map((s) => `${s.name}${s.used ? ` (used ${s.used})` : ' (empty)'}`).join(', ') || '(none)'}`,
    w.activeSheet ? `Active sheet: ${w.activeSheet}` : '',
    w.selection ? `The user's current selection: ${selectionRef(w)}. "This", "these cells" or "here" in the prompt mean this selection.` : ''
  ]
  return lines.filter(Boolean).join('\n')
}
