import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { ToolContext, ToolDef } from '../../engine/tools/types'
import { head, resolvePath } from '../../engine/tools/util'
import {
  OFFICE_NAME, SLIDE_LAYOUTS, WORD_COLORS, clipText, officeNote, officeWhere, parseHexColor, parseSpan, pptReadText, wordReadText,
  type OfficeApp, type OfficeAppStatus, type OfficeDoc, type OfficePreview, type OfficeStatus, type PptRead, type WordRead
} from '../../shared/office'
import { OfficeError, type OfficeBackend, type OfficeReq } from './live'
import type { AttachMeta } from '../../shared/attach'
import type { Attachment } from '../../engine/content'

export interface OfficeConfig {
  enabled: boolean
  /** 'ask': show the change and wait for the user before making it (autopilot chats never wait). */
  confirm: 'ask' | 'never'
  /** Word: make edits as tracked changes the user can accept or reject. A call's own `track` wins. */
  track: boolean
  /** Copy a saved document to name.backup.ext before the first edit. */
  backup: boolean
}

const OUT_MAX = 60_000
const READ_CHARS = 24_000
const EXT: Record<OfficeApp, RegExp> = { word: /\.(docx|doc|docm|rtf)$/i, powerpoint: /\.(pptx|ppt|pptm)$/i }
const UNIT: Record<OfficeApp, string> = { word: 'document', powerpoint: 'presentation' }

const str = (v: unknown, what: string): string => { if (typeof v !== 'string') throw new Error(`${what} is required (a string)`); return v }
const int = (v: unknown, what: string, min = 1): number => { const n = Number(v); if (!Number.isInteger(n) || n < min) throw new Error(`${what} must be a whole number of at least ${min}`); return n }
const opt = <T>(v: unknown, f: (v: unknown) => T): T | undefined => (v === undefined || v === null || v === '' ? undefined : f(v))
/** Rows of cell text: every row the same length; null leaves a cell as it is. */
function grid(v: unknown, allowNull: boolean): Array<Array<string | null>> {
  if (!Array.isArray(v) || !v.length || !v.every(Array.isArray)) throw new Error('values must be an array of rows, e.g. [["Region","Sales"],["North","120"]]')
  const w = Math.max(...v.map((r: unknown[]) => r.length))
  if (!w) throw new Error('values has no cells')
  if (v.length * w > 2_000) throw new Error('That is more than 2,000 cells; use a smaller table.')
  return v.map((r: unknown[]) => Array.from({ length: w }, (_, i) => (r[i] === null || r[i] === undefined ? (allowNull ? null : '') : String(r[i]))))
}

export class OfficeService {
  private permission: Record<OfficeApp, OfficeAppStatus['permission']> = { word: 'unknown', powerpoint: 'unknown' }
  private backedUp = new Set<string>()
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private live: OfficeBackend, private cfg: () => OfficeConfig, private wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {}

  /** `probe` talks to the apps, which makes macOS ask for permission the first time; without it only installed/running are reported. */
  async status(probe: boolean): Promise<OfficeStatus> {
    const one = async (app: OfficeApp): Promise<OfficeAppStatus> => {
      const st: OfficeAppStatus = { enabled: this.cfg().enabled, installed: this.live.installed(app), running: this.live.running(app), permission: this.permission[app], docs: [] }
      if (!st.running || !(probe || this.permission[app] === 'granted')) return st
      try {
        const r = await this.live.call<{ docs: OfficeDoc[]; active?: string }>({ app, op: 'status' })
        this.permission[app] = 'granted'
        return { ...st, permission: 'granted', docs: r.docs, active: r.active }
      } catch (e: any) {
        if (e instanceof OfficeError && e.code === 'permission') this.permission[app] = 'needed'
        return { ...st, permission: this.permission[app], error: e?.message ?? String(e) }
      }
    }
    return { word: await one('word'), powerpoint: await one('powerpoint') }
  }

  /** A chip for a document open in Word or a presentation open in PowerPoint: the model gets a reference (where the cursor is), not the content. */
  async attach(app: OfficeApp, name: string): Promise<{ id: string; att?: Attachment; meta: AttachMeta; error?: string }> {
    const id = randomUUID(), appName = OFFICE_NAME[app]
    const st = (await this.status(true))[app]
    const d = st.docs.find((x) => x.name === name)
    if (!d) return { id, meta: { name, kind: 'doc', info: `Not open in ${appName}`, office: app }, error: st.error ?? `${name} is no longer open in ${appName}` }
    return { id, att: { kind: 'text', name: d.name, text: officeNote(app, d), note: `${app === 'word' ? 'Word document' : 'PowerPoint presentation'}, open in ${appName}` }, meta: { name: d.name, kind: 'doc', info: officeWhere(app, d), office: app } }
  }

  /**
   * Runs work one call at a time, in the order the calls were made: a model often issues an edit and a follow-up
   * read in the same step, and paragraph numbers shift with every edit.
   */
  queued<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn)
    this.tail = run.catch(() => undefined)
    return run
  }

  private check(app: OfficeApp) {
    if (!this.cfg().enabled) throw new Error('Working with Word and PowerPoint is turned off in Settings → MS Office.')
    if (!this.live.installed(app)) throw new Error(`${OFFICE_NAME[app]} is not installed on this Mac.`)
  }

  /**
   * Sends a request to the app. A file path that is not open yet is opened first (in the background), so the user
   * sees the edits arrive. `mayOpen` is false for requests that must not start an app.
   */
  private async call<T>(app: OfficeApp, cwd: string, doc: string | undefined, req: Omit<OfficeReq, 'app' | 'doc' | 'path'>, mayOpen = true): Promise<T> {
    const name = OFFICE_NAME[app]
    const file = doc && (doc.includes('/') || doc.startsWith('~') || fs.existsSync(resolvePath(cwd, doc))) ? resolvePath(cwd, doc) : undefined
    const send = () => this.live.call<T>({ ...req, app, doc, path: file } as OfficeReq)
    const openFile = async (): Promise<T> => {
      if (!file || !fs.existsSync(file)) throw new Error(doc ? `"${doc}" is not open in ${name} and no such file exists in ${cwd}.` : `${name} is not running, so there is no open ${UNIT[app]}. Pass the path of a file as "document".`)
      if (!EXT[app].test(file)) throw new Error(`${path.basename(file)} is not a ${name} file.`)
      if (!mayOpen) throw new Error(`${path.basename(file)} is not open in ${name}.`)
      await this.live.open(app, file)
      // the app may be starting; it answers once the file is loaded
      let last: unknown
      for (let i = 0; i < 40; i++) {
        await this.wait(i < 4 ? 500 : 1000)
        try { return await send() } catch (e) { last = e; if (!(e instanceof OfficeError) || !['not_open', 'not_running', 'busy'].includes(e.code)) throw e }
      }
      throw new Error(`${name} did not finish opening ${path.basename(file)}. ${(last as Error)?.message ?? ''}`.trim())
    }
    try {
      if (!this.live.running(app)) return await openFile()
      try {
        const r = await send()
        this.permission[app] = 'granted'
        return r
      } catch (e) {
        if (!(e instanceof OfficeError)) throw e
        if (e.code === 'permission') this.permission[app] = 'needed'
        if (e.code === 'not_open' && file) return await openFile()
        if (e.code === 'not_open') throw new Error(`${doc ? `"${doc}" is not open in ${name} and no such file exists in ${cwd}.` : e.message} Open in ${name}: ${e.names.join(', ') || `no ${UNIT[app]}`}.`)
        if (e.code === 'not_running') return await openFile()
        throw e
      }
    } catch (e: any) {
      if (e instanceof OfficeError && e.code === 'stale') throw new Error(`${e.message} Nothing was changed. Read it again and retry.`)
      throw e
    }
  }

  private backup(file: string | undefined): string {
    if (!this.cfg().backup || !file || !path.isAbsolute(file) || this.backedUp.has(file) || !fs.existsSync(file)) return ''
    const ext = path.extname(file), copy = `${file.slice(0, file.length - ext.length)}.backup${ext}`
    try { fs.copyFileSync(file, copy); this.backedUp.add(file); return copy } catch { return '' }
  }

  private async confirm(ctx: ToolContext, p: OfficePreview): Promise<void> {
    if (this.cfg().confirm !== 'ask') return
    if (!(await ctx.gate.check(ctx.agentId, 'office', JSON.stringify(p)))) throw new Error('the user declined this change; nothing was changed')
  }

  private track(a: { track?: boolean }): boolean { return typeof a.track === 'boolean' ? a.track : this.cfg().track }
  private done(app: OfficeApp, saved: string, tracked = false): string {
    return `${tracked ? 'Made as a tracked change the user can accept or reject. ' : ''}The ${UNIT[app]} is changed in ${OFFICE_NAME[app]} but not saved; the user saves it${tracked ? '' : ', and can undo with ⌘Z'}.${saved ? ` Backup of the last saved version: ${saved}.` : ''}`
  }

  // ---------- shared ----------

  async info(cwd: string, app: OfficeApp, doc?: string): Promise<string> {
    this.check(app)
    const name = OFFICE_NAME[app], unit = app === 'word' ? 'paragraph' : 'slide'
    const describe = (d: OfficeDoc, active?: string) => [
      `- ${d.name}${d.name === active ? ' (active)' : ''} · ${d.path || 'never saved'}${d.saved ? '' : ' · unsaved changes'}`,
      `  ${d.size.toLocaleString('en-US')} ${unit}${d.size === 1 ? '' : 's'}${app === 'word' ? ` · ${d.tables ?? 0} table${d.tables === 1 ? '' : 's'} · ${d.comments ?? 0} comment${d.comments === 1 ? '' : 's'} · track changes ${d.tracking ? 'on' : 'off'}` : ''}`,
      d.at ? `  ${app === 'word' ? 'Cursor in' : 'On screen:'} ${d.at}${d.selection ? ` · selected: "${clipText(d.selection, 200)}"` : ''}` : ''
    ].filter(Boolean).join('\n')
    if (!doc && !this.live.running(app)) return `${name} is not running. Pass the path of a file as "document" to open it in ${name} and work on it.`
    const st = await this.call<{ docs: OfficeDoc[]; active?: string }>(app, cwd, undefined, { op: 'status' }, false)
    if (!doc) return st.docs.length ? `Open in ${name}:\n${st.docs.map((d) => describe(d, st.active)).join('\n')}` : `${name} is running with no ${UNIT[app]} open.`
    const file = resolvePath(cwd, doc)
    const d = st.docs.find((x) => x.name.toLowerCase() === doc.toLowerCase() || (!!x.path && x.path.toLowerCase() === file.toLowerCase()))
    if (!d) throw new Error(`"${doc}" is not open in ${name}. Open: ${st.docs.map((x) => x.name).join(', ') || 'nothing'}. Reading or editing a file path opens it.`)
    return describe(d, st.active)
  }

  // ---------- Word ----------

  async wordRead(cwd: string, a: { document?: string; paragraphs?: string; table?: number; max_chars?: number }): Promise<string> {
    this.check('word')
    const table = opt(a.table, (v) => int(v, 'table'))
    const span = table ? { from: 1, to: 1 } : parseSpan(a.paragraphs, Number.MAX_SAFE_INTEGER, 'paragraphs')
    const maxChars = Math.max(500, Math.min(OUT_MAX, Math.floor(a.max_chars ?? READ_CHARS)))
    const r = await this.call<WordRead>('word', cwd, a.document, { op: 'read', from: span.from, to: span.to, table, maxChars, maxParas: 600 })
    return head(wordReadText(r), OUT_MAX)
  }

  /** The current text of one paragraph, read just before an edit so the approval card shows what will change. */
  private async para(cwd: string, doc: string | undefined, n: number): Promise<{ r: WordRead; text: string }> {
    const r = await this.call<WordRead>('word', cwd, doc, { op: 'read', from: n, to: n, maxChars: 20_000, maxParas: 5 })
    if (n > r.total) throw new Error(`${r.document} has ${r.total} paragraph${r.total === 1 ? '' : 's'}; there is no paragraph ${n}. Nothing was changed.`)
    return { r, text: r.paragraphs.find((p) => p.n === n)?.text ?? '' }
  }

  async wordEdit(ctx: ToolContext, a: { document?: string; action?: string; paragraph?: number; text?: string; style?: string; expect?: string; track?: boolean }): Promise<string> {
    this.check('word')
    const action = a.action ?? 'replace'
    if (!['replace', 'insert_after', 'delete'].includes(action)) throw new Error('action is "replace", "insert_after" or "delete"')
    const n = int(a.paragraph, 'paragraph', action === 'insert_after' ? 0 : 1)
    const text = action === 'delete' ? '' : str(a.text, 'text')
    if (action === 'insert_after' && !text.trim()) throw new Error('text is empty; nothing to insert')
    const cur = n === 0 ? { r: await this.call<WordRead>('word', ctx.cwd, a.document, { op: 'read', from: 1, to: 1, maxChars: 200, maxParas: 1 }), text: '' } : await this.para(ctx.cwd, a.document, n)
    if (a.expect !== undefined && n > 0 && !cur.text.includes(a.expect)) throw new Error(`Paragraph ${n} does not contain "${clipText(a.expect, 80)}"; it reads: "${clipText(cur.text, 200)}". Nothing was changed. Read the document again.`)
    const tracked = this.track(a), count = text.split(/\r\n|\r|\n/).length
    const where = action === 'insert_after' ? (n === 0 ? 'the top of the document' : `after paragraph ${n}`) : `paragraph ${n}`
    const summary = action === 'replace' ? `Replace paragraph ${n}${a.style ? ` and set its style to ${a.style}` : ''}.`
      : action === 'delete' ? `Delete paragraph ${n}.`
      : `Insert ${count} paragraph${count === 1 ? '' : 's'} ${n === 0 ? 'at the top of the document' : `after paragraph ${n}`}${a.style ? `, style ${a.style}` : ''}.`
    await this.confirm(ctx, { app: 'word', document: cur.r.document, summary: `${summary}${tracked ? ' Made as a tracked change.' : ''}`,
      changes: [{ where, before: action === 'insert_after' ? (n === 0 ? undefined : `(after) ${clipText(cur.text, 300)}`) : clipText(cur.text, 600), after: action === 'delete' ? undefined : clipText(text, 600) }] })
    const saved = this.backup(cur.r.path)
    const r = await this.call<{ document: string; first: number; count: number; total: number }>('word', ctx.cwd, a.document,
      { op: 'edit', action: action === 'insert_after' ? 'insert' : action, n, before: n > 0 ? cur.text : undefined, text, style: a.style, track: tracked })
    const what = action === 'replace' ? `Replaced paragraph ${n}${r.count > 1 ? `; it is now paragraphs ${r.first}–${r.first + r.count - 1}` : ''}`
      : action === 'delete' ? `Deleted paragraph ${n}`
      : `Inserted ${r.count} paragraph${r.count === 1 ? '' : 's'} as paragraph${r.count === 1 ? ` ${r.first}` : `s ${r.first}–${r.first + r.count - 1}`}`
    const shift = action === 'replace' && r.count === 1 ? '' : ` Paragraph numbers after ${action === 'delete' ? n - 1 : r.first + r.count - 1} have shifted; the document now has ${r.total.toLocaleString('en-US')}${tracked && action !== 'insert_after' ? ' (tracked deletions still count until accepted)' : ''}.`
    return `${what} in ${r.document}.${shift} ${this.done('word', saved, tracked)}${action === 'insert_after' ? '' : `\n--- before ---\n${cur.text}`}`
  }

  async wordFormat(ctx: ToolContext, a: { document?: string; paragraphs?: string; phrase?: string; bold?: boolean; italic?: boolean; underline?: boolean; highlight?: string; color?: string; size?: number; style?: string; track?: boolean }): Promise<string> {
    this.check('word')
    if (a.paragraphs === undefined) throw new Error('paragraphs is required: a number or a span such as "3-5"')
    const span = parseSpan(a.paragraphs, Number.MAX_SAFE_INTEGER, 'paragraphs')
    if (a.phrase && span.to !== span.from) throw new Error('phrase works within one paragraph; give a single paragraph number')
    const named = (v: string | undefined, what: string, extra: string[] = []) => { if (v === undefined) return undefined; const k = v.toLowerCase().trim(); if (![...WORD_COLORS, ...extra].includes(k as any)) throw new Error(`${what} "${v}" is not available; use one of: ${[...extra, ...WORD_COLORS].join(', ')}`); return k }
    const f = { bold: a.bold, italic: a.italic, underline: a.underline, highlight: named(a.highlight, 'highlight', ['none']), color: named(a.color, 'color'), size: opt(a.size, (v) => { const n = Number(v); if (!(n >= 4 && n <= 200)) throw new Error('size is a font size in points, 4 to 200'); return n }), style: a.style }
    const what = [f.bold !== undefined && (f.bold ? 'bold' : 'not bold'), f.italic !== undefined && (f.italic ? 'italic' : 'not italic'), f.underline !== undefined && (f.underline ? 'underlined' : 'not underlined'), f.highlight && (f.highlight === 'none' ? 'clear highlight' : `${f.highlight} highlight`), f.color && `${f.color} text`, f.size && `${f.size} pt`, f.style && `style ${f.style}`].filter(Boolean)
    if (!what.length) throw new Error('nothing to format: pass bold, italic, underline, highlight, color, size or style')
    if (f.style && a.phrase) throw new Error('a style applies to whole paragraphs; leave out phrase')
    const cur = await this.para(ctx.cwd, a.document, span.from)
    if (a.phrase && !cur.text.includes(a.phrase)) throw new Error(`Paragraph ${span.from} does not contain "${clipText(a.phrase, 80)}"; it reads: "${clipText(cur.text, 200)}". Nothing was changed.`)
    const to = Math.min(span.to, cur.r.total)
    const where = a.phrase ? `"${clipText(a.phrase, 80)}" in paragraph ${span.from}` : to === span.from ? `paragraph ${span.from}` : `paragraphs ${span.from}–${to}`
    const tracked = this.track(a)
    await this.confirm(ctx, { app: 'word', document: cur.r.document, summary: `Format ${where}: ${what.join(', ')}. The text does not change.`, changes: [{ where, before: clipText(a.phrase ?? cur.text, 300) }] })
    const saved = this.backup(cur.r.path)
    const r = await this.call<{ document: string }>('word', ctx.cwd, a.document, { op: 'format', n: span.from, n2: to, before: cur.text, phrase: a.phrase, ...f, track: tracked })
    return `Formatted ${where} in ${r.document}: ${what.join(', ')}. ${this.done('word', saved, tracked)}`
  }

  async wordComment(ctx: ToolContext, a: { document?: string; paragraph?: number; phrase?: string; text?: string }): Promise<string> {
    this.check('word')
    const n = int(a.paragraph, 'paragraph'), text = str(a.text, 'text').trim()
    if (!text) throw new Error('text is empty; nothing to comment')
    const cur = await this.para(ctx.cwd, a.document, n)
    if (a.phrase && !cur.text.includes(a.phrase)) throw new Error(`Paragraph ${n} does not contain "${clipText(a.phrase, 80)}"; it reads: "${clipText(cur.text, 200)}". Nothing was changed.`)
    const where = a.phrase ? `"${clipText(a.phrase, 80)}" in paragraph ${n}` : `paragraph ${n}`
    await this.confirm(ctx, { app: 'word', document: cur.r.document, summary: `Add a comment on ${where}. The text does not change.`, changes: [{ where, before: clipText(a.phrase ?? cur.text, 300), after: `Comment: ${clipText(text, 500)}` }] })
    const r = await this.call<{ document: string; comments: number }>('word', ctx.cwd, a.document, { op: 'comment', n, before: cur.text, phrase: a.phrase, text })
    return `Added a comment on ${where} in ${r.document} (${r.comments} comment${r.comments === 1 ? '' : 's'} in the document). It appears under the user's own name. The document is not saved; the user saves it.`
  }

  async wordTable(ctx: ToolContext, a: { document?: string; action?: string; after_paragraph?: number; table?: number; row?: number; column?: number; values?: unknown; track?: boolean }): Promise<string> {
    this.check('word')
    const action = a.action ?? 'create'
    if (!['create', 'set', 'add_row'].includes(action)) throw new Error('action is "create", "set" or "add_row"')
    const tracked = this.track(a)
    if (action === 'create') {
      const n = int(a.after_paragraph, 'after_paragraph'), values = grid(a.values, false)
      const cur = await this.para(ctx.cwd, a.document, n)
      const size = `${values.length} row${values.length === 1 ? '' : 's'} × ${values[0].length} column${values[0].length === 1 ? '' : 's'}`
      await this.confirm(ctx, { app: 'word', document: cur.r.document, summary: `Insert a table (${size}) after paragraph ${n}.`, changes: [{ where: `after paragraph ${n}`, before: `(after) ${clipText(cur.text, 200)}`, after: values.slice(0, 6).map((r) => r.map((c) => clipText(c ?? '', 30)).join(' | ')).join('\n') }], more: values.length > 6 ? `Showing the first 6 of ${values.length} rows` : undefined })
      const saved = this.backup(cur.r.path)
      const r = await this.call<{ document: string; table: number }>('word', ctx.cwd, a.document, { op: 'table', action, n, before: cur.text, values, track: tracked })
      return `Inserted table ${r.table} (${size}) after paragraph ${n} in ${r.document}. Each cell is its own paragraph, so paragraph numbers after ${n} have shifted; read the document again before editing further. ${this.done('word', saved, tracked)}`
    }
    const t = int(a.table, 'table'), values = grid(a.values, true)
    if (action === 'add_row' && values.length !== 1) throw new Error('add_row takes one row of values, e.g. [["South","95"]]')
    const row = action === 'set' ? int(a.row ?? 1, 'row') : 0, column = action === 'set' ? int(a.column ?? 1, 'column') : 1
    const now = await this.call<WordRead>('word', ctx.cwd, a.document, { op: 'read', table: t, maxChars: 20_000, maxParas: 5 })
    const before = action === 'set' ? values.map((r, i) => r.map((_, j) => now.grid?.rows[row - 1 + i]?.[column - 1 + j] ?? '')) : []
    const cells = values.flat().filter((v) => v !== null).length
    const where = action === 'add_row' ? `table ${t}, new last row` : `table ${t}, from row ${row} column ${column}`
    const show = (g: Array<Array<string | null>>) => g.slice(0, 6).map((r) => r.map((c) => (c === null ? '·' : clipText(c, 30))).join(' | ')).join('\n')
    await this.confirm(ctx, { app: 'word', document: now.document, summary: action === 'add_row' ? `Add a row to table ${t}.` : `Change ${cells} cell${cells === 1 ? '' : 's'} in table ${t}.`, changes: [{ where, before: action === 'set' ? show(before) : undefined, after: show(values) }] })
    const saved = this.backup(now.path)
    const r = await this.call<{ document: string; rows: number; columns: number }>('word', ctx.cwd, a.document, { op: 'table', action, table: t, row, column, values, track: tracked })
    return `${action === 'add_row' ? `Added row ${r.rows} to` : `Changed ${cells} cell${cells === 1 ? '' : 's'} in`} table ${t} of ${r.document} (${r.rows} rows × ${r.columns} columns).${action === 'add_row' ? ' Paragraph numbers after the table have shifted.' : ''} ${this.done('word', saved, tracked)}${action === 'set' ? `\n--- before ---\n${show(before)}` : ''}`
  }

  // ---------- PowerPoint ----------

  async pptRead(cwd: string, a: { presentation?: string; slides?: string; notes?: boolean; max_chars?: number }): Promise<string> {
    this.check('powerpoint')
    const span = parseSpan(a.slides, Number.MAX_SAFE_INTEGER, 'slides')
    const maxChars = Math.max(500, Math.min(OUT_MAX, Math.floor(a.max_chars ?? READ_CHARS)))
    const r = await this.call<PptRead>('powerpoint', cwd, a.presentation, { op: 'read', from: span.from, to: span.to, notes: a.notes !== false, maxChars })
    return head(pptReadText(r), OUT_MAX)
  }

  private async slide(cwd: string, doc: string | undefined, n: number): Promise<{ r: PptRead; s: PptRead['slides'][number] }> {
    const r = await this.call<PptRead>('powerpoint', cwd, doc, { op: 'read', from: n, to: n, notes: true, maxChars: 40_000 })
    const s = r.slides.find((x) => x.n === n)
    if (!s) throw new Error(`${r.presentation} has ${r.total} slide${r.total === 1 ? '' : 's'}; there is no slide ${n}. Nothing was changed.`)
    return { r, s }
  }

  private shapeOf(s: PptRead['slides'][number], i: number) {
    const h = s.shapes.find((x) => x.i === i)
    if (!h) throw new Error(`Slide ${s.n} has ${s.shapes.length} shape${s.shapes.length === 1 ? '' : 's'}; there is no shape ${i}. Nothing was changed.`)
    return h
  }

  async pptEdit(ctx: ToolContext, a: { presentation?: string; slide?: number; shape?: number; paragraph?: number; notes?: boolean; text?: string; expect?: string; row?: number; column?: number; values?: unknown }): Promise<string> {
    this.check('powerpoint')
    const n = int(a.slide, 'slide')
    const { r, s } = await this.slide(ctx.cwd, a.presentation, n)
    const stale = (now: string) => { if (a.expect !== undefined && !now.includes(a.expect)) throw new Error(`That text does not contain "${clipText(a.expect, 80)}"; it reads: "${clipText(now, 200)}". Nothing was changed. Read the slide again.`) }
    if (a.notes) {
      const text = str(a.text, 'text'), now = s.notes ?? ''
      stale(now)
      await this.confirm(ctx, { app: 'powerpoint', document: r.presentation, summary: `Replace the speaker notes of slide ${n}.`, changes: [{ where: `slide ${n}, notes`, before: clipText(now, 600) || undefined, after: clipText(text, 600) }] })
      const saved = this.backup(r.path)
      await this.call('powerpoint', ctx.cwd, a.presentation, { op: 'edit', slide: n, target: 'notes', before: now, text })
      return `Replaced the speaker notes of slide ${n} in ${r.presentation}. ${this.done('powerpoint', saved)}${now ? `\n--- before ---\n${now}` : ''}`
    }
    const h = this.shapeOf(s, int(a.shape, 'shape'))
    if (a.values !== undefined) {
      if (!h.table) throw new Error(`Shape ${h.i} on slide ${n} ("${h.name}") is not a table. Nothing was changed.`)
      const values = grid(a.values, true), row = int(a.row ?? 1, 'row'), column = int(a.column ?? 1, 'column')
      const before = values.map((v, i) => v.map((_, j) => h.table?.[row - 1 + i]?.[column - 1 + j] ?? ''))
      const cells = values.flat().filter((v) => v !== null).length
      const show = (g: Array<Array<string | null>>) => g.slice(0, 6).map((v) => v.map((c) => (c === null ? '·' : clipText(c, 30))).join(' | ')).join('\n')
      await this.confirm(ctx, { app: 'powerpoint', document: r.presentation, summary: `Change ${cells} cell${cells === 1 ? '' : 's'} in the table on slide ${n}.`, changes: [{ where: `slide ${n}, shape ${h.i}, from row ${row} column ${column}`, before: show(before), after: show(values) }] })
      const saved = this.backup(r.path)
      await this.call('powerpoint', ctx.cwd, a.presentation, { op: 'edit', slide: n, shape: h.i, row, column, values })
      return `Changed ${cells} cell${cells === 1 ? '' : 's'} in the table on slide ${n} of ${r.presentation}. ${this.done('powerpoint', saved)}\n--- before ---\n${show(before)}`
    }
    if (h.text === undefined) throw new Error(`Shape ${h.i} on slide ${n} ("${h.name}", ${h.kind}) holds no text${h.table ? '; pass row, column and values to change its cells' : ''}. Nothing was changed.`)
    const text = str(a.text, 'text')
    const para = opt(a.paragraph, (v) => int(v, 'paragraph')), parts = h.text.split(/\r|\n/)
    if (para && para > parts.length) throw new Error(`Shape ${h.i} on slide ${n} has ${parts.length} paragraph${parts.length === 1 ? '' : 's'}; there is no paragraph ${para}. Nothing was changed.`)
    const now = para ? parts[para - 1] : h.text
    stale(now)
    const where = `slide ${n}, shape ${h.i} "${h.name}"${para ? `, paragraph ${para}` : ''}`
    await this.confirm(ctx, { app: 'powerpoint', document: r.presentation, summary: para ? `Replace paragraph ${para} of "${h.name}" on slide ${n}.` : `Replace the text of "${h.name}" on slide ${n}.`, changes: [{ where, before: clipText(now, 600) || undefined, after: clipText(text, 600) }] })
    const saved = this.backup(r.path)
    await this.call('powerpoint', ctx.cwd, a.presentation, { op: 'edit', slide: n, shape: h.i, paragraph: para, before: now, text })
    return `Replaced ${para ? `paragraph ${para} of ` : 'the text of '}"${h.name}" on slide ${n} of ${r.presentation}.${para ? '' : ' Replacing a whole shape resets formatting that differed between its paragraphs.'} ${this.done('powerpoint', saved)}${now ? `\n--- before ---\n${now}` : ''}`
  }

  async pptFormat(ctx: ToolContext, a: { presentation?: string; slide?: number; shape?: number; paragraph?: number; bold?: boolean; italic?: boolean; underline?: boolean; size?: number; color?: string }): Promise<string> {
    this.check('powerpoint')
    const n = int(a.slide, 'slide'), para = opt(a.paragraph, (v) => int(v, 'paragraph'))
    const f = { bold: a.bold, italic: a.italic, underline: a.underline, size: opt(a.size, (v) => { const x = Number(v); if (!(x >= 4 && x <= 400)) throw new Error('size is a font size in points, 4 to 400'); return x }), color: opt(a.color, (v) => parseHexColor(String(v))) }
    const what = [f.bold !== undefined && (f.bold ? 'bold' : 'not bold'), f.italic !== undefined && (f.italic ? 'italic' : 'not italic'), f.underline !== undefined && (f.underline ? 'underlined' : 'not underlined'), f.size && `${f.size} pt`, a.color && `colour ${a.color}`].filter(Boolean)
    if (!what.length) throw new Error('nothing to format: pass bold, italic, underline, size or color')
    const { r, s } = await this.slide(ctx.cwd, a.presentation, n)
    const h = this.shapeOf(s, int(a.shape, 'shape'))
    if (h.text === undefined) throw new Error(`Shape ${h.i} on slide ${n} ("${h.name}") holds no text. Nothing was changed.`)
    const where = `slide ${n}, shape ${h.i} "${h.name}"${para ? `, paragraph ${para}` : ''}`
    await this.confirm(ctx, { app: 'powerpoint', document: r.presentation, summary: `Format ${where}: ${what.join(', ')}. The text does not change.`, changes: [{ where, before: clipText(para ? h.text.split(/\r|\n/)[para - 1] ?? '' : h.text, 300) }] })
    const saved = this.backup(r.path)
    await this.call('powerpoint', ctx.cwd, a.presentation, { op: 'format', slide: n, shape: h.i, paragraph: para, ...f })
    return `Formatted ${where} in ${r.presentation}: ${what.join(', ')}. ${this.done('powerpoint', saved)}`
  }

  async pptSlide(ctx: ToolContext, a: { presentation?: string; action?: string; slide?: number; after?: number; layout?: string; title?: string; body?: string; notes?: string }): Promise<string> {
    this.check('powerpoint')
    const action = a.action ?? 'add'
    if (!['add', 'delete'].includes(action)) throw new Error('action is "add" or "delete"')
    if (action === 'delete') {
      const n = int(a.slide, 'slide')
      const { r, s } = await this.slide(ctx.cwd, a.presentation, n)
      const first = s.shapes[0]?.text ?? ''
      await this.confirm(ctx, { app: 'powerpoint', document: r.presentation, summary: `Delete slide ${n} of ${r.total}.`, changes: [{ where: `slide ${n}`, before: clipText(s.shapes.map((h) => h.text ?? (h.table ? '(table)' : '')).filter(Boolean).join(' / '), 400) || '(no text)' }] })
      const saved = this.backup(r.path)
      const d = await this.call<{ total: number }>('powerpoint', ctx.cwd, a.presentation, { op: 'slide', action, slide: n, before: first })
      return `Deleted slide ${n} of ${r.presentation}; it now has ${d.total} slide${d.total === 1 ? '' : 's'} and the slides after it moved up by one. ${this.done('powerpoint', saved)}`
    }
    const key = (a.layout ?? (a.body ? 'title_and_content' : 'title_only')).toLowerCase().replace(/[\s-]+/g, '_')
    const layout = SLIDE_LAYOUTS[key]
    if (!layout) throw new Error(`layout "${a.layout}" is not available; use one of: ${Object.keys(SLIDE_LAYOUTS).join(', ')}`)
    const after = opt(a.after, (v) => int(v, 'after', 0))
    const st = await this.call<PptRead>('powerpoint', ctx.cwd, a.presentation, { op: 'read', from: 1, to: 1, notes: false, maxChars: 500 })
    if (after !== undefined && after > st.total) throw new Error(`${st.presentation} has ${st.total} slide${st.total === 1 ? '' : 's'}; cannot add after slide ${after}. Nothing was changed.`)
    const at = after === undefined ? 'at the end' : after === 0 ? 'as the first slide' : `after slide ${after}`
    await this.confirm(ctx, { app: 'powerpoint', document: st.presentation, summary: `Add a slide ${at} (layout: ${key.replace(/_/g, ' ')}).`, changes: [{ where: `new slide ${at}`, after: [a.title && `Title: ${clipText(a.title, 200)}`, a.body && clipText(a.body, 500), a.notes && `Notes: ${clipText(a.notes, 200)}`].filter(Boolean).join('\n') || '(empty slide)' }] })
    const saved = this.backup(st.path)
    const d = await this.call<{ slide: number; total: number; noBody: boolean }>('powerpoint', ctx.cwd, a.presentation, { op: 'slide', action, after, layout, title: a.title, body: a.body, notes: a.notes })
    return `Added slide ${d.slide} to ${st.presentation} (${d.total} slides now)${after !== undefined && after < st.total ? '; the slides after it moved down by one' : ''}.${d.noBody ? ' That layout has no body placeholder, so the body text was not placed; add it with powerpoint_add.' : ''} ${this.done('powerpoint', saved)}`
  }

  async pptAdd(ctx: ToolContext, a: { presentation?: string; slide?: number; text?: string; values?: unknown; left?: number; top?: number; width?: number; height?: number }): Promise<string> {
    this.check('powerpoint')
    const n = int(a.slide, 'slide')
    const isTable = a.values !== undefined
    const values = isTable ? grid(a.values, false) : undefined
    const text = isTable ? '' : str(a.text, 'text')
    if (!isTable && !text.trim()) throw new Error('pass text for a text box, or values for a table')
    const pt = (v: unknown, d: number, what: string) => { if (v === undefined || v === null) return d; const x = Number(v); if (!(x >= 0 && x <= 4000)) throw new Error(`${what} is a distance in points`); return x }
    const box = { left: pt(a.left, 60, 'left'), top: pt(a.top, isTable ? 140 : 400, 'top'), width: pt(a.width, isTable ? 600 : 500, 'width'), height: pt(a.height, 40, 'height') }
    const { r } = await this.slide(ctx.cwd, a.presentation, n)
    const what = isTable ? `a table (${values!.length} × ${values![0].length})` : 'a text box'
    await this.confirm(ctx, { app: 'powerpoint', document: r.presentation, summary: `Add ${what} to slide ${n}.`, changes: [{ where: `slide ${n}, new shape`, after: isTable ? values!.slice(0, 6).map((v) => v.map((c) => clipText(c ?? '', 30)).join(' | ')).join('\n') : clipText(text, 500) }] })
    const saved = this.backup(r.path)
    const d = await this.call<{ shape: number }>('powerpoint', ctx.cwd, a.presentation, { op: 'shape', kind: isTable ? 'table' : 'text', slide: n, text, values, ...box })
    return `Added ${what} to slide ${n} of ${r.presentation} as shape ${d.shape}. Check its position on the slide; sizes are in points (a standard wide slide is 960 × 540). ${this.done('powerpoint', saved)}`
  }
}

const DOC = { type: 'string', description: 'Name of a document open in Word (e.g. "Recap.docx"), or the path of a Word file, which is opened in Word if it is not open yet. Omit for the active document.' }
const PRES = { type: 'string', description: 'Name of a presentation open in PowerPoint (e.g. "Q3.pptx"), or the path of a PowerPoint file, which is opened if it is not open yet. Omit for the active presentation.' }
const TRACK = { type: 'boolean', description: 'Make the change as a tracked change the user can accept or reject. Omit to follow the user\'s setting.' }
const VALUES = { type: 'array', items: { type: 'array', items: {} }, description: 'Rows of cell text, e.g. [["Region","Sales"],["North","120"]].' }

export const OFFICE_PROMPT = `# Word and PowerPoint
Use the word_* and powerpoint_* tools for Word documents and PowerPoint presentations: the file is edited live in the app while the user watches, and nothing is saved until the user saves. Prefer these tools over writing scripts or looking at screenshots. Always read before editing: Word is addressed by paragraph number and PowerPoint by slide, shape and paragraph number, and these numbers shift after an insert or delete, so read again before the next edit in the same area. Change the smallest unit that does the job (one paragraph, one bullet), and keep the user's wording and formatting elsewhere. If a tool reports that the text changed since it was read, the user is editing too: read again and retry.`

export function officeTools(svc: OfficeService): ToolDef[] {
  return [
    {
      name: 'word_info',
      description: 'List the documents open in Word with their size, tables, comments, whether track changes is on, and where the user\'s cursor or selection is. Pass "document" for one document.',
      parameters: { type: 'object', properties: { document: DOC } },
      run: (a, ctx) => svc.queued(() => svc.info(ctx.cwd, 'word', a.document))
    },
    {
      name: 'word_read',
      description: 'Read a Word document as numbered paragraphs, with headings marked [H1]…[H9] and table cells marked [table]. Pass "paragraphs" (e.g. "40-80") for part of a long document, or "table" (its number) to read one table as rows. Long documents come back in parts with the paragraph to continue from.',
      parameters: { type: 'object', properties: { document: DOC, paragraphs: { type: 'string', description: 'A paragraph number or span such as "40-80". Omit for the whole document.' }, table: { type: 'integer', description: 'Read this table (1 = first) as rows and columns.' }, max_chars: { type: 'integer' } } },
      run: (a, ctx) => svc.queued(() => svc.wordRead(ctx.cwd, a))
    },
    {
      name: 'word_edit',
      description: 'Change the text of a Word document, one paragraph at a time. action "replace" (default) replaces the text of paragraph N and keeps its style; "insert_after" adds new paragraph(s) after paragraph N (0 = at the top), one per line of "text"; "delete" removes paragraph N. Pass "expect" (a few words the paragraph should contain) to be sure the right paragraph is changed. "style" names a paragraph style such as "Heading 2" or "List Bullet". Not for table cells: use word_table.',
      parameters: { type: 'object', properties: { document: DOC, action: { type: 'string', enum: ['replace', 'insert_after', 'delete'] }, paragraph: { type: 'integer', description: 'Paragraph number from word_read.' }, text: { type: 'string' }, style: { type: 'string' }, expect: { type: 'string' }, track: TRACK }, required: ['paragraph'] },
      run: (a, ctx) => svc.queued(() => svc.wordEdit(ctx, a))
    },
    {
      name: 'word_format',
      description: `Format text in a Word document without changing it: bold, italic, underline, highlight, text colour, font size, or a paragraph style. Applies to whole paragraph(s), or to one "phrase" inside a single paragraph. Highlight and color take a name: ${WORD_COLORS.join(', ')} (highlight also "none").`,
      parameters: { type: 'object', properties: { document: DOC, paragraphs: { type: 'string', description: 'A paragraph number or span such as "3-5".' }, phrase: { type: 'string', description: 'Exact text inside the paragraph to format instead of the whole paragraph.' }, bold: { type: 'boolean' }, italic: { type: 'boolean' }, underline: { type: 'boolean' }, highlight: { type: 'string' }, color: { type: 'string' }, size: { type: 'number' }, style: { type: 'string' }, track: TRACK }, required: ['paragraphs'] },
      run: (a, ctx) => svc.queued(() => svc.wordFormat(ctx, a))
    },
    {
      name: 'word_comment',
      description: 'Add a review comment to a Word document, attached to a paragraph or to one "phrase" inside it. Use this to suggest or question something without changing the text.',
      parameters: { type: 'object', properties: { document: DOC, paragraph: { type: 'integer' }, phrase: { type: 'string' }, text: { type: 'string', description: 'The comment.' } }, required: ['paragraph', 'text'] },
      run: (a, ctx) => svc.queued(() => svc.wordComment(ctx, a))
    },
    {
      name: 'word_table',
      description: 'Work with tables in a Word document. action "create" (default) inserts a table filled with "values" after paragraph "after_paragraph"; "set" writes "values" into table number "table" starting at "row" and "column" (null leaves a cell as it is); "add_row" appends one row of values to the table. Read a table with word_read.',
      parameters: { type: 'object', properties: { document: DOC, action: { type: 'string', enum: ['create', 'set', 'add_row'] }, after_paragraph: { type: 'integer' }, table: { type: 'integer', description: '1 = the first table in the document.' }, row: { type: 'integer' }, column: { type: 'integer' }, values: VALUES, track: TRACK }, required: ['values'] },
      run: (a, ctx) => svc.queued(() => svc.wordTable(ctx, a))
    },
    {
      name: 'powerpoint_info',
      description: 'List the presentations open in PowerPoint with their slide count, the slide on screen and what the user has selected. Pass "presentation" for one.',
      parameters: { type: 'object', properties: { presentation: PRES } },
      run: (a, ctx) => svc.queued(() => svc.info(ctx.cwd, 'powerpoint', a.presentation))
    },
    {
      name: 'powerpoint_read',
      description: 'Read a PowerPoint presentation: each slide with its layout, its shapes by number (title, body, text boxes, tables), each shape\'s paragraphs, and the speaker notes. Pass "slides" (e.g. "3" or "5-9") for part of a long deck.',
      parameters: { type: 'object', properties: { presentation: PRES, slides: { type: 'string', description: 'A slide number or span such as "5-9". Omit for every slide.' }, notes: { type: 'boolean', description: 'Include speaker notes (default true).' }, max_chars: { type: 'integer' } } },
      run: (a, ctx) => svc.queued(() => svc.pptRead(ctx.cwd, a))
    },
    {
      name: 'powerpoint_edit',
      description: 'Change text on a slide. Give "slide" and "shape" (numbers from powerpoint_read) and "text": with "paragraph" only that paragraph (bullet) is replaced and the rest keeps its formatting; without it the whole shape\'s text is replaced, one paragraph per line. Set "notes": true (no shape) to replace the speaker notes. For a table shape pass "values" with "row" and "column" (null leaves a cell as it is). Pass "expect" to be sure the right text is changed.',
      parameters: { type: 'object', properties: { presentation: PRES, slide: { type: 'integer' }, shape: { type: 'integer' }, paragraph: { type: 'integer' }, notes: { type: 'boolean' }, text: { type: 'string' }, expect: { type: 'string' }, row: { type: 'integer' }, column: { type: 'integer' }, values: VALUES }, required: ['slide'] },
      run: (a, ctx) => svc.queued(() => svc.pptEdit(ctx, a))
    },
    {
      name: 'powerpoint_format',
      description: 'Format text on a slide without changing it: bold, italic, underline, font size in points, or colour ("#RRGGBB"). Applies to a whole shape, or to one "paragraph" of it.',
      parameters: { type: 'object', properties: { presentation: PRES, slide: { type: 'integer' }, shape: { type: 'integer' }, paragraph: { type: 'integer' }, bold: { type: 'boolean' }, italic: { type: 'boolean' }, underline: { type: 'boolean' }, size: { type: 'number' }, color: { type: 'string' } }, required: ['slide', 'shape'] },
      run: (a, ctx) => svc.queued(() => svc.pptFormat(ctx, a))
    },
    {
      name: 'powerpoint_slide',
      description: `Add or delete a slide. action "add" (default) creates a slide with "layout" (${Object.keys(SLIDE_LAYOUTS).join(', ')}) and fills its "title", "body" (one bullet per line) and speaker "notes"; it goes at the end, or after slide "after" (0 = first). action "delete" removes slide "slide". Slides cannot be reordered.`,
      parameters: { type: 'object', properties: { presentation: PRES, action: { type: 'string', enum: ['add', 'delete'] }, slide: { type: 'integer' }, after: { type: 'integer' }, layout: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, notes: { type: 'string' } } },
      run: (a, ctx) => svc.queued(() => svc.pptSlide(ctx, a))
    },
    {
      name: 'powerpoint_add',
      description: 'Add a text box ("text") or a table ("values") to a slide. Optional left, top, width, height are in points from the slide\'s top-left corner (a standard wide slide is 960 × 540).',
      parameters: { type: 'object', properties: { presentation: PRES, slide: { type: 'integer' }, text: { type: 'string' }, values: VALUES, left: { type: 'number' }, top: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } }, required: ['slide'] },
      run: (a, ctx) => svc.queued(() => svc.pptAdd(ctx, a))
    }
  ]
}
