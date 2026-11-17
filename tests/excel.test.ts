import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { addr, blockRect, cellTest, gridText, matchAreas, normalizeValues, parseColor, parseGrid, parseRef, sections, sheetRef, workbookNote, type ExcelPreview } from '../src/shared/excel'
import { ExcelService, excelTools, type ExcelConfig } from '../src/main/excel/service'
import { LiveError, liveError, type LiveBackend, type LiveReq } from '../src/main/excel/live'
import { fileRead, riskyParts } from '../src/main/excel/file'
import type { ToolContext } from '../src/engine/tools/types'
import type { AttachMeta } from '../src/shared/attach'

describe('range and grid helpers', () => {
  it('parses A1 references with sheet names, absolute markers and reversed corners', () => {
    expect(parseRef('B2')).toEqual({ sheet: undefined, r1: 2, c1: 2, r2: 2, c2: 2 })
    expect(parseRef("'My sheet'!$C$10:$A$1")).toEqual({ sheet: 'My sheet', r1: 1, c1: 1, r2: 10, c2: 3 })
    expect(parseRef('Sales!AA1:AB2').c2).toBe(28)
    expect(() => parseRef('A:A')).toThrow(/not a cell range/)
    expect(() => parseRef('A0')).toThrow()
    expect(addr(blockRect(1, 7, [[1], [2], [3]]))).toBe('G1:G3')
    expect(sheetRef('My sheet', parseRef('A1'))).toBe("'My sheet'!A1")
  })

  it('pads ragged rows and rejects values that are not rows', () => {
    expect(normalizeValues([[1, 'a'], [2]])).toEqual([[1, 'a'], [2, null]])
    expect(() => normalizeValues('x')).toThrow(/array of rows/)
  })

  it('round-trips a block through the text the model reads and the chat renders', () => {
    const t = gridText(2, 2, [['Store', 3], ['a\tb', null]])
    expect(t).toBe('\tB\tC\n2\tStore\t3\n3\ta b\t')
    expect(parseGrid(t)).toEqual({ cols: ['B', 'C'], rows: [{ n: '2', cells: ['Store', '3'] }, { n: '3', cells: ['a b', ''] }] })
    expect(parseGrid('not a grid')).toBeNull()
    const s = sections(`Wrote 2 cells.\n--- now ---\n${t}\n--- before ---\n${t}\nTo undo, write it back.`)
    expect(s.summary).toBe('Wrote 2 cells.')
    expect(s.parts.map((p) => p.title)).toEqual(['now', 'before'])
  })

  it('reads colours and describes an attached workbook, including its selection', () => {
    expect(parseColor('#ff0000')).toEqual([255, 0, 0])
    expect(parseColor('yellow')).toEqual([255, 235, 156])
    expect(() => parseColor('nope')).toThrow(/not a colour/)
    const note = workbookNote({ name: 'B.xlsx', path: '/x/B.xlsx', mode: 'live', sheets: [{ name: 'Sales', used: 'A1:F40' }], activeSheet: 'Sales', selection: 'B2:F40' })
    expect(note).toContain('workbook "B.xlsx"')
    expect(note).toContain('Sales!B2:F40')
    // a multi-area selection is passed through rather than failing
    expect(workbookNote({ name: 'B.xlsx', path: '', mode: 'live', sheets: [], activeSheet: 'S', selection: 'A1:A2,C1' })).toContain('S!A1:A2,C1')
  })

  it('tests cells against a condition and groups the matches', () => {
    expect([0.19, 0.2, '', 'x'].map(cellTest('<0.2'))).toEqual([true, false, false, false])
    expect([0.19, 0.2].map(cellTest('<20%'))).toEqual([true, false])
    expect([1500, 999].map(cellTest('>= 1,000'))).toEqual([true, false])
    expect(['Closed', 'open', ''].map(cellTest('=closed'))).toEqual([true, false, false])
    expect(['Closed', 'open'].map(cellTest('<>Closed'))).toEqual([false, true])
    expect(['', null, 0].map(cellTest('blank'))).toEqual([true, true, false])
    expect(() => cellTest('<abc')).toThrow(/text can only be tested/)
    expect(matchAreas(parseRef('G2:G6'), [[0.1], [0.3], [0.1], [0.1], [0.5]], cellTest('<0.2')).map(addr)).toEqual(['G2', 'G4:G5'])
  })

  it('maps Apple-event failures to something the user can act on', () => {
    expect(liveError({ num: -1743, error: 'Not authorized to send Apple events to Microsoft Excel.' }).code).toBe('permission')
    expect(liveError({ num: -1712 }).message).toMatch(/Finish editing the cell/)
    expect(liveError({ code: 'no_sheet', error: 'x', names: ['A'] }).names).toEqual(['A'])
  })
})

class FakeExcel implements LiveBackend {
  calls: LiveReq[] = []
  isRunning = true
  open: Record<string, Record<string, Record<string, unknown>>> = {}
  fail?: LiveError
  installed() { return true }
  running() { return this.isRunning }
  async call<T>(req: LiveReq): Promise<T> {
    this.calls.push(req)
    if (this.fail) throw this.fail
    if (req.op === 'status') return { workbooks: Object.keys(this.open).map((name) => ({ name, path: '', mode: 'live', sheets: Object.keys(this.open[name]).map((s) => ({ name: s, used: 'A1' })), activeSheet: 'Sales', selection: 'A1' })), active: Object.keys(this.open)[0] } as any
    const name = Object.keys(this.open).find((n) => n.toLowerCase() === String(req.workbook ?? Object.keys(this.open)[0]).toLowerCase())
    if (!name) throw new LiveError('not_open', 'not open', Object.keys(this.open))
    const sheet = req.sheet ?? 'Sales'
    if (!this.open[name][sheet]) { if (req.op === 'write' && req.create) this.open[name][sheet] = {}; else throw new LiveError('no_sheet', `Workbook "${name}" has no sheet named "${sheet}".`, Object.keys(this.open[name])) }
    const cells = this.open[name][sheet], q = parseRef(req.range ?? 'A1')
    const grid = () => Array.from({ length: q.r2 - q.r1 + 1 }, (_, r) => Array.from({ length: q.c2 - q.c1 + 1 }, (_, c) => cells[addr({ r1: q.r1 + r, c1: q.c1 + c, r2: q.r1 + r, c2: q.c1 + c })] ?? ''))
    if (req.op === 'write') req.values.forEach((row, r) => row.forEach((v, c) => { cells[addr({ r1: q.r1 + r, c1: q.c1 + c, r2: q.r1 + r, c2: q.c1 + c })] = v ?? '' }))
    const base = { workbook: name, path: '', sheet, range: addr(q) }
    if (req.op === 'read') return { ...base, total: addr(q), values: grid(), formulas: grid().map((r) => r.map(String)), truncated: false } as any
    if (req.op === 'write') return { ...base, created: false, values: grid() } as any
    return base as any
  }
}

describe('Excel tools', () => {
  let dir: string, fake: FakeExcel, cfg: ExcelConfig, asked: ExcelPreview[], answer: boolean, ctx: ToolContext
  let svc: ExcelService
  const tool = (name: string) => excelTools(svc).find((t) => t.name === name)!
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'excel-'))
    fake = new FakeExcel(); fake.isRunning = false
    cfg = { enabled: true, confirm: 'ask', backup: true }
    svc = new ExcelService(fake, () => cfg)
    asked = []; answer = true
    ctx = { cwd: dir, agentId: 'main', gate: { check: async (_a: string, kind: string, detail: string) => { expect(kind).toBe('excel'); asked.push(JSON.parse(detail)); return answer } } } as any
  })

  it('creates, reads back and formats an .xlsx file when Excel is not running', async () => {
    const out = await tool('excel_write').run({ workbook: 'new.xlsx', sheet: 'Sales', start: 'A1', create: true, values: [['Store', 'Units', 'Double'], ['00123', 4, '=B2*2'], ['S2', '7', null]] }, ctx)
    expect(out).toMatch(/Wrote 9 cells \(1 formula\) to Sales!A1:C3 in new\.xlsx \(file\)/)
    expect(asked[0]).toMatchObject({ action: 'write', mode: 'file', range: 'Sales!A1:C3', overwrites: 0 })
    const r = await fileRead(path.join(dir, 'new.xlsx'), { formulas: true, maxCells: 100 })
    // an ID with a leading zero stays text; a plain numeric string becomes a number, as if typed
    expect(r.values).toEqual([['Store', 'Units', 'Double'], ['00123', 4, ''], ['S2', 7, '']])
    expect(r.formulas![1][2]).toBe('=B2*2')
    expect(r.note).toMatch(/not calculated yet/)
    const read = await tool('excel_read').run({ workbook: 'new.xlsx', range: 'Sales!A1:B2' }, ctx)
    expect(read).toContain('new.xlsx (file) · Sales!A1:B2 · 2 rows × 2 columns')
    expect(parseGrid(sections(read).parts[0].body)!.rows[1].cells).toEqual(['00123', '4'])
    expect(await tool('excel_format').run({ workbook: 'new.xlsx', range: 'A1:C1', fill: 'yellow', bold: true }, ctx)).toMatch(/Formatted Sales!A1:C1 in new\.xlsx \(file\): fill yellow, bold/)
    expect(await tool('excel_info').run({ workbook: 'new.xlsx' }, ctx)).toContain('Sales (used A1:C3)')
    // only_if: the tool picks the cells; whole_row widens each hit to a column span
    await tool('excel_write').run({ workbook: 'new.xlsx', start: 'E1', values: [[0.1], [0.3], [0.15]] }, ctx)
    asked = []
    expect(await tool('excel_format').run({ workbook: 'new.xlsx', range: 'E1:E3', fill: 'red', only_if: '<0.2', whole_row: 'A:E' }, ctx)).toContain('Formatted Sales!A1:E1, A3:E3 in new.xlsx (file): fill red, where 2 of 3 cells match <0.2')
    expect(asked[0].range).toBe('Sales!A1:E1, A3:E3')
    expect(await tool('excel_format').run({ workbook: 'new.xlsx', range: 'E1:E3', fill: 'red', only_if: '>5' }, ctx)).toMatch(/No cell .* matches >5; nothing was formatted/)
    // several areas are one call and one approval
    asked = []
    expect(await tool('excel_format').run({ workbook: 'new.xlsx', range: 'A2:C2,A3', fill: 'red' }, ctx)).toContain('Formatted Sales!A2:C2, A3 in new.xlsx (file)')
    expect(asked).toHaveLength(1)
  })

  it('shows what will be replaced, backs the file up once, and returns the old cells so the change can be undone', async () => {
    cfg.confirm = 'never'
    await tool('excel_write').run({ workbook: 'b.xlsx', create: true, values: [['old', 1]] }, ctx)
    cfg.confirm = 'ask'
    const out = await tool('excel_write').run({ workbook: 'b.xlsx', start: 'A1', values: [['new']] }, ctx)
    expect(asked).toHaveLength(1)
    expect(asked[0].overwrites).toBe(1)
    expect(parseGrid(asked[0].before!)!.rows[0].cells).toEqual(['old'])
    expect(out).toContain(`Backup of the file as it was: ${path.join(dir, 'b.backup.xlsx')}`)
    expect(sections(out).parts.find((p) => p.title === 'before')!.body).toContain('old')
    expect((await fileRead(path.join(dir, 'b.backup.xlsx'), { maxCells: 10 })).values[0][0]).toBe('old')
    expect(await tool('excel_write').run({ workbook: 'b.xlsx', start: 'A1', values: [['again']] }, ctx)).not.toContain('Backup')
  })

  it('writes nothing when the user declines', async () => {
    cfg.confirm = 'never'
    await tool('excel_write').run({ workbook: 'c.xlsx', create: true, values: [['keep']] }, ctx)
    cfg.confirm = 'ask'; answer = false
    await expect(tool('excel_write').run({ workbook: 'c.xlsx', values: [['gone']] }, ctx)).rejects.toThrow(/declined/)
    expect((await fileRead(path.join(dir, 'c.xlsx'), { maxCells: 10 })).values[0][0]).toBe('keep')
    expect(fs.existsSync(path.join(dir, 'c.backup.xlsx'))).toBe(false)
  })

  it('refuses a file edit that would drop charts, or that would fight a copy open in Excel', async () => {
    cfg.confirm = 'never'
    await tool('excel_write').run({ workbook: 'chart.xlsx', create: true, values: [[1]] }, ctx)
    fs.mkdirSync(path.join(dir, 'xl/charts'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'xl/charts/chart1.xml'), '<c/>')
    execFileSync('zip', ['-q', 'chart.xlsx', 'xl/charts/chart1.xml'], { cwd: dir })
    expect(riskyParts(path.join(dir, 'chart.xlsx'))).toEqual(['charts'])
    await expect(tool('excel_write').run({ workbook: 'chart.xlsx', values: [[2]] }, ctx)).rejects.toThrow(/contains charts.*edit it live/)
    await tool('excel_write').run({ workbook: 'open.xlsx', create: true, values: [[1]] }, ctx)
    fs.writeFileSync(path.join(dir, '~$open.xlsx'), '')
    await expect(tool('excel_write').run({ workbook: 'open.xlsx', values: [[2]] }, ctx)).rejects.toThrow(/is open in Excel/)
    await expect(tool('excel_write').run({ workbook: 'old.xls', create: true, values: [[2]] }, ctx)).rejects.toThrow()
  })

  it('edits a workbook open in Excel live, keeping IDs with leading zeros as text', async () => {
    fake.isRunning = true; fake.open = { 'Budget.xlsx': { Sales: { A1: 'old' } } }
    const out = await tool('excel_write').run({ workbook: 'budget.xlsx', sheet: 'Sales', start: 'A1', values: [['00123', '=B1*2']] }, ctx)
    expect(out).toMatch(/Wrote 2 cells \(1 formula\) to Sales!A1:B1 in Budget\.xlsx \(live\)/)
    expect(out).toContain('not saved')
    expect(asked[0]).toMatchObject({ mode: 'live', workbook: 'Budget.xlsx', overwrites: 1 })
    const w = fake.calls.find((c) => c.op === 'write') as Extract<LiveReq, { op: 'write' }>
    expect(w.values).toEqual([["'00123", '=B1*2']])
    expect(await tool('excel_read').run({ range: 'Sales!A1' }, ctx)).toContain('Budget.xlsx (live)')
    expect(await tool('excel_info').run({}, ctx)).toContain('Budget.xlsx (live, active)')
  })

  it('runs calls issued together one after another, so a read sees the write before it', async () => {
    fake.isRunning = true; fake.open = { 'Budget.xlsx': { Sales: {} } }
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    ctx = { ...ctx, gate: { check: async () => { await held; return true } } } as any
    const w = tool('excel_write').run({ workbook: 'Budget.xlsx', sheet: 'Sales', start: 'A1', values: [[0.1]] }, ctx)
    const f = tool('excel_format').run({ workbook: 'Budget.xlsx', sheet: 'Sales', range: 'A1', fill: 'red', only_if: '<0.2' }, ctx)
    const r = tool('excel_read').run({ workbook: 'Budget.xlsx', range: 'Sales!A1' }, ctx)
    await new Promise((x) => setTimeout(x, 30))
    expect(fake.calls.filter((c) => c.op === 'write')).toHaveLength(0)
    release()
    await w
    expect(await f).toContain('where 1 of 1 cells match <0.2')
    expect(await r).toContain('1\t0.1')
  })

  it('falls back to the file when the workbook is not open in Excel, and says which are open otherwise', async () => {
    cfg.confirm = 'never'
    await tool('excel_write').run({ workbook: 'disk.xlsx', create: true, values: [['on disk']] }, ctx)
    fake.isRunning = true; fake.open = { 'Budget.xlsx': { Sales: {} } }
    expect(await tool('excel_read').run({ workbook: 'disk.xlsx' }, ctx)).toContain('disk.xlsx (file)')
    await expect(tool('excel_read').run({ workbook: 'missing.xlsx' }, ctx)).rejects.toThrow(/not open in Excel and no such file.*Open workbooks: Budget\.xlsx/)
    await expect(tool('excel_read').run({ workbook: 'Budget.xlsx', sheet: 'Nope' }, ctx)).rejects.toThrow(/no sheet named "Nope".*Sheets: Sales/)
    expect(await tool('excel_write').run({ workbook: 'Budget.xlsx', sheet: 'Summary', create: true, values: [[1]] }, ctx)).toContain('Summary!A1 in Budget.xlsx (live)')
  })

  it('reports the missing macOS permission instead of editing a file Excel has open', async () => {
    cfg.confirm = 'never'
    await tool('excel_write').run({ workbook: 'p.xlsx', create: true, values: [[1]] }, ctx)
    fake.isRunning = true; fake.fail = liveError({ num: -1743, error: 'Not authorized' })
    // closed file: still readable on disk
    expect(await tool('excel_read').run({ workbook: 'p.xlsx' }, ctx)).toContain('p.xlsx (file)')
    fs.writeFileSync(path.join(dir, '~$p.xlsx'), '')
    await expect(tool('excel_read').run({ workbook: 'p.xlsx' }, ctx)).rejects.toThrow(/Privacy & Security → Automation/)
    expect((await svc.status(true)).permission).toBe('needed')
  })

  it('only talks to Excel for status when asked to, and does nothing when turned off', async () => {
    fake.isRunning = true; fake.open = { 'B.xlsx': { Sales: {} } }
    expect(await svc.status(false)).toMatchObject({ running: true, permission: 'unknown', workbooks: [] })
    expect(fake.calls).toHaveLength(0)
    expect((await svc.status(true)).workbooks[0].name).toBe('B.xlsx')
    expect((await svc.attach('B.xlsx')).meta).toMatchObject({ name: 'B.xlsx', excel: 'live', info: 'Sales!A1' })
    expect((await svc.attach('gone.xlsx')).error).toMatch(/no longer open/)
    cfg.enabled = false
    await expect(tool('excel_read').run({}, ctx)).rejects.toThrow(/turned off/)
    const meta: AttachMeta = { name: 'a.xlsx', kind: 'doc', info: '' }
    expect(svc.decorate({ meta }, '/x/a.xlsx').meta.excel).toBeUndefined()
    cfg.enabled = true
    expect(svc.decorate({ meta }, '/x/a.xlsx').meta.excel).toBe('file')
  })
})
