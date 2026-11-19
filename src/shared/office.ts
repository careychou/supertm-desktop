/** Word and PowerPoint, driven live through their own scripting interface (no add-in). */
export type OfficeApp = 'word' | 'powerpoint'
export const OFFICE_NAME: Record<OfficeApp, string> = { word: 'Word', powerpoint: 'PowerPoint' }

export interface OfficeDoc {
  name: string
  /** Empty for a document that was never saved. */
  path: string
  saved: boolean
  /** Word: paragraphs. PowerPoint: slides. */
  size: number
  tables?: number
  comments?: number
  tracking?: boolean
  /** Word: "paragraphs 4–6" the cursor or selection covers. PowerPoint: the slide on screen. */
  at?: string
  selection?: string
}

export interface OfficeAppStatus {
  enabled: boolean
  installed: boolean
  running: boolean
  /** macOS Automation permission to control the app: unknown until the first connection is tried. */
  permission: 'granted' | 'needed' | 'unknown'
  docs: OfficeDoc[]
  active?: string
  error?: string
}
export type OfficeStatus = Record<OfficeApp, OfficeAppStatus>

/** What the approval card shows before a change; sent as JSON in the permission request's `detail`. */
export interface OfficePreview {
  app: OfficeApp
  document: string
  summary: string
  changes: Array<{ where: string; before?: string; after?: string }>
  /** Set when only the first changes are listed. */
  more?: string
}

/** Highlight and font colours Word accepts by name. */
export const WORD_COLORS = ['auto', 'black', 'blue', 'turquoise', 'bright green', 'pink', 'red', 'yellow', 'white', 'dark blue', 'teal', 'green', 'violet', 'dark red', 'dark yellow', 'gray50', 'gray25'] as const

/** Slide layouts by the names the tools accept → PowerPoint's own names. */
export const SLIDE_LAYOUTS: Record<string, string> = {
  title: 'title slide', title_and_content: 'text slide', title_only: 'title only', blank: 'blank', section_header: 'section header',
  two_content: 'two column text', comparison: 'comparison', content_with_caption: 'content with caption', picture_with_caption: 'picture with caption'
}

/** "#C00000" → [192, 0, 0]. */
export function parseHexColor(s: string): number[] {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(s).trim())
  if (!m) throw new Error(`"${s}" is not a colour; use #RRGGBB`)
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16))
}

/** "3", "2-5", "all" or nothing → an inclusive 1-based span within 1..total. */
export function parseSpan(v: unknown, total: number, what: string): { from: number; to: number } {
  if (v === undefined || v === null || v === '' || /^all$/i.test(String(v))) return { from: 1, to: total }
  const m = /^\s*(\d+)\s*(?:[-–:]\s*(\d+)\s*)?$/.exec(String(v))
  if (!m) throw new Error(`${what} is a number or a span such as "2-5"`)
  const from = +m[1], to = m[2] ? +m[2] : from
  if (from < 1 || to < from) throw new Error(`${what} "${v}" is not a valid span`)
  return { from, to: Math.min(to, Math.max(total, from)) }
}

export const clipText = (s: string, n = 160) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t }
const plural = (n: number, w: string) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`

export interface WordPara { n: number; text: string; level: number; cell?: boolean }
export interface WordRead { document: string; path: string; total: number; paragraphs: WordPara[]; next?: number; tables: number; comments: number; revisions: number; tracking: boolean; note?: string; grid?: { table: number; rows: string[][] } }

/** The text the model reads: one numbered line per paragraph, headings and table cells marked. */
export function wordReadText(r: WordRead): string {
  if (r.grid) return [`${r.document} · table ${r.grid.table} · ${plural(r.grid.rows.length, 'row')} × ${plural(r.grid.rows[0]?.length ?? 0, 'column')}`, ...r.grid.rows.map((row, i) => `row ${i + 1}\t${row.map((c) => c.replace(/\s+/g, ' ')).join('\t')}`)].join('\n')
  const first = r.paragraphs[0]?.n ?? 0, last = r.paragraphs[r.paragraphs.length - 1]?.n ?? 0
  const head = `${r.document} · ${r.total ? `paragraphs ${first}–${last} of ${r.total.toLocaleString('en-US')}` : 'empty'} · ${plural(r.tables, 'table')} · ${plural(r.comments, 'comment')} · track changes ${r.tracking ? 'on' : 'off'}${r.revisions ? ` · ${plural(r.revisions, 'tracked change')} pending` : ''}`
  const lines = r.paragraphs.map((p) => `${p.n}${p.level ? ` [H${p.level}]` : ''}${p.cell ? ' [table]' : ''} ${p.text.replace(/[\n\u000b]+/g, ' ⏎ ')}`.trimEnd())
  return [head, r.note, ...lines, r.next ? `More follows: read from paragraph ${r.next}.` : ''].filter(Boolean).join('\n')
}

export interface SlideShape { i: number; name: string; kind: string; text?: string; table?: string[][]; clipped?: boolean }
export interface SlideInfo { n: number; layout: string; shapes: SlideShape[]; notes?: string }
export interface PptRead { presentation: string; path: string; total: number; slides: SlideInfo[]; next?: number; current?: number }

/** The text the model reads: each slide, its shapes by number, and each shape's paragraphs. */
export function pptReadText(r: PptRead): string {
  const out = [`${r.presentation} · ${plural(r.total, 'slide')}${r.current ? ` · slide ${r.current} is on screen` : ''}`]
  for (const s of r.slides) {
    out.push(`--- slide ${s.n} (${s.layout}) ---`)
    if (!s.shapes.length) out.push('  (no shapes)')
    for (const h of s.shapes) {
      out.push(`  shape ${h.i} "${h.name}" (${h.kind})${h.text === '' ? ' · empty' : ''}`)
      if (h.text) h.text.split(/\r|\n/).forEach((p, k) => out.push(`    ¶${k + 1} ${p.replace(/\u000b/g, ' ⏎ ')}`))
      if (h.table) { h.table.forEach((row, k) => out.push(`    row ${k + 1}\t${row.map((c) => c.replace(/\s+/g, ' ')).join('\t')}`)); if (h.clipped) out.push('    (table too large to show in full)') }
    }
    if (s.notes !== undefined) out.push(`  notes: ${s.notes ? s.notes.replace(/[\r\n\u000b]+/g, ' ⏎ ') : '(none)'}`)
  }
  if (r.next) out.push(`More follows: read from slide ${r.next}.`)
  return out.join('\n')
}
