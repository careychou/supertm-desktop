import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Cell, WorkbookInfo } from '../../shared/excel'

/** A request to the running Excel app. `workbook` is a name or full path (`path`: the same, resolved); omitted = the active workbook. */
export type LiveReq = LiveOp & { path?: string }
type LiveOp =
  | { op: 'status' }
  | { op: 'read'; workbook?: string; sheet?: string; range?: string; formulas?: boolean; maxCells: number }
  | { op: 'write'; workbook?: string; sheet?: string; range: string; values: Cell[][]; create?: boolean; echoCells?: number }
  | { op: 'format'; workbook?: string; sheet?: string; range: string; fill?: number[] | null; fontColor?: number[]; bold?: boolean; italic?: boolean; numberFormat?: string; autofit?: boolean }

export interface LiveStatus { workbooks: WorkbookInfo[]; active?: string }
export interface ReadResult { workbook: string; path: string; sheet: string; range: string; total: string; values: Cell[][]; formulas?: string[][]; truncated: boolean; note?: string }
/** `values`: what the first cells hold after the write (formulas already calculated). */
export interface WriteResult { workbook: string; path: string; sheet: string; range: string; created: boolean; values: Cell[][] }
export interface FormatResult { workbook: string; path: string; sheet: string; range: string }

export type LiveCode = 'not_running' | 'permission' | 'not_open' | 'no_sheet' | 'busy' | 'failed'
export class LiveError extends Error {
  constructor(public code: LiveCode, message: string, public names: string[] = []) { super(message) }
}

/** The part of Excel the tools talk to; a fake stands in for it in tests. */
export interface LiveBackend {
  installed(): boolean
  running(): boolean
  call<T>(req: LiveReq): Promise<T>
}

/**
 * JavaScript for Automation, run by `osascript`. One call per tool call: it finds the workbook, does the work and
 * prints JSON. Everything goes through Excel's own object model, so Excel recalculates and the user sees the change.
 */
const SCRIPT = String.raw`
ObjC.import('Foundation');
var A1 = { rowAbsolute: false, columnAbsolute: false };
function fail(code, msg, names) { var e = new Error(msg); e.xl = code; e.names = names || []; throw e; }
function colIndex(s) { var n = 0; for (var i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64); return n; }
function colName(n) { var s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; }
function rect(a) {
  var p = a.replace(/\$/g, '').toUpperCase().split(':'), m1 = /^([A-Z]+)(\d+)$/.exec(p[0]), m2 = /^([A-Z]+)(\d+)$/.exec(p[1] || p[0]);
  if (!m1 || !m2) fail('failed', 'Excel returned a range this tool cannot read: ' + a);
  return { c1: colIndex(m1[1]), r1: +m1[2], c2: colIndex(m2[1]), r2: +m2[2] };
}
function addr(q) { var a = colName(q.c1) + q.r1, b = colName(q.c2) + q.r2; return a === b ? a : a + ':' + b; }
function pad(n) { return (n < 10 ? '0' : '') + n; }
function plain(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    var d = v.getFullYear() + '-' + pad(v.getMonth() + 1) + '-' + pad(v.getDate());
    return v.getHours() || v.getMinutes() || v.getSeconds() ? d + ' ' + pad(v.getHours()) + ':' + pad(v.getMinutes()) + ':' + pad(v.getSeconds()) : d;
  }
  return v;
}
function grid(v, q) {
  var rows = q.r2 - q.r1 + 1, cols = q.c2 - q.c1 + 1;
  if (!Array.isArray(v)) v = [[v]];
  else if (!Array.isArray(v[0])) v = rows === 1 ? [v] : v.map(function (x) { return [x]; });
  var out = [];
  for (var r = 0; r < rows; r++) { var row = []; for (var c = 0; c < cols; c++) row.push(plain((v[r] || [])[c])); out.push(row); }
  return out;
}
function usedOf(ws) {
  var u = ws.usedRange, a = u.getAddress(A1);
  if (a.indexOf(':') < 0) { var v = u.value(); if (v === '' || v === null || v === undefined) return ''; }
  return a;
}
function findBook(xl, want, alt) {
  var books = xl.workbooks(), names = books.map(function (b) { return b.name(); });
  if (!want) {
    if (!books.length) fail('not_open', 'No workbook is open in Excel.', names);
    try { want = xl.activeWorkbook.name(); } catch (e) { want = names[0]; }
  }
  var w = String(want).toLowerCase();
  for (var i = 0; i < books.length; i++) if (names[i].toLowerCase() === w) return books[i];
  var p = String(alt || '').toLowerCase();
  for (var k = 0; k < books.length; k++) { var full = ''; try { full = books[k].fullName().toLowerCase(); } catch (e) {} if (full && (full === w || full === p)) return books[k]; }
  fail('not_open', 'No open workbook is named "' + want + '".', names);
}
function isActive(xl, wb) { try { return xl.activeWorkbook.name() === wb.name(); } catch (e) { return false; } }
function findSheet(xl, wb, want, create) {
  var names = wb.worksheets.name();
  if (!want) { var a = ''; if (isActive(xl, wb)) { try { a = xl.activeSheet.name(); } catch (e) {} } want = names.indexOf(a) >= 0 ? a : names[0]; }
  for (var i = 0; i < names.length; i++) if (names[i].toLowerCase() === String(want).toLowerCase()) return { ws: wb.worksheets[names[i]], name: names[i], created: false };
  if (!create) fail('no_sheet', 'Workbook "' + wb.name() + '" has no sheet named "' + want + '".', names);
  // a new sheet becomes the visible one; put the user back where they were
  var before = null; if (isActive(xl, wb)) { try { before = xl.activeSheet.name(); } catch (e) {} }
  xl.make({ new: 'worksheet', at: wb, withProperties: { name: String(want) } });
  if (before && isActive(xl, wb)) { try { wb.worksheets[before].activateObject(); } catch (e) {} }
  return { ws: wb.worksheets[String(want)], name: String(want), created: true };
}
function pathOf(wb) { try { var f = wb.fullName(); return f === wb.name() ? '' : f; } catch (e) { return ''; } }
function bookInfo(xl, wb) {
  var names = wb.worksheets.name(), info = { name: wb.name(), path: pathOf(wb), mode: 'live', sheets: [] };
  for (var i = 0; i < names.length; i++) { var u = ''; try { u = usedOf(wb.worksheets[names[i]]); } catch (e) {} info.sheets.push({ name: names[i], used: u }); }
  if (isActive(xl, wb)) {
    try { info.activeSheet = xl.activeSheet.name(); } catch (e) {}
    try { info.selection = xl.selection.getAddress(A1); } catch (e) {}
  }
  return info;
}
var ops = {
  status: function (xl) {
    var out = { workbooks: xl.workbooks().map(function (b) { return bookInfo(xl, b); }) };
    try { out.active = xl.activeWorkbook.name(); } catch (e) {}
    return out;
  },
  read: function (xl, q) {
    var wb = findBook(xl, q.workbook, q.path), s = findSheet(xl, wb, q.sheet, false);
    var total = q.range || usedOf(s.ws);
    var base = { workbook: wb.name(), path: pathOf(wb), sheet: s.name };
    if (!total) return Object.assign(base, { range: 'A1', total: '', values: [], truncated: false });
    var t = rect(total), cols = t.c2 - t.c1 + 1, rows = t.r2 - t.r1 + 1, keep = Math.max(1, Math.floor(q.maxCells / cols));
    var part = { r1: t.r1, c1: t.c1, r2: Math.min(t.r2, t.r1 + keep - 1), c2: t.c2 }, rng = s.ws.ranges[addr(part)];
    var values = grid(rng.value(), part), blanks = false, formulas = null;
    for (var r = 0; r < values.length && !blanks; r++) for (var c = 0; c < cols; c++) if (values[r][c] === null || values[r][c] === '') { blanks = true; break; }
    if (q.formulas || blanks) formulas = grid(rng.formula(), part);
    // an error cell (#DIV/0!, #N/A) comes back empty over Apple events; show what Excel shows instead
    var shown = null;
    if (blanks) for (var r2 = 0; r2 < values.length; r2++) for (var c2 = 0; c2 < cols; c2++) {
      var v = values[r2][c2], f = formulas[r2][c2];
      if (v !== null && v !== '') continue;
      values[r2][c2] = '';
      if (typeof f !== 'string' || f.charAt(0) !== '=') continue;
      if (!shown) shown = grid(rng.stringValue(), part);
      var t2 = shown[r2][c2];
      if (t2) values[r2][c2] = /^#+$/.test(t2) ? '#ERROR' : String(t2);
    }
    var out = Object.assign(base, { range: addr(part), total: addr(t), values: values, truncated: rows > keep });
    if (q.formulas) out.formulas = formulas.map(function (row) { return row.map(function (x) { return x === null ? '' : String(x); }); });
    return out;
  },
  write: function (xl, q) {
    var wb = findBook(xl, q.workbook, q.path), s = findSheet(xl, wb, q.sheet, !!q.create), rng = s.ws.ranges[q.range];
    rng.value = q.values.map(function (row) { return row.map(function (v) { return v === null ? '' : v; }); });
    var back = ops.read(xl, { workbook: wb.name(), sheet: s.name, range: q.range, maxCells: q.echoCells || 400 });
    return { workbook: wb.name(), path: pathOf(wb), sheet: s.name, range: q.range, created: s.created, values: back.values };
  },
  format: function (xl, q) {
    var wb = findBook(xl, q.workbook, q.path), s = findSheet(xl, wb, q.sheet, false), rng = s.ws.ranges[q.range];
    if (q.fill === null) rng.interiorObject.colorIndex = 'color index none';
    else if (q.fill) rng.interiorObject.color = q.fill;
    if (q.fontColor) rng.fontObject.color = q.fontColor;
    if (typeof q.bold === 'boolean') rng.fontObject.bold = q.bold;
    if (typeof q.italic === 'boolean') rng.fontObject.italic = q.italic;
    if (q.numberFormat) rng.numberFormat = q.numberFormat;
    if (q.autofit) { var t = rect(q.range); s.ws.columns[colName(t.c1) + ':' + colName(t.c2)].autofit(); }
    return { workbook: wb.name(), path: pathOf(wb), sheet: s.name, range: q.range };
  }
};
function run(argv) {
  try {
    var q = JSON.parse($.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null).js);
    var xl = Application('Microsoft Excel');
    if (!xl.running()) fail('not_running', 'Excel is not running.');
    return JSON.stringify({ ok: true, data: ops[q.op](xl, q) });
  } catch (e) {
    return JSON.stringify({ ok: false, code: e.xl || '', num: e.errorNumber || 0, error: String(e.message || e), names: e.names || [] });
  }
}
`

const APP_PATHS = ['/Applications/Microsoft Excel.app', path.join(os.homedir(), 'Applications/Microsoft Excel.app')]
const TIMEOUT_MS = 60_000

/** Turns a failed call into an error the model and the user can act on. */
export function liveError(r: { code?: string; num?: number; error?: string; names?: string[] }): LiveError {
  const msg = r.error ?? 'Excel did not answer'
  if (r.code) return new LiveError(r.code as LiveCode, msg, r.names ?? [])
  if (r.num === -1743 || /not authori[sz]ed|not allowed to send/i.test(msg)) return new LiveError('permission', 'macOS has not allowed this app to control Excel. Allow it in System Settings → Privacy & Security → Automation, then try again.')
  if (r.num === -600 || r.num === -609 || /isn.t running|connection is invalid/i.test(msg)) return new LiveError('not_running', 'Excel is not running.')
  if (r.num === -1712 || /timed out/i.test(msg)) return new LiveError('busy', 'Excel did not respond. Finish editing the cell or close any open dialog in Excel, then try again.')
  return new LiveError('failed', `Excel refused the request: ${msg}`)
}

export class OsaBackend implements LiveBackend {
  installed(): boolean { return process.platform === 'darwin' && APP_PATHS.some((p) => fs.existsSync(p)) }

  running(): boolean {
    if (process.platform !== 'darwin') return false
    try { execFileSync('pgrep', ['-x', 'Microsoft Excel'], { stdio: 'ignore' }); return true } catch { return false }
  }

  call<T>(req: LiveReq): Promise<T> {
    if (!this.running()) return Promise.reject(new LiveError('not_running', 'Excel is not running.'))
    // the request travels in a file: a large block of values does not fit on a command line
    const file = path.join(os.tmpdir(), `excel-req-${randomUUID()}.json`)
    fs.writeFileSync(file, JSON.stringify(req))
    return new Promise<T>((resolve, reject) => {
      execFile('osascript', ['-l', 'JavaScript', '-e', SCRIPT, file], { timeout: TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
        fs.rmSync(file, { force: true })
        if (err) {
          const killed = (err as any).killed || (err as any).signal === 'SIGTERM'
          return reject(killed ? liveError({ num: -1712 }) : liveError({ error: String(stderr || err.message).trim(), num: Number(/\((-\d+)\)/.exec(String(stderr))?.[1] ?? 0) }))
        }
        let r: any
        try { r = JSON.parse(stdout) } catch { return reject(new LiveError('failed', `Excel returned an unreadable answer: ${stdout.slice(0, 200)}`)) }
        if (r.ok) resolve(r.data as T); else reject(liveError(r))
      })
    })
  }
}
