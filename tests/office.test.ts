import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OfficeService, officeTools, type OfficeConfig } from '../src/main/office/service'
import { OfficeError, officeError, type OfficeBackend, type OfficeReq } from '../src/main/office/live'
import { officeNote, officeWhere, parseHexColor, parseSpan, pptReadText, wordReadText, type OfficeApp, type OfficePreview } from '../src/shared/office'
import type { ToolContext } from '../src/engine/tools/types'

/** Stands in for Word and PowerPoint: a document is a list of paragraphs, a deck is slides of text shapes. */
class Fake implements OfficeBackend {
  calls: OfficeReq[] = []
  opened: string[] = []
  on: Record<OfficeApp, boolean> = { word: true, powerpoint: true }
  docs: Record<string, string[]> = { 'Recap.docx': ['Quarterly recap', 'Sales rose 4 percent.', 'Margin held flat.'] }
  paths: Record<string, string> = {}
  decks: Record<string, Array<{ shapes: Array<{ name: string; text?: string; table?: string[][] }>; notes: string }>> = {
    'Q3.pptx': [{ shapes: [{ name: 'Title 1', text: 'Q3 results' }, { name: 'Body 2', text: 'Sales rose 4 percent\rMargin held flat' }], notes: 'Mention weather.' }]
  }
  installed() { return true }
  running(app: OfficeApp) { return this.on[app] }
  async open(app: OfficeApp, file: string) { this.opened.push(file); this.on[app] = true; const n = path.basename(file); this.paths[n] = file; if (app === 'word') this.docs[n] = ['From disk.']; else this.decks[n] = [] }
  private find<T>(set: Record<string, T>, q: OfficeReq, what: string): [string, T] {
    const names = Object.keys(set)
    const n = q.doc ? names.find((x) => x.toLowerCase() === String(q.doc).toLowerCase() || (!!q.path && this.paths[x] === q.path)) : names[0]
    if (!n) throw new OfficeError('not_open', q.doc ? `No open ${what} is named "${q.doc}".` : `No ${what} is open.`, names)
    return [n, set[n]]
  }
  async call<T>(q: OfficeReq): Promise<T> {
    this.calls.push(q)
    if (!this.on[q.app]) throw new OfficeError('not_running', 'not running')
    const a = q as any
    if (q.app === 'word') {
      if (q.op === 'status') return { docs: Object.keys(this.docs).map((n) => ({ name: n, path: this.paths[n] ?? '', saved: true, size: this.docs[n].length, tables: 0, comments: 0, tracking: false, at: 'paragraph 2' })), active: Object.keys(this.docs)[0] } as T
      const [name, ps] = this.find(this.docs, q, 'document')
      const same = (n: number) => { if (n > ps.length) throw new OfficeError('stale', `no paragraph ${n}`); if (a.before !== undefined && ps[n - 1] !== a.before) throw new OfficeError('stale', `Paragraph ${n} changed since it was read.`) }
      if (q.op === 'read') return { document: name, path: this.paths[name] ?? '', total: ps.length, tables: 0, comments: 0, revisions: 0, tracking: false, paragraphs: ps.map((text, i) => ({ n: i + 1, text, level: i === 0 ? 1 : 0 })).filter((p) => p.n >= a.from && p.n <= a.to) } as T
      if (q.op === 'edit') {
        const lines = String(a.text).split(/\r\n|\r|\n/)
        if (a.action === 'insert') { if (a.n) same(a.n); ps.splice(a.n, 0, ...lines); return { document: name, first: a.n + 1, count: lines.length, total: ps.length } as T }
        same(a.n)
        if (a.action === 'delete') { ps.splice(a.n - 1, 1); return { document: name, first: a.n, count: 0, total: ps.length } as T }
        ps.splice(a.n - 1, 1, ...lines); return { document: name, first: a.n, count: lines.length, total: ps.length } as T
      }
      if (q.op === 'format') { same(a.n); return { document: name } as T }
      if (q.op === 'comment') { same(a.n); return { document: name, comments: 1 } as T }
      if (q.op === 'table') { if (a.action === 'create') same(a.n); return { document: name, table: 1, rows: a.values.length, columns: a.values[0].length } as T }
    } else {
      if (q.op === 'status') return { docs: Object.keys(this.decks).map((n) => ({ name: n, path: '', saved: true, size: this.decks[n].length, at: 'slide 1' })), active: Object.keys(this.decks)[0] } as T
      const [name, slides] = this.find(this.decks, q, 'presentation')
      if (q.op === 'read') return { presentation: name, path: '', total: slides.length, current: 1, slides: slides.map((s, i) => ({ n: i + 1, layout: 'text slide', notes: s.notes, shapes: s.shapes.map((h, k) => ({ i: k + 1, name: h.name, kind: h.table ? 'table' : 'placeholder', text: h.text, table: h.table })) })).filter((s) => s.n >= a.from && s.n <= a.to) } as T
      if (q.op === 'edit') {
        const s = slides[a.slide - 1]
        if (a.target === 'notes') { if (a.before !== s.notes) throw new OfficeError('stale', 'The notes changed since they were read.'); s.notes = a.text; return { presentation: name } as T }
        const h = s.shapes[a.shape - 1]
        if (a.row) { a.values.forEach((r: any[], i: number) => r.forEach((v, j) => { if (v !== null) h.table![a.row - 1 + i][a.column - 1 + j] = v })); return { presentation: name } as T }
        const ps = h.text!.split('\r')
        if (a.paragraph) { if (ps[a.paragraph - 1] !== a.before) throw new OfficeError('stale', 'That paragraph changed since it was read.'); ps[a.paragraph - 1] = a.text; h.text = ps.join('\r') } else h.text = a.text
        return { presentation: name } as T
      }
      if (q.op === 'format') return { presentation: name } as T
      if (q.op === 'slide') {
        if (a.action === 'delete') { slides.splice(a.slide - 1, 1); return { presentation: name, slide: a.slide, total: slides.length } as T }
        const at = a.after ?? slides.length
        slides.splice(at, 0, { shapes: [{ name: 'Title 1', text: a.title ?? '' }], notes: a.notes ?? '' })
        return { presentation: name, slide: at + 1, total: slides.length, noBody: !!a.body && /blank|title only/.test(a.layout) } as T
      }
      if (q.op === 'shape') { const s = slides[a.slide - 1]; s.shapes.push(a.kind === 'table' ? { name: 'Table', table: a.values } : { name: 'TextBox', text: a.text }); return { presentation: name, slide: a.slide, shape: s.shapes.length } as T }
    }
    throw new Error(`fake: unhandled ${q.app}.${q.op}`)
  }
}

let fake: Fake, svc: OfficeService, cfg: OfficeConfig, ctx: ToolContext, asked: OfficePreview[], answer: boolean, dir: string
const tool = (n: string) => officeTools(svc).find((t) => t.name === n)!
const ops = (app: OfficeApp, op: string) => fake.calls.filter((c) => c.app === app && c.op === op)

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-'))
  fake = new Fake(); cfg = { enabled: true, confirm: 'ask', track: false, backup: true }; asked = []; answer = true
  svc = new OfficeService(fake, () => cfg, async () => {})
  ctx = { cwd: dir, agentId: 'main', gate: { check: async (_a: string, kind: string, detail: string) => { expect(kind).toBe('office'); asked.push(JSON.parse(detail)); return answer } } } as any
})

describe('helpers', () => {
  it('parses spans, colours and renders what the model reads', () => {
    expect(parseSpan('3', 10, 'p')).toEqual({ from: 3, to: 3 })
    expect(parseSpan('2-5', 4, 'p')).toEqual({ from: 2, to: 4 })
    expect(parseSpan(undefined, 7, 'p')).toEqual({ from: 1, to: 7 })
    expect(() => parseSpan('5-2', 9, 'paragraphs')).toThrow(/not a valid span/)
    expect(() => parseSpan('x', 9, 'paragraphs')).toThrow(/span such as/)
    expect(parseHexColor('#C00000')).toEqual([192, 0, 0])
    expect(() => parseHexColor('red')).toThrow(/#RRGGBB/)
    expect(wordReadText({ document: 'A.docx', path: '', total: 3, tables: 1, comments: 0, revisions: 2, tracking: true, next: 3, paragraphs: [{ n: 1, text: 'Title', level: 1 }, { n: 2, text: 'Cell', level: 0, cell: true }] }))
      .toBe('A.docx · paragraphs 1–2 of 3 · 1 table · 0 comments · track changes on · 2 tracked changes pending\n1 [H1] Title\n2 [table] Cell\nMore follows: read from paragraph 3.')
    expect(pptReadText({ presentation: 'D.pptx', path: '', total: 1, current: 1, slides: [{ n: 1, layout: 'text slide', notes: '', shapes: [{ i: 1, name: 'Title 1', kind: 'placeholder', text: 'Hi\rThere' }, { i: 2, name: 'T', kind: 'table', table: [['a', 'b']] }, { i: 3, name: 'Pic', kind: 'picture' }] }] }))
      .toBe('D.pptx · 1 slide · slide 1 is on screen\n--- slide 1 (text slide) ---\n  shape 1 "Title 1" (placeholder)\n    ¶1 Hi\n    ¶2 There\n  shape 2 "T" (table)\n    row 1\ta\tb\n  shape 3 "Pic" (picture)\n  notes: (none)')
  })
  it('turns macOS errors into something the user can act on', () => {
    expect(officeError('word', { num: -1743 })).toMatchObject({ code: 'permission' })
    expect(officeError('word', { num: -609, error: 'Connection is invalid.' })).toMatchObject({ code: 'not_running' })
    expect(officeError('powerpoint', { num: -1712 }).message).toMatch(/PowerPoint did not respond/)
    expect(officeError('word', { code: 'stale', error: 'changed' })).toMatchObject({ code: 'stale', message: 'changed' })
  })
})

describe('Word tools', () => {
  it('reads numbered paragraphs and reports what is open', async () => {
    expect(await tool('word_read').run({}, ctx)).toBe('Recap.docx · paragraphs 1–3 of 3 · 0 tables · 0 comments · track changes off\n1 [H1] Quarterly recap\n2 Sales rose 4 percent.\n3 Margin held flat.')
    expect(await tool('word_info').run({}, ctx)).toContain('- Recap.docx (active) · never saved')
    expect(asked).toHaveLength(0)
  })
  it('replaces one paragraph after showing before and after, and sends the text it read as a guard', async () => {
    const out = await tool('word_edit').run({ paragraph: 2, text: 'Sales rose 6 percent.', expect: '4 percent' }, ctx)
    expect(asked[0]).toMatchObject({ app: 'word', document: 'Recap.docx', changes: [{ where: 'paragraph 2', before: 'Sales rose 4 percent.', after: 'Sales rose 6 percent.' }] })
    expect(ops('word', 'edit')[0]).toMatchObject({ action: 'replace', n: 2, before: 'Sales rose 4 percent.', track: false })
    expect(fake.docs['Recap.docx'][1]).toBe('Sales rose 6 percent.')
    expect(out).toMatch(/^Replaced paragraph 2 in Recap\.docx\..*not saved.*⌘Z[\s\S]*--- before ---\nSales rose 4 percent\.$/)
  })
  it('refuses when the paragraph is not the one the model expects, and when the user declines', async () => {
    await expect(tool('word_edit').run({ paragraph: 3, text: 'x', expect: 'Sales rose' }, ctx)).rejects.toThrow(/Paragraph 3 does not contain "Sales rose".*Nothing was changed/)
    answer = false
    await expect(tool('word_edit').run({ paragraph: 2, text: 'x' }, ctx)).rejects.toThrow(/declined/)
    expect(ops('word', 'edit')).toHaveLength(0)
    expect(fake.docs['Recap.docx'][1]).toBe('Sales rose 4 percent.')
  })
  it('reports a paragraph the user changed in the meantime instead of overwriting it', async () => {
    ctx = { ...ctx, gate: { check: async () => { fake.docs['Recap.docx'][1] = 'Sales rose 5 percent (edited by me).'; return true } } } as any
    await expect(tool('word_edit').run({ paragraph: 2, text: 'Sales rose 6 percent.' }, ctx)).rejects.toThrow(/changed since it was read.*Nothing was changed\. Read it again and retry/)
    expect(fake.docs['Recap.docx'][1]).toBe('Sales rose 5 percent (edited by me).')
  })
  it('inserts several paragraphs, deletes one, and says the numbers shifted', async () => {
    const out = await tool('word_edit').run({ action: 'insert_after', paragraph: 1, text: 'One.\nTwo.', style: 'List Bullet' }, ctx)
    expect(out).toContain('Inserted 2 paragraphs as paragraphs 2–3')
    expect(out).toContain('Paragraph numbers after 3 have shifted; the document now has 5')
    expect(fake.docs['Recap.docx']).toEqual(['Quarterly recap', 'One.', 'Two.', 'Sales rose 4 percent.', 'Margin held flat.'])
    expect(await tool('word_edit').run({ action: 'delete', paragraph: 2 }, ctx)).toContain('Deleted paragraph 2')
    expect(await tool('word_edit').run({ action: 'insert_after', paragraph: 0, text: 'DRAFT' }, ctx)).toContain('as paragraph 1')
    await expect(tool('word_edit').run({ action: 'replace', paragraph: 99, text: 'x' }, ctx)).rejects.toThrow(/there is no paragraph 99/)
  })
  it('tracks changes when the setting or the call asks for it', async () => {
    cfg.track = true
    expect(await tool('word_edit').run({ paragraph: 2, text: 'A.' }, ctx)).toContain('tracked change the user can accept or reject')
    expect(asked[0].summary).toContain('Made as a tracked change')
    await tool('word_edit').run({ paragraph: 2, text: 'B.', track: false }, ctx)
    expect(ops('word', 'edit').map((c) => c.track)).toEqual([true, false])
  })
  it('formats a phrase or whole paragraphs, validating names before asking', async () => {
    expect(await tool('word_format').run({ paragraphs: '2', phrase: '4 percent', bold: true, highlight: 'Yellow' }, ctx)).toContain('Formatted "4 percent" in paragraph 2 in Recap.docx: bold, yellow highlight')
    expect(ops('word', 'format')[0]).toMatchObject({ n: 2, n2: 2, phrase: '4 percent', bold: true, highlight: 'yellow', before: 'Sales rose 4 percent.' })
    await tool('word_format').run({ paragraphs: '2-9', style: 'Heading 2' }, ctx)
    expect(ops('word', 'format')[1]).toMatchObject({ n: 2, n2: 3, style: 'Heading 2' })
    await expect(tool('word_format').run({ paragraphs: '2', color: 'chartreuse' }, ctx)).rejects.toThrow(/not available; use one of/)
    await expect(tool('word_format').run({ paragraphs: '2' }, ctx)).rejects.toThrow(/nothing to format/)
    await expect(tool('word_format').run({ paragraphs: '1-2', phrase: 'x', bold: true }, ctx)).rejects.toThrow(/within one paragraph/)
    await expect(tool('word_format').run({ paragraphs: '2', phrase: 'absent', bold: true }, ctx)).rejects.toThrow(/does not contain "absent"/)
  })
  it('adds comments and tables', async () => {
    expect(await tool('word_comment').run({ paragraph: 2, phrase: '4 percent', text: 'Check this.' }, ctx)).toContain('Added a comment on "4 percent" in paragraph 2')
    expect(await tool('word_table').run({ after_paragraph: 3, values: [['Region', 'Sales'], ['North']] }, ctx)).toContain('Inserted table 1 (2 rows × 2 columns) after paragraph 3')
    expect(ops('word', 'table')[0]).toMatchObject({ action: 'create', n: 3, values: [['Region', 'Sales'], ['North', '']], before: 'Margin held flat.' })
    await expect(tool('word_table').run({ action: 'add_row', table: 1, values: [['a'], ['b']] }, ctx)).rejects.toThrow(/one row/)
    await expect(tool('word_table').run({ after_paragraph: 1, values: 'x' }, ctx)).rejects.toThrow(/array of rows/)
  })
  it('opens a file that is not open yet, backs it up once, and refuses the wrong kind of file', async () => {
    const f = path.join(dir, 'Plan.docx'); fs.writeFileSync(f, 'x'); fs.writeFileSync(path.join(dir, 'data.xlsx'), 'x')
    fake.on.word = false
    expect(await tool('word_read').run({ document: 'Plan.docx' }, ctx)).toContain('Plan.docx · paragraphs 1–1 of 1')
    expect(fake.opened).toEqual([f])
    const out = await tool('word_edit').run({ document: 'Plan.docx', paragraph: 1, text: 'New.' }, ctx)
    expect(out).toContain(`Backup of the last saved version: ${path.join(dir, 'Plan.backup.docx')}`)
    expect(fs.existsSync(path.join(dir, 'Plan.backup.docx'))).toBe(true)
    expect(await tool('word_edit').run({ document: 'Plan.docx', paragraph: 1, text: 'Newer.' }, ctx)).not.toContain('Backup of')
    await expect(tool('word_read').run({ document: 'data.xlsx' }, ctx)).rejects.toThrow(/not a Word file/)
    await expect(tool('word_read').run({ document: 'Missing.docx' }, ctx)).rejects.toThrow(/not open in Word and no such file exists/)
  })
  it('says so when Word is closed or the tools are off', async () => {
    fake.on.word = false
    expect(await tool('word_info').run({}, ctx)).toMatch(/Word is not running/)
    await expect(tool('word_read').run({}, ctx)).rejects.toThrow(/Word is not running, so there is no open document/)
    cfg.enabled = false
    await expect(tool('word_read').run({}, ctx)).rejects.toThrow(/turned off in Settings/)
  })
})

describe('PowerPoint tools', () => {
  it('reads slides, shapes, paragraphs and notes', async () => {
    expect(await tool('powerpoint_read').run({}, ctx)).toBe('Q3.pptx · 1 slide · slide 1 is on screen\n--- slide 1 (text slide) ---\n  shape 1 "Title 1" (placeholder)\n    ¶1 Q3 results\n  shape 2 "Body 2" (placeholder)\n    ¶1 Sales rose 4 percent\n    ¶2 Margin held flat\n  notes: Mention weather.')
  })
  it('replaces one bullet, a whole shape, and the notes, guarding each with what it read', async () => {
    expect(await tool('powerpoint_edit').run({ slide: 1, shape: 2, paragraph: 1, text: 'Sales rose 6 percent', expect: '4 percent' }, ctx)).toMatch(/^Replaced paragraph 1 of "Body 2" on slide 1 of Q3\.pptx\./)
    expect(asked[0]).toMatchObject({ app: 'powerpoint', changes: [{ where: 'slide 1, shape 2 "Body 2", paragraph 1', before: 'Sales rose 4 percent', after: 'Sales rose 6 percent' }] })
    expect(ops('powerpoint', 'edit')[0]).toMatchObject({ slide: 1, shape: 2, paragraph: 1, before: 'Sales rose 4 percent' })
    expect(await tool('powerpoint_edit').run({ slide: 1, shape: 1, text: 'Q3 highlights' }, ctx)).toContain('resets formatting')
    expect(await tool('powerpoint_edit').run({ slide: 1, notes: true, text: 'New notes.' }, ctx)).toContain('Replaced the speaker notes of slide 1')
    expect(fake.decks['Q3.pptx'][0]).toMatchObject({ notes: 'New notes.', shapes: [{ text: 'Q3 highlights' }, { text: 'Sales rose 6 percent\rMargin held flat' }] })
    await expect(tool('powerpoint_edit').run({ slide: 1, shape: 2, paragraph: 9, text: 'x' }, ctx)).rejects.toThrow(/there is no paragraph 9/)
    await expect(tool('powerpoint_edit').run({ slide: 1, shape: 7, text: 'x' }, ctx)).rejects.toThrow(/there is no shape 7/)
    await expect(tool('powerpoint_edit').run({ slide: 4, shape: 1, text: 'x' }, ctx)).rejects.toThrow(/there is no slide 4/)
    await expect(tool('powerpoint_edit').run({ slide: 1, shape: 2, paragraph: 2, text: 'x', expect: 'Traffic' }, ctx)).rejects.toThrow(/does not contain "Traffic"/)
  })
  it('adds and deletes slides, and adds a text box and a table', async () => {
    expect(await tool('powerpoint_slide').run({ title: 'Next steps', body: 'One\nTwo', notes: 'n' }, ctx)).toContain('Added slide 2 to Q3.pptx (2 slides now)')
    expect(ops('powerpoint', 'slide')[0]).toMatchObject({ action: 'add', layout: 'text slide', title: 'Next steps', body: 'One\nTwo' })
    expect(await tool('powerpoint_slide').run({ after: 0, layout: 'Title Only', title: 'Agenda', body: 'x' }, ctx)).toMatch(/Added slide 1.*moved down by one.*no body placeholder/)
    await expect(tool('powerpoint_slide').run({ layout: 'fancy' }, ctx)).rejects.toThrow(/not available; use one of: title, title_and_content/)
    await expect(tool('powerpoint_slide').run({ after: 9 }, ctx)).rejects.toThrow(/cannot add after slide 9/)
    expect(await tool('powerpoint_add').run({ slide: 2, text: 'Source: finance' }, ctx)).toContain('Added a text box to slide 2 of Q3.pptx as shape 3')
    expect(await tool('powerpoint_add').run({ slide: 2, values: [['Region', 'Sales'], ['North', 120]] }, ctx)).toContain('Added a table (2 × 2) to slide 2')
    expect(await tool('powerpoint_edit').run({ slide: 2, shape: 4, row: 2, column: 2, values: [['135']] }, ctx)).toContain('--- before ---\n120')
    expect(await tool('powerpoint_slide').run({ action: 'delete', slide: 1 }, ctx)).toContain('Deleted slide 1 of Q3.pptx; it now has 2 slides')
    await expect(tool('powerpoint_add').run({ slide: 1 }, ctx)).rejects.toThrow(/text is required/)
  })
  it('formats with a hex colour and asks first', async () => {
    expect(await tool('powerpoint_format').run({ slide: 1, shape: 2, paragraph: 1, bold: true, color: '#C00000', size: 28 }, ctx)).toContain('bold, 28 pt, colour #C00000')
    expect(ops('powerpoint', 'format')[0]).toMatchObject({ color: [192, 0, 0], size: 28, bold: true })
    await expect(tool('powerpoint_format').run({ slide: 1, shape: 2, color: 'red' }, ctx)).rejects.toThrow(/#RRGGBB/)
  })
})

describe('shared behaviour', () => {
  it('never asks when the setting says so, and runs calls in the order they were made', async () => {
    cfg.confirm = 'never'
    const a = tool('word_edit').run({ action: 'insert_after', paragraph: 1, text: 'New.' }, ctx)
    const b = tool('word_read').run({}, ctx)
    await a
    expect(await b).toContain('2 New.')
    expect(asked).toHaveLength(0)
  })
  it('reports status per app without touching an app that is closed', async () => {
    fake.on.powerpoint = false
    const st = await svc.status(true)
    expect(st.word).toMatchObject({ running: true, permission: 'granted', active: 'Recap.docx' })
    expect(st.powerpoint).toMatchObject({ running: false, docs: [] })
    expect(fake.calls.filter((c) => c.app === 'powerpoint')).toHaveLength(0)
  })
  it('attaches an open document or presentation as a reference, not its content', async () => {
    const w = await svc.attach('word', 'Recap.docx')
    expect(w.meta).toMatchObject({ name: 'Recap.docx', kind: 'doc', office: 'word', info: 'paragraph 2' })
    expect(w.att).toMatchObject({ kind: 'text', name: 'Recap.docx', note: 'Word document, open in Word' })
    const text = (w.att as { text: string }).text
    expect(text).toMatch(/word_\* tools with document "Recap\.docx"/)
    expect(text).toMatch(/cursor is in paragraph 2/)
    expect(text).toMatch(/3 paragraphs · 0 tables · 0 comments · track changes off/)
    expect(text).toMatch(/Never saved to disk/)
    expect(text).not.toMatch(/Sales rose/)
    const p = await svc.attach('powerpoint', 'Q3.pptx')
    expect(p.meta).toMatchObject({ office: 'powerpoint', info: 'slide 1' })
    expect((p.att as { text: string }).text).toMatch(/powerpoint_\* tools with presentation "Q3\.pptx"[\s\S]*On the user's screen: slide 1[\s\S]*powerpoint_read/)
  })
  it('says so when the attached document was closed or the app quit', async () => {
    const gone = await svc.attach('word', 'Gone.docx')
    expect(gone.att).toBeUndefined()
    expect(gone.error).toMatch(/no longer open in Word/)
    expect(gone.meta).toMatchObject({ name: 'Gone.docx', office: 'word' })
    fake.on.powerpoint = false
    expect((await svc.attach('powerpoint', 'Q3.pptx')).error).toMatch(/no longer open in PowerPoint/)
  })
  it('describes the selection and falls back to the size when the cursor is unknown', () => {
    const d = { name: 'A.docx', path: '/x/A.docx', saved: true, size: 1, tables: 1, comments: 2, tracking: true }
    expect(officeWhere('word', d)).toBe('1 paragraph')
    expect(officeWhere('powerpoint', { ...d, size: 12 })).toBe('12 slides')
    const note = officeNote('word', { ...d, at: 'paragraphs 4–6', selection: 'Margin\rheld  flat' })
    expect(note).toMatch(/Path: \/x\/A\.docx/)
    expect(note).toMatch(/1 paragraph · 1 table · 2 comments · track changes on/)
    expect(note).toMatch(/current selection: "Margin held flat"/)
  })
})
