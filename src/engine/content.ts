import type { ContentPart, Message } from './types'

/** What the engine receives for one attached file, after the desktop has prepared and compressed it. */
export type Attachment =
  | { kind: 'image'; name: string; dataUrl: string; width: number; height: number; path?: string }
  | { kind: 'text'; name: string; text: string; note?: string; path?: string }
  /** A PDF with a text layer: `data` is the base64 file for models that read PDFs, `text` the extracted text for the rest. */
  | { kind: 'pdf'; name: string; data: string; text: string; pages: number; note?: string; path?: string }
  /** A scanned PDF: its first pages rendered as images (`total` = pages in the file). */
  | { kind: 'pages'; name: string; pages: { dataUrl: string; width: number; height: number }[]; total: number; path?: string }

/** Rough per-image token cost (Claude/Gemini bill ~w*h/750, capped near 1.6k after their own downscale). */
export const IMAGE_TOKENS = 1600

type FilePart = Extract<ContentPart, { type: 'file' }>
const attr = (s: string) => s.replace(/"/g, "'")
const tag = (name: string, text: string, note?: string) => `<attachment name="${attr(name)}"${note ? ` note="${attr(note)}"` : ''}>\n${text}\n</attachment>`

/** The text form of a PDF part, in the same shape as an inlined document. */
export const fileText = (p: FilePart) => tag(p.file.name, p.file.text, p.file.note)

/** Plain text of a message content, with images shown as a marker and PDFs as their extracted text. */
export function textOf(content: string | ContentPart[] | null | undefined): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  return content.map((p) => (p.type === 'text' ? p.text : p.type === 'file' ? fileText(p) : '[image]')).join('\n')
}

/** Replaces PDF parts by their text, for models and endpoints that cannot read a PDF. Never mutates the input. */
export function filesAsText(messages: Message[]): Message[] {
  return messages.map((m) => (m.role === 'user' && Array.isArray(m.content) && m.content.some((p) => p.type === 'file')
    ? { ...m, content: m.content.map((p): ContentPart => (p.type === 'file' ? { type: 'text', text: fileText(p) } : p)) }
    : m))
}

/** Tells the model where the original is, so it can read more of it with its file tools. */
const onDisk = (path?: string, note?: string) => (path && !note?.includes('file on disk:') ? `file on disk: ${path}` : '')
const join = (...s: (string | undefined)[]) => s.filter(Boolean).join('; ') || undefined

/** Builds user content: prompt + inlined documents as text (+ optional recall hints), then each image with a short caption. */
export function buildUserContent(prompt: string, atts: Attachment[] = [], hints = ''): string | ContentPart[] {
  const docs = atts.filter((a): a is Extract<Attachment, { kind: 'text' }> => a.kind === 'text')
  const imgs = atts.filter((a): a is Extract<Attachment, { kind: 'image' }> => a.kind === 'image')
  let text = prompt.trim() || (atts.length ? 'Please take a look at the attached file(s).' : '')
  const pdfs = atts.filter((a): a is Extract<Attachment, { kind: 'pdf' }> => a.kind === 'pdf')
  const scans = atts.filter((a): a is Extract<Attachment, { kind: 'pages' }> => a.kind === 'pages')
  for (const d of docs) text += `\n\n${tag(d.name, d.text, join(d.note, onDisk(d.path, d.note)))}`
  // recall hints go last, next to the prompt, so the cached prefix of the request is unchanged
  if (hints && text) text += `\n\n${hints}`
  if (!imgs.length && !pdfs.length && !scans.length) return text
  const parts: ContentPart[] = [{ type: 'text', text }]
  const at = (path?: string) => (path ? `; ${onDisk(path)}` : '')
  for (const d of pdfs) parts.push({ type: 'file', file: { name: d.name, media_type: 'application/pdf', data: d.data, text: d.text, pages: d.pages, note: join(d.note, onDisk(d.path)) } })
  for (const s of scans) {
    const n = s.pages.length
    parts.push({ type: 'text', text: `Attached scanned PDF: ${s.name} (${n < s.total ? `pages 1-${n} of ${s.total}` : `${n} page${n === 1 ? '' : 's'}`}, one image per page)${at(s.path)}` })
    for (const pg of s.pages) parts.push({ type: 'image_url', image_url: { url: pg.dataUrl } })
  }
  for (const i of imgs) {
    parts.push({ type: 'text', text: `Attached image: ${i.name} (${i.width}×${i.height})${at(i.path)}` })
    parts.push({ type: 'image_url', image_url: { url: i.dataUrl } })
  }
  return parts
}

export interface RequestBudget {
  /** Upper bound for the serialized request body (Vertex rejects > 30 MB). */
  maxBytes: number
  /** Only the images from the last N user messages are re-sent; older ones become a text note. 0 = keep all. */
  imageTurns: number
}

export const OMITTED_IMAGE = '[An earlier image was omitted here to save context. If you need to see it again, read the file again (when a tool opened it) or ask the user to re-attach it.]'
/** Starts the user-role message that carries images a tool opened (read_file on a PNG); not a user turn. */
export const TOOL_IMAGE_TAG = '<tool_images>'
const toolImages = (m: Message) => m.role === 'user' && textOf(m.content).startsWith(TOOL_IMAGE_TAG)

const heavy = (p: ContentPart) => p.type === 'image_url' || p.type === 'file'
/** An image becomes a note; a PDF falls back to its extracted text. */
const light = (p: ContentPart): ContentPart => (p.type === 'file' ? { type: 'text', text: fileText(p) } : { type: 'text', text: OMITTED_IMAGE })
const hasImage = (m: Message) => m.role === 'user' && Array.isArray(m.content) && m.content.some(heavy)

/**
 * Returns messages that fit the budget: images outside the last `imageTurns` user messages are replaced by a note
 * (PDFs by their extracted text), then the oldest remaining ones go the same way until the JSON body is under `maxBytes`.
 * Never mutates the input.
 */
export function fitRequest(messages: Message[], b: RequestBudget): Message[] {
  if (!messages.some(hasImage)) return messages
  const out: Message[] = messages.map((m) => (hasImage(m) ? { ...m, content: (m.content as ContentPart[]).map((p) => ({ ...p })) } as Message : m))
  const omit = (m: Message) => {
    m.content = (m.content as ContentPart[]).map((p) => (heavy(p) ? light(p) : p)) as any
  }
  if (b.imageTurns > 0) {
    // Images a tool opened belong to the turn of the user message before them.
    const users = out.map((m, i) => (m.role === 'user' && !toolImages(m) ? i : -1)).filter((i) => i >= 0)
    const from = users.length > b.imageTurns ? users[users.length - b.imageTurns] : 0
    out.forEach((m, i) => { if (hasImage(m) && i < from) omit(m) })
  }
  const size = () => JSON.stringify(out).length
  if (size() <= b.maxBytes) return out
  for (const m of out) {
    if (!hasImage(m)) continue
    const parts = m.content as ContentPart[]
    for (let k = 0; k < parts.length; k++) {
      if (!heavy(parts[k])) continue
      parts[k] = light(parts[k])
      if (size() <= b.maxBytes) return out
    }
  }
  return out
}
