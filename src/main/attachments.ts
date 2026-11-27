import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { nativeImage, type NativeImage } from 'electron'
import type { Attachment } from '../engine/content'
import { IMAGE_TOKENS } from '../engine/content'
import { BRAND } from '../shared/brand'
import { compressText, encodeWithin, fmtBytes, fmtTokens, pptxToText, xlsxSharedStrings, xlsxSheetText, type AttachLimits, type AttachMeta } from '../shared/attach'

/** Raw input from the renderer: a file path (drop / picker / Finder copy) or bytes (pasted screenshot). */
export interface AttachInput { path?: string; name?: string; data?: Uint8Array }
export interface Prepared { id: string; att?: Attachment; meta: AttachMeta; error?: string }

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'tif', 'tiff', 'bmp'])
const PASS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])
const TEXTUTIL = new Set(['doc', 'docx', 'rtf', 'rtfd', 'odt', 'html', 'htm', 'webarchive', 'wordml'])
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
const MAX_INPUT = 200 * 1024 * 1024
const tmp = () => { const d = path.join(os.tmpdir(), `${BRAND.dataDir}-attach`); fs.mkdirSync(d, { recursive: true }); return d }
const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { maxBuffer: 256 * 1024 * 1024, timeout: 60000 })

/**
 * Turns a picked, dropped or pasted file into what the model receives. With `keepDir`, pasted data is kept there,
 * so every attachment has a file on disk that the model can read again with its tools.
 */
export async function prepareAttachment(input: AttachInput, l: AttachLimits, keepDir?: string): Promise<Prepared> {
  const id = randomUUID()
  let file = input.path ?? ''
  const name = input.name || path.basename(file) || 'pasted'
  let ok = false
  try {
    if (!file) {
      if (!input.data) throw new Error('nothing to attach')
      if (keepDir) fs.mkdirSync(keepDir, { recursive: true })
      file = path.join(keepDir ?? tmp(), `${id.slice(0, 8)}-${name.replace(/[^\w.-]/g, '_')}`)
      fs.writeFileSync(file, input.data)
    }
    const r = await build(id, file, name, l)
    if (r.att && (input.path || keepDir)) r.att.path = file
    ok = true
    return r
  } catch (e: any) {
    return { id, meta: { name, kind: 'doc', info: 'Could not attach' }, error: e?.message ?? String(e) }
  } finally {
    if (!input.path && file && !(ok && keepDir)) fs.rmSync(file, { force: true })
  }
}

/** A file a tool opened (read_file on a PNG), encoded within the attachment limits so the model sees the picture. */
export async function loadToolImage(file: string, l: AttachLimits): Promise<{ dataUrl: string; width: number; height: number }> {
  const st = fs.statSync(file)
  if (st.size > MAX_INPUT) throw new Error(`image is ${fmtBytes(st.size)}; the limit is ${fmtBytes(MAX_INPUT)}`)
  const ext = sniff(file) || path.extname(file).slice(1).toLowerCase()
  const { att } = image(file, path.basename(file), ext === 'jpg' ? 'jpeg' : ext, st.size, l)
  return { dataUrl: att.dataUrl, width: att.width, height: att.height }
}

async function build(id: string, file: string, name: string, l: AttachLimits): Promise<Prepared> {
  {
    const st = fs.statSync(file)
    if (st.isDirectory()) throw new Error('folders cannot be attached; mention the path in your prompt instead')
    if (st.size > MAX_INPUT) throw new Error(`file is ${fmtBytes(st.size)}; the limit is ${fmtBytes(MAX_INPUT)}`)
    const ext = path.extname(name).slice(1).toLowerCase() || sniff(file)
    if (IMAGE.has(ext)) return { id, ...image(file, name, ext, st.size, l) }
    if (ext === 'pdf') return { id, ...(await pdf(file, name, st.size, l)) }
    let text: string
    if (TEXTUTIL.has(ext)) text = run('textutil', ['-convert', 'txt', '-stdout', file]).toString('utf8')
    else if (ext === 'pptx') text = pptx(file)
    else if (ext === 'xlsx') text = xlsx(file)
    else {
      const buf = fs.readFileSync(file)
      if (buf.subarray(0, 8192).includes(0)) throw new Error(`.${ext || 'binary'} files are not supported; supported: images, PDF, Office (docx/xlsx/pptx), RTF/HTML and text/code files`)
      text = buf.toString('utf8')
    }
    return { id, ...doc(name, text, st.size, l) }
  }
}

function sniff(file: string): string {
  const h = Buffer.alloc(12)
  const fd = fs.openSync(file, 'r'); fs.readSync(fd, h, 0, 12, 0); fs.closeSync(fd)
  if (h[0] === 0x89 && h[1] === 0x50) return 'png'
  if (h[0] === 0xff && h[1] === 0xd8) return 'jpg'
  if (h.toString('ascii', 0, 4) === 'GIF8') return 'gif'
  if (h.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  if (h.toString('ascii', 0, 4) === '%PDF') return 'pdf'
  return ''
}

function load(file: string): NativeImage {
  let img = nativeImage.createFromPath(file)
  if (img.isEmpty()) {
    // formats NSImage cannot open directly (some HEIC/TIFF): let macOS `sips` convert first
    const out = path.join(tmp(), `${randomUUID()}.png`)
    run('sips', ['-s', 'format', 'png', file, '--out', out])
    img = nativeImage.createFromPath(out)
    fs.rmSync(out, { force: true })
  }
  if (img.isEmpty()) throw new Error('unreadable image')
  return img
}

function image(file: string, name: string, ext: string, size: number, l: AttachLimits) {
  const img = load(file)
  const { width: w, height: h } = img.getSize()
  let data: Buffer, mime: string, dims = { width: w, height: h }
  if (PASS.has(ext) && Math.max(w, h) <= l.imageMaxEdge && size <= Math.min(400 * 1024, l.imageMaxKB * 1024)) {
    data = fs.readFileSync(file); mime = MIME[ext]
  } else {
    const r = encodeWithin(w, h, l, (width, height, q) => resized(img, w, width, height).toJPEG(q))
    data = r.bytes; mime = 'image/jpeg'; dims = { width: r.width, height: r.height }
    // screenshots / diagrams often stay crisper and no bigger as PNG
    if (ext === 'png') {
      const png = resized(img, w, r.width, r.height).toPNG()
      if (png.length <= Math.min(data.length * 1.25, l.imageMaxKB * 1024)) { data = png; mime = 'image/png' }
    }
  }
  const thumb = img.resize({ height: Math.min(96, h), quality: 'good' }).toJPEG(70)
  const att: Attachment = { kind: 'image', name, dataUrl: `data:${mime};base64,${data.toString('base64')}`, width: dims.width, height: dims.height }
  const shrunk = data.length < size || dims.width !== w
  const info = `${shrunk ? `${fmtBytes(size)} → ` : ''}${fmtBytes(data.length)} · ${dims.width}×${dims.height} · ${fmtTokens(IMAGE_TOKENS)}`
  return { att, meta: { name, kind: 'image' as const, thumb: `data:image/jpeg;base64,${thumb.toString('base64')}`, info } }
}

const resized = (img: NativeImage, w: number, width: number, height: number) => (width === w ? img : img.resize({ width, height, quality: 'best' }))

function doc(name: string, raw: string, size: number, l: AttachLimits, extra = '') {
  const c = compressText(raw, l.docMaxChars)
  if (!c.text) throw new Error('no readable text found')
  const note = c.truncated ? `truncated: kept ${c.text.length.toLocaleString('en-US')} of ${c.originalChars.toLocaleString('en-US')} characters` : undefined
  const att: Attachment = { kind: 'text', name, text: c.text, note: [extra, note].filter(Boolean).join('; ') || undefined }
  const info = `${fmtBytes(size)}${extra ? ` · ${extra}` : ''} · ${fmtTokens(Math.round(c.text.length / 4))}${c.truncated ? ' · trimmed' : ''}`
  return { att, meta: { name, kind: 'doc' as const, info } }
}

/** Renders the first pages of a PDF to PNG files with PDFKit (JXA), which needs no extra install on macOS. */
const RENDER = `ObjC.import('Quartz'); ObjC.import('AppKit')
function run(argv) {
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]))
  if (doc.isNil()) throw new Error('unreadable PDF')
  const n = Math.min(Number(doc.pageCount), Number(argv[2])), edge = Number(argv[3])
  for (let i = 0; i < n; i++) {
    const page = doc.pageAtIndex(i), b = page.boundsForBox($.kPDFDisplayBoxMediaBox)
    const s = edge / Math.max(b.size.width, b.size.height)
    const img = page.thumbnailOfSizeForBox($.NSMakeSize(b.size.width * s, b.size.height * s), $.kPDFDisplayBoxMediaBox)
    const rep = $.NSBitmapImageRep.imageRepWithData(img.TIFFRepresentation)
    rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary).writeToFileAtomically(argv[1] + '/p' + (i + 1) + '.png', true)
  }
  return String(n)
}`

function renderPages(file: string, max: number, edge: number): string[] {
  const dir = fs.mkdtempSync(path.join(tmp(), 'pdf-'))
  try {
    const n = Number(run('osascript', ['-l', 'JavaScript', '-e', RENDER, file, dir, String(max), String(edge)]).toString('utf8').trim())
    if (n > 0) return Array.from({ length: n }, (_, i) => path.join(dir, `p${i + 1}.png`))
  } catch { /* fall through to page 1 only */ }
  const out = path.join(dir, 'p1.png')
  run('sips', ['-s', 'format', 'png', file, '--out', out])
  return [out]
}

async function pdf(file: string, name: string, size: number, l: AttachLimits) {
  const { extractText, getDocumentProxy } = await import('unpdf')
  const bytes = fs.readFileSync(file)
  const doc0 = await getDocumentProxy(new Uint8Array(bytes))
  const { totalPages, text } = await extractText(doc0, { mergePages: false })
  const pages = (text as string[]).map((t, i) => `--- page ${i + 1} ---\n${t.trim()}`)
  const count = `${totalPages} page${totalPages === 1 ? '' : 's'}`
  if ((text as string[]).join('').trim().length < 20 * totalPages) {
    // scanned PDF without a text layer: send its pages as images, up to the page cap
    const files = renderPages(file, Math.max(1, l.pdfMaxPages), l.imageMaxEdge)
    try {
      const imgs = files.map((f) => image(f, name, 'png', fs.statSync(f).size, l))
      const sent = imgs.map((r) => { const a = r.att as Extract<Attachment, { kind: 'image' }>; return { dataUrl: a.dataUrl, width: a.width, height: a.height } })
      const att: Attachment = { kind: 'pages', name, pages: sent, total: totalPages }
      const info = `scanned PDF (${count}) · ${sent.length === totalPages ? 'all pages' : `first ${sent.length}`} as images · ${fmtTokens(sent.length * IMAGE_TOKENS)}`
      return { att, meta: { name, kind: 'image' as const, thumb: imgs[0].meta.thumb, info } }
    } finally { fs.rmSync(path.dirname(files[0]), { recursive: true, force: true }) }
  }
  const r = doc(name, pages.join('\n\n'), size, l, count)
  const t = r.att as Extract<Attachment, { kind: 'text' }>
  if (l.pdfNativeMaxMB <= 0 || size > l.pdfNativeMaxMB * 1024 * 1024 || totalPages > l.pdfMaxPages) return r
  // small enough to send as the file itself: Claude also sees the layout, charts and tables; other models get the text
  const att: Attachment = { kind: 'pdf', name, data: bytes.toString('base64'), text: t.text, pages: totalPages, note: t.note }
  return { att, meta: { name, kind: 'doc' as const, info: r.meta.info, pdf: true } }
}

const zipList = (file: string) => run('unzip', ['-Z1', file]).toString('utf8').split('\n').filter(Boolean)
const zipRead = (file: string, entry: string) => run('unzip', ['-p', file, entry]).toString('utf8')
const byNum = (a: string, b: string) => Number(/(\d+)\.xml$/.exec(a)?.[1]) - Number(/(\d+)\.xml$/.exec(b)?.[1])

function pptx(file: string): string {
  const slides = zipList(file).filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e)).sort(byNum)
  return pptxToText(slides.map((s) => zipRead(file, s)))
}

function xlsx(file: string): string {
  const entries = zipList(file)
  const shared = entries.includes('xl/sharedStrings.xml') ? xlsxSharedStrings(zipRead(file, 'xl/sharedStrings.xml')) : []
  const names = [...zipRead(file, 'xl/workbook.xml').matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((m) => m[1])
  const sheets = entries.filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e)).sort(byNum)
  return sheets.map((s, i) => `--- sheet: ${names[i] ?? i + 1} ---\n${xlsxSheetText(zipRead(file, s), shared)}`).join('\n\n')
}
