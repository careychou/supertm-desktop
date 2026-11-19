import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { OfficeApp } from '../../shared/office'

/** A request to the running Word or PowerPoint. `doc` is a name or full path (`path`: the same, resolved); omitted = the active one. */
export type OfficeReq = { app: OfficeApp; op: string; doc?: string; path?: string; [k: string]: unknown }

/** 'stale': the text changed since it was read, so the edit was not made. */
export type OfficeCode = 'not_running' | 'permission' | 'not_open' | 'busy' | 'stale' | 'failed'
export class OfficeError extends Error {
  constructor(public code: OfficeCode, message: string, public names: string[] = []) { super(message) }
}

/** The part of Word and PowerPoint the tools talk to; a fake stands in for it in tests. */
export interface OfficeBackend {
  installed(app: OfficeApp): boolean
  running(app: OfficeApp): boolean
  call<T>(req: OfficeReq): Promise<T>
  /** Opens a file in its app (starting the app if needed) without bringing it to the front. */
  open(app: OfficeApp, file: string): Promise<void>
}

/**
 * JavaScript for Automation, run by `osascript`. One call per tool call; everything goes through the app's own
 * object model, so the user sees the change and can undo it. A few commands that the apps only accept from
 * AppleScript (new slide, new shape, new comment, new table row) are sent as AppleScript from inside this script.
 * Never pass `text object` in the properties of a new Word table: Word quits. The table is placed with `at`.
 */
const SCRIPT = String.raw`
ObjC.import('Foundation');
var me = Application.currentApplication(); me.includeStandardAdditions = true;
function fail(code, msg, names) { var e = new Error(msg); e.off = code; e.names = names || []; throw e; }
function asq(s) { return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r\n|\r|\n/g, '" & return & "') + '"'; }
function AS(appName, body) { return me.runScript('tell application "' + appName + '"\n' + body + '\nend tell', { in: 'AppleScript' }); }
function cr(s) { return String(s === null || s === undefined ? '' : s).replace(/\r\n|\n/g, '\r'); }
function pick(coll, active, want, alt, full, what) {
  var ns = [], i;
  for (i = 0; i < coll.length; i++) ns.push(coll[i].name());
  if (!want) {
    if (!ns.length) fail('not_open', 'No ' + what + ' is open.', ns);
    var a = ''; try { a = active().name(); } catch (e) {}
    return coll[ns.indexOf(a) >= 0 ? ns.indexOf(a) : 0];
  }
  var w = String(want).toLowerCase();
  for (i = 0; i < ns.length; i++) if (ns[i].toLowerCase() === w) return coll[i];
  var p = String(alt || '').toLowerCase();
  for (i = 0; i < ns.length; i++) { var f = ''; try { f = String(full(coll[i])).toLowerCase(); } catch (e) {} if (f && (f === w || f === p)) return coll[i]; }
  fail('not_open', 'No open ' + what + ' is named "' + want + '".', ns);
}
function isPath(s) { return typeof s === 'string' && s.indexOf('/') >= 0 ? s : ''; }

// ---------- Word ----------
var WORD = 'Microsoft Word';
function wdoc(app, q) { return pick(app.documents, function () { return app.activeDocument; }, q.doc, q.path, function (d) { return d.posixFullName(); }, 'document'); }
/**
 * The paragraphs in a window, each with the character range Word reports for it. Positions are never worked out
 * from the text: a tracked deletion stays in the document, and a table cell carries marks that do not count.
 * end is where the paragraph's own text stops (before its paragraph mark or end-of-cell mark).
 */
function wparas(d, from, to) {
  var total = d.paragraphs.length, out = [];
  for (var n = Math.max(1, from); n <= Math.min(total, to); n++) {
    var r = d.paragraphs[n - 1].textObject, raw = String(r.content() || ''), cell = raw.charAt(raw.length - 1) === '\u0007';
    var text = raw.replace(/[\r\u0007]+$/, ''), start = r.startOfContent(), stop = r.endOfContent();
    out.push({ n: n, text: text, start: start, end: Math.max(start, stop - (raw.length > text.length ? 1 : 0)), stop: stop, cell: cell });
  }
  return { total: total, list: out };
}
function wone(d, n) {
  var total = d.paragraphs.length;
  if (!(n >= 1 && n <= total)) fail('stale', 'The document has ' + total + ' paragraph' + (total === 1 ? '' : 's') + '; there is no paragraph ' + n + '.');
  var p = wparas(d, n, n).list[0]; p.total = total; return p;
}
function wlevels(d, n) {
  var out = [], raw = [];
  try { raw = d.paragraphs.outlineLevel() || []; } catch (e) {}
  for (var i = 0; i < n; i++) { var m = /level\s*(\d+)/.exec(String(raw[i] || '')); out.push(m ? +m[1] : 0); }
  return out;
}
function wsame(p, before) { if (before !== undefined && before !== null && p.text !== before) fail('stale', 'Paragraph ' + p.n + ' changed since it was read. It now reads: ' + p.text.slice(0, 200)); }
function wtracked(d, on, fn) {
  var was = false; try { was = !!d.trackRevisions(); } catch (e) {}
  if (on && !was) d.trackRevisions = true;
  try { return fn(); } finally { if (on && !was) { try { d.trackRevisions = false; } catch (e) {} } }
}
function wstyle(d, n, name) {
  var st = d.wordStyles[name];
  try { st.nameLocal(); } catch (e) { fail('failed', 'This document has no style named "' + name + '".'); }
  d.paragraphs[n - 1].style = st;
}
function wspan(d, q) {
  var a = wone(d, q.n), b = q.n2 && q.n2 !== q.n ? wone(d, q.n2) : a;
  wsame(a, q.before);
  if (!q.phrase) return { start: a.start, end: b.end };
  var i = a.text.indexOf(q.phrase);
  if (i < 0) fail('stale', 'Paragraph ' + a.n + ' does not contain "' + q.phrase + '".');
  var s = a.start + i, e = s + q.phrase.length, got = '';
  try { got = String(d.createRange({ start: s, end: e }).content()); } catch (x) {}
  if (got !== q.phrase) fail('failed', 'Could not pin down "' + q.phrase + '" in paragraph ' + a.n + ' (it holds tracked changes or special marks). Apply this to the whole paragraph instead.');
  return { start: s, end: e };
}
function wcounts(d) {
  var o = { tables: 0, comments: 0, revisions: 0, tracking: false };
  try { o.tables = d.tables.length; } catch (e) {}
  try { o.comments = d.wordComments.length; } catch (e) {}
  try { o.revisions = d.revisions.length; } catch (e) {}
  try { o.tracking = !!d.trackRevisions(); } catch (e) {}
  return o;
}
function wcell(app, t, r, c) { return app.getCellFromTable(t, { row: r, column: c }).textObject; }
function wtable(d, i) { var n = 0; try { n = d.tables.length; } catch (e) {} if (!(i >= 1 && i <= n)) fail('stale', 'The document has ' + n + ' table' + (n === 1 ? '' : 's') + '; there is no table ' + i + '.'); return d.tables[i - 1]; }
function wgrid(app, t, max) {
  var R = t.numberOfRows(), C = t.numberOfColumns(), rows = [];
  for (var r = 1; r <= R && rows.length * C < max; r++) {
    var row = [];
    for (var c = 1; c <= C; c++) { var v = ''; try { v = String(wcell(app, t, r, c).content()).replace(/[\r\u0007]+$/, ''); } catch (e) {} row.push(v); }
    rows.push(row);
  }
  return rows;
}
var word = {
  status: function (app) {
    var docs = [], active = '';
    try { active = app.activeDocument.name(); } catch (e) {}
    for (var i = 0; i < app.documents.length; i++) {
      var d = app.documents[i], c = wcounts(d), info = { name: d.name(), path: '', saved: true, size: 0, tables: c.tables, comments: c.comments, tracking: c.tracking };
      try { info.path = isPath(d.posixFullName()); } catch (e) {}
      try { info.saved = !!d.saved(); } catch (e) {}
      try { info.size = d.paragraphs.length; } catch (e) {}
      if (info.name === active) {
        try {
          var s = app.selection.selectionStart(), e2 = app.selection.selectionEnd();
          if (e2 > s) info.selection = String(app.selection.content()).slice(0, 300);
          // binary search over paragraph starts: a few calls even in a long document
          var find = function (pos) { var lo = 1, hi = info.size; while (lo < hi) { var mid = Math.ceil((lo + hi) / 2); if (d.paragraphs[mid - 1].textObject.startOfContent() <= pos) lo = mid; else hi = mid - 1; } return lo; };
          var a = find(s), b = e2 > s ? find(e2 - 1) : a;
          info.at = a === b ? 'paragraph ' + a : 'paragraphs ' + a + '-' + b;
        } catch (e) {}
      }
      docs.push(info);
    }
    return { docs: docs, active: active };
  },
  read: function (app, q) {
    var d = wdoc(app, q), c = wcounts(d), base = { document: d.name(), path: '', tables: c.tables, comments: c.comments, revisions: c.revisions, tracking: c.tracking };
    try { base.path = isPath(d.posixFullName()); } catch (e) {}
    if (q.table) { var t = wtable(d, q.table); base.total = 0; base.paragraphs = []; base.grid = { table: q.table, rows: wgrid(app, t, q.maxCells || 2000) }; return base; }
    var total = d.paragraphs.length, lv = wlevels(d, total), from = Math.max(1, q.from || 1), to = Math.min(total, q.to || total), out = [], used = 0;
    for (var i = from; i <= to; i++) {
      var raw = String(d.paragraphs[i - 1].textObject.content() || ''), cell = raw.charAt(raw.length - 1) === '\u0007', text = raw.replace(/[\r\u0007]+$/, '');
      if (cell && !text) continue;
      used += text.length + 12;
      if ((used > q.maxChars || out.length >= q.maxParas) && out.length) { base.next = i; break; }
      out.push({ n: i, text: text, level: cell ? 0 : lv[i - 1], cell: cell });
    }
    base.total = total; base.paragraphs = out;
    return base;
  },
  edit: function (app, q) {
    var d = wdoc(app, q), total = d.paragraphs.length, text = cr(q.text);
    return wtracked(d, q.track, function () {
      if (q.action === 'insert') {
        var n = q.n || 0, count = text.split('\r').length;
        if (n === 0) {
          if (total && wone(d, 1).cell) fail('failed', 'The document starts with a table; insert after a paragraph instead.');
          d.createRange({ start: 0, end: 0 }).content = text + '\r';
        } else {
          var a = wone(d, n); wsame(a, q.before);
          if (a.cell) fail('failed', 'Paragraph ' + n + ' is inside a table. Use word_table to change a table.');
          // typed at the end of the paragraph, in front of its paragraph mark: the new text can never land inside a table that follows
          d.createRange({ start: a.end, end: a.end }).content = '\r' + text;
        }
        for (var k = n + 1; k <= n + count; k++) {
          try { if (q.style) wstyle(d, k, q.style); else if (!/body/.test(String(d.paragraphs[k - 1].outlineLevel()))) wstyle(d, k, 'Normal'); } catch (e) { if (q.style) throw e; }
        }
        return { document: d.name(), first: n + 1, count: count, total: d.paragraphs.length };
      }
      var p = wone(d, q.n); wsame(p, q.before);
      if (q.action === 'delete') {
        if (p.cell) fail('failed', 'Paragraph ' + q.n + ' is inside a table. Use word_table to change a table.');
        if (q.n < total && wone(d, q.n + 1).cell) d.createRange({ start: p.start, end: p.end }).content = '';   // keep the paragraph mark in front of a table
        else if (q.n === total && total > 1) d.createRange({ start: wone(d, q.n - 1).end, end: p.end }).content = '';
        else d.createRange({ start: p.start, end: total === 1 ? p.end : p.stop }).content = '';
        return { document: d.name(), first: q.n, count: 0, total: d.paragraphs.length };
      }
      if (p.cell && text.indexOf('\r') >= 0) fail('failed', 'Paragraph ' + q.n + ' is a table cell; use word_table to change a table.');
      d.createRange({ start: p.start, end: p.end }).content = text;
      if (q.style) wstyle(d, q.n, q.style);
      return { document: d.name(), first: q.n, count: text.split('\r').length, total: d.paragraphs.length };
    });
  },
  format: function (app, q) {
    var d = wdoc(app, q), s = wspan(d, q);
    return wtracked(d, q.track, function () {
      var r = d.createRange({ start: s.start, end: s.end });
      if (typeof q.bold === 'boolean') r.bold = q.bold;
      if (typeof q.italic === 'boolean') r.italic = q.italic;
      if (typeof q.underline === 'boolean') r.underline = q.underline ? 'underline single' : 'underline none';
      if (q.highlight) r.highlightColorIndex = q.highlight === 'none' ? 'no highlight' : q.highlight;
      if (q.color) r.fontObject.colorIndex = q.color;
      if (q.size) r.fontObject.fontSize = q.size;
      if (q.style) for (var k = q.n; k <= (q.n2 || q.n); k++) wstyle(d, k, q.style);
      return { document: d.name() };
    });
  },
  comment: function (app, q) {
    var d = wdoc(app, q), s = wspan(d, q), name = d.name();
    if (s.end <= s.start) fail('failed', 'Paragraph ' + q.n + ' is empty; a comment needs some text to attach to.');
    var n = AS(WORD, 'set d to document ' + asq(name) + '\nset r to create range d start ' + s.start + ' end ' + s.end + '\nmake new Word comment at d with properties {comment text:' + asq(q.text) + ', scope:r}\nreturn count of Word comments of d');
    return { document: name, comments: n };
  },
  table: function (app, q) {
    var d = wdoc(app, q), name = d.name(), t, i, r, c;
    return wtracked(d, q.track, function () {
      if (q.action === 'create') {
        var a = wone(d, q.n); wsame(a, q.before);
        if (a.cell) fail('failed', 'Paragraph ' + q.n + ' is inside a table; choose a paragraph outside it.');
        var R = q.values.length, C = q.values[0].length;
        t = app.make({ new: 'table', at: d.paragraphs[q.n - 1].textObject, withProperties: { numberOfRows: R, numberOfColumns: C } });
        // a table placed after a heading would otherwise take the heading's style in every cell
        try { if (!/body/.test(String(d.paragraphs[q.n - 1].outlineLevel()))) { var tr = t.textObject; d.createRange({ start: tr.startOfContent(), end: tr.endOfContent() }).style = d.wordStyles['Normal']; } } catch (e) {}
        for (r = 0; r < R; r++) for (c = 0; c < C; c++) if (q.values[r][c] !== '') wcell(app, t, r + 1, c + 1).content = cr(q.values[r][c]);
        var st = t.textObject.startOfContent(), idx = 0;
        for (i = 0; i < d.tables.length; i++) if (d.tables[i].textObject.startOfContent() <= st) idx++;
        return { document: name, table: idx, rows: R, columns: C };
      }
      t = wtable(d, q.table);
      var R0 = t.numberOfRows(), C0 = t.numberOfColumns(), row = q.row || 1, col = q.column || 1;
      if (q.action === 'add_row') { AS(WORD, 'make new row at end of table ' + q.table + ' of document ' + asq(name)); row = R0 + 1; col = 1; R0++; }
      if (row + q.values.length - 1 > R0 || col + q.values[0].length - 1 > C0) fail('failed', 'Table ' + q.table + ' has ' + R0 + ' rows and ' + C0 + ' columns; that block does not fit. Add rows with action "add_row".');
      for (r = 0; r < q.values.length; r++) for (c = 0; c < q.values[r].length; c++) if (q.values[r][c] !== null) wcell(app, t, row + r, col + c).content = cr(q.values[r][c]);
      return { document: name, table: q.table, rows: R0, columns: C0 };
    });
  }
};

// ---------- PowerPoint ----------
var PPT = 'Microsoft PowerPoint';
function pdoc(app, q) { return pick(app.presentations, function () { return app.activePresentation; }, q.doc, q.path, function (d) { return d.fullName(); }, 'presentation'); }
function pslide(d, n) { var t = d.slides.length; if (!(n >= 1 && n <= t)) fail('stale', 'The presentation has ' + t + ' slide' + (t === 1 ? '' : 's') + '; there is no slide ' + n + '.'); return d.slides[n - 1]; }
function ptext(sh) { try { return String(sh.textFrame.textRange.content() || ''); } catch (e) { return ''; } }
function pkind(t, table) { return table ? 'table' : String(t || '').replace(/^shape type /, '').replace('place holder', 'placeholder'); }
function pmeta(s) {
  var o = { names: [], frames: [], tables: [], types: [] };
  if (!s.shapes.length) return o;
  try { o.names = s.shapes.name(); o.frames = s.shapes.hasTextFrame(); o.tables = s.shapes.hasTable(); o.types = s.shapes.shapeType(); } catch (e) {}
  return o;
}
function pshape(s, sn, i) {
  var n = s.shapes.length;
  if (!(i >= 1 && i <= n)) fail('stale', 'Slide ' + sn + ' has ' + n + ' shape' + (n === 1 ? '' : 's') + '; there is no shape ' + i + '.');
  return s.shapes[i - 1];
}
function pnotes(s) {
  var np = s.notesPage, n = np.shapes.length, names = n ? np.shapes.name() : [];
  for (var i = 0; i < n; i++) if (/notes/i.test(String(names[i]))) return np.shapes[i];
  return n > 1 ? np.shapes[1] : null;
}
function pgrid(sh, max) {
  var t = sh.tableObject, R = t.rows.length, C = t.columns.length, rows = [];
  for (var r = 0; r < R && rows.length * C < max; r++) {
    var row = [];
    for (var c = 0; c < C; c++) { var v = ''; try { v = String(t.rows[r].cells[c].shape.textFrame.textRange.content() || ''); } catch (e) {} row.push(v); }
    rows.push(row);
  }
  return { rows: rows, clipped: rows.length < R };
}
function psame(now, before, where) { if (before !== undefined && before !== null && now !== before) fail('stale', where + ' changed since it was read. It now reads: ' + now.slice(0, 200)); }
var powerpoint = {
  status: function (app) {
    var docs = [], active = '';
    try { active = app.activePresentation.name(); } catch (e) {}
    for (var i = 0; i < app.presentations.length; i++) {
      var d = app.presentations[i], info = { name: d.name(), path: '', saved: true, size: 0 };
      try { info.path = isPath(d.fullName()); } catch (e) {}
      try { info.saved = !!d.saved(); } catch (e) {}
      try { info.size = d.slides.length; } catch (e) {}
      if (info.name === active) {
        try { var cur = app.activeWindow.view.slide.slideIndex(); if (cur) info.at = 'slide ' + cur; } catch (e) {}
        try { var st = String(app.activeWindow.selection.selectionType()); if (/text/.test(st)) info.selection = String(app.activeWindow.selection.textRange.content()).slice(0, 300); else if (/shapes/.test(st)) info.selection = 'a shape is selected'; } catch (e) {}
      }
      docs.push(info);
    }
    return { docs: docs, active: active };
  },
  read: function (app, q) {
    var d = pdoc(app, q), total = d.slides.length, out = { presentation: d.name(), path: '', total: total, slides: [] }, used = 0;
    try { out.path = isPath(d.fullName()); } catch (e) {}
    try { if (app.activePresentation.name() === d.name()) out.current = app.activeWindow.view.slide.slideIndex(); } catch (e) {}
    for (var n = Math.max(1, q.from || 1); n <= Math.min(total, q.to || total); n++) {
      var s = d.slides[n - 1], m = pmeta(s), info = { n: n, layout: String(s.layout()).replace(/^slide layout /, ''), shapes: [] };
      for (var i = 0; i < s.shapes.length; i++) {
        var h = { i: i + 1, name: String(m.names[i] || ''), kind: pkind(m.types[i], m.tables[i]) };
        if (m.tables[i]) { var g = pgrid(s.shapes[i], 400); h.table = g.rows; h.clipped = g.clipped; used += JSON.stringify(g.rows).length; }
        else if (m.frames[i]) { h.text = ptext(s.shapes[i]); used += h.text.length; }
        info.shapes.push(h);
      }
      if (q.notes) { var nb = pnotes(s); info.notes = nb ? ptext(nb) : ''; used += info.notes.length; }
      out.slides.push(info);
      if (used > q.maxChars && n < Math.min(total, q.to || total)) { out.next = n + 1; break; }
    }
    return out;
  },
  edit: function (app, q) {
    var d = pdoc(app, q), s = pslide(d, q.slide), text = cr(q.text), sh;
    if (q.target === 'notes') {
      sh = pnotes(s); if (!sh) fail('failed', 'Slide ' + q.slide + ' has no notes placeholder.');
      psame(ptext(sh), q.before, 'The notes of slide ' + q.slide);
      sh.textFrame.textRange.content = text;
      return { presentation: d.name(), slide: q.slide, now: ptext(sh) };
    }
    sh = pshape(s, q.slide, q.shape);
    if (q.row) {
      if (!sh.hasTable()) fail('failed', 'Shape ' + q.shape + ' on slide ' + q.slide + ' is not a table.');
      var t = sh.tableObject, R = t.rows.length, C = t.columns.length;
      if (q.row + q.values.length - 1 > R || q.column + q.values[0].length - 1 > C) fail('failed', 'That table has ' + R + ' rows and ' + C + ' columns; the block does not fit.');
      for (var r = 0; r < q.values.length; r++) for (var c = 0; c < q.values[r].length; c++) if (q.values[r][c] !== null) t.rows[q.row - 1 + r].cells[q.column - 1 + c].shape.textFrame.textRange.content = cr(q.values[r][c]);
      return { presentation: d.name(), slide: q.slide, now: '' };
    }
    if (!sh.hasTextFrame()) fail('failed', 'Shape ' + q.shape + ' on slide ' + q.slide + ' (' + sh.name() + ') holds no text.');
    var tr = sh.textFrame.textRange, now = ptext(sh);
    if (q.paragraph) {
      var ps = now.split('\r');
      if (q.paragraph > ps.length) fail('stale', 'Shape ' + q.shape + ' has ' + ps.length + ' paragraph' + (ps.length === 1 ? '' : 's') + '; there is no paragraph ' + q.paragraph + '.');
      psame(ps[q.paragraph - 1], q.before, 'Paragraph ' + q.paragraph + ' of shape ' + q.shape + ' on slide ' + q.slide);
      // only this paragraph is touched, so the others keep their formatting; PowerPoint keeps the paragraph break itself
      tr.paragraphs[q.paragraph - 1].content = text;
    } else { psame(now, q.before, 'Shape ' + q.shape + ' on slide ' + q.slide); tr.content = text; }
    return { presentation: d.name(), slide: q.slide, now: ptext(sh) };
  },
  format: function (app, q) {
    var d = pdoc(app, q), s = pslide(d, q.slide), sh = pshape(s, q.slide, q.shape);
    if (!sh.hasTextFrame()) fail('failed', 'Shape ' + q.shape + ' on slide ' + q.slide + ' holds no text.');
    var tr = sh.textFrame.textRange;
    if (q.paragraph) { if (q.paragraph > tr.paragraphs.length) fail('stale', 'Shape ' + q.shape + ' has no paragraph ' + q.paragraph + '.'); tr = tr.paragraphs[q.paragraph - 1]; }
    var f = tr.font;
    if (typeof q.bold === 'boolean') f.bold = q.bold;
    if (typeof q.italic === 'boolean') f.italic = q.italic;
    if (typeof q.underline === 'boolean') f.underline = q.underline;
    if (q.size) f.fontSize = q.size;
    if (q.color) f.fontColor = q.color;
    return { presentation: d.name(), slide: q.slide };
  },
  slide: function (app, q) {
    var d = pdoc(app, q), name = d.name(), total = d.slides.length, ref = 'presentation ' + asq(name);
    if (q.action === 'delete') { pslide(d, q.slide); psame(d.slides[q.slide - 1].shapes.length ? ptext(d.slides[q.slide - 1].shapes[0]) : '', q.before, 'Slide ' + q.slide); app.delete(d.slides[q.slide - 1]); return { presentation: name, slide: q.slide, total: d.slides.length }; }
    var after = q.after === undefined || q.after === null ? total : q.after;
    if (after < 0 || after > total) fail('stale', 'The presentation has ' + total + ' slides; cannot add after slide ' + after + '.');
    var at = total === 0 || after === total ? 'end of ' + ref : after === 0 ? 'before slide 1 of ' + ref : 'after slide ' + after + ' of ' + ref;
    AS(PPT, 'make new slide at ' + at + ' with properties {layout:slide layout ' + q.layout + '}');
    var n = after + 1, s = d.slides[n - 1], m = pmeta(s), body = 0;
    for (var i = 0; i < s.shapes.length; i++) {
      if (!m.frames[i]) continue;
      if (/title/i.test(String(m.names[i])) && !/subtitle/i.test(String(m.names[i]))) { if (q.title) s.shapes[i].textFrame.textRange.content = cr(q.title); }
      else if (!body) { body = i + 1; if (q.body) s.shapes[i].textFrame.textRange.content = cr(q.body); }
    }
    if (q.notes) { var nb = pnotes(s); if (nb) nb.textFrame.textRange.content = cr(q.notes); }
    return { presentation: name, slide: n, total: d.slides.length, noBody: !!q.body && !body };
  },
  shape: function (app, q) {
    var d = pdoc(app, q), name = d.name(), s = pslide(d, q.slide), where = 'slide ' + q.slide + ' of presentation ' + asq(name);
    var box = '{left position:' + q.left + ', top:' + q.top + ', width:' + q.width + ', height:' + q.height + '}';
    if (q.kind === 'table') {
      AS(PPT, 'set t to make new shape table at end of ' + where + ' with properties {number of rows:' + q.values.length + ', number of columns:' + q.values[0].length + '}\nset left position of t to ' + q.left + '\nset top of t to ' + q.top + '\nset width of t to ' + q.width);
      var n = s.shapes.length, t = s.shapes[n - 1].tableObject;
      for (var r = 0; r < q.values.length; r++) for (var c = 0; c < q.values[r].length; c++) if (q.values[r][c] !== '' && q.values[r][c] !== null) t.rows[r].cells[c].shape.textFrame.textRange.content = cr(q.values[r][c]);
      return { presentation: name, slide: q.slide, shape: n };
    }
    AS(PPT, 'set b to make new text box at end of ' + where + ' with properties ' + box + '\nset content of text range of text frame of b to ' + asq(q.text));
    return { presentation: name, slide: q.slide, shape: s.shapes.length };
  }
};

function run(argv) {
  try {
    var q = JSON.parse($.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null).js);
    var ops = q.app === 'word' ? word : powerpoint, app = Application(q.app === 'word' ? WORD : PPT);
    if (!app.running()) fail('not_running', 'The app is not running.');
    if (!ops[q.op]) fail('failed', 'Unknown request ' + q.op);
    return JSON.stringify({ ok: true, data: ops[q.op](app, q) });
  } catch (e) {
    return JSON.stringify({ ok: false, code: e.off || '', num: e.errorNumber || 0, error: String(e.message || e), names: e.names || [] });
  }
}
`

const APP: Record<OfficeApp, string> = { word: 'Microsoft Word', powerpoint: 'Microsoft PowerPoint' }
const LABEL: Record<OfficeApp, string> = { word: 'Word', powerpoint: 'PowerPoint' }
const TIMEOUT_MS = 90_000

/** Turns a failed call into an error the model and the user can act on. */
export function officeError(app: OfficeApp, r: { code?: string; num?: number; error?: string; names?: string[] }): OfficeError {
  const name = LABEL[app], msg = r.error ?? `${name} did not answer`
  if (r.code) return new OfficeError(r.code as OfficeCode, r.code === 'not_running' ? `${name} is not running.` : msg, r.names ?? [])
  if (r.num === -1743 || /not authori[sz]ed|not allowed to send/i.test(msg)) return new OfficeError('permission', `macOS has not allowed this app to control ${name}. Allow it in System Settings → Privacy & Security → Automation, then try again.`)
  if (r.num === -600 || r.num === -609 || /isn.t running|connection is invalid/i.test(msg)) return new OfficeError('not_running', `${name} is not running, or it closed while handling the request.`)
  if (r.num === -1712 || /timed out/i.test(msg)) return new OfficeError('busy', `${name} did not respond. Close any open dialog in ${name}, then try again.`)
  return new OfficeError('failed', `${name} refused the request: ${msg}`)
}

export class OsaOfficeBackend implements OfficeBackend {
  installed(app: OfficeApp): boolean {
    return process.platform === 'darwin' && [`/Applications/${APP[app]}.app`, path.join(os.homedir(), `Applications/${APP[app]}.app`)].some((p) => fs.existsSync(p))
  }

  running(app: OfficeApp): boolean {
    if (process.platform !== 'darwin') return false
    try { execFileSync('pgrep', ['-x', APP[app]], { stdio: 'ignore' }); return true } catch { return false }
  }

  call<T>(req: OfficeReq): Promise<T> {
    if (!this.running(req.app)) return Promise.reject(new OfficeError('not_running', `${LABEL[req.app]} is not running.`))
    // the request travels in a file: long text does not fit on a command line
    const file = path.join(os.tmpdir(), `office-req-${randomUUID()}.json`)
    fs.writeFileSync(file, JSON.stringify(req))
    return new Promise<T>((resolve, reject) => {
      execFile('osascript', ['-l', 'JavaScript', '-e', SCRIPT, file], { timeout: TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
        fs.rmSync(file, { force: true })
        if (err) {
          const killed = (err as any).killed || (err as any).signal === 'SIGTERM'
          return reject(killed ? officeError(req.app, { num: -1712 }) : officeError(req.app, { error: String(stderr || err.message).trim(), num: Number(/\((-\d+)\)/.exec(String(stderr))?.[1] ?? 0) }))
        }
        let r: any
        try { r = JSON.parse(stdout) } catch { return reject(new OfficeError('failed', `${LABEL[req.app]} returned an unreadable answer: ${stdout.slice(0, 200)}`)) }
        if (r.ok) resolve(r.data as T); else reject(officeError(req.app, r))
      })
    })
  }

  open(app: OfficeApp, file: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // -g: do not bring the app in front of what the user is doing
      execFile('open', ['-g', '-a', APP[app], file], { timeout: 30_000 }, (err, _o, stderr) => (err ? reject(new OfficeError('failed', `Could not open ${path.basename(file)} in ${LABEL[app]}: ${String(stderr || err.message).trim()}`)) : resolve()))
    })
  }
}
