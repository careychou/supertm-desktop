import { createContext, useContext, useLayoutEffect, useMemo, useRef, type MouseEvent } from 'react'
import { Marked } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'

const MEDIA = /^desk-media:\/\/media\//
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Text in backticks that could be a file or folder: has a slash or ends in an extension, and holds nothing a path would not. Whether it exists is checked on disk before it becomes a link. */
const maybePath = (t: string) => t.length > 1 && t.length < 400 && !/[\n*?<>|"`$=;{}]/.test(t) && !/^[-.]+$/.test(t) && !/^-/.test(t) && (t.includes('/') || /\.[A-Za-z0-9]{1,10}$/.test(t))
const WEB = /^https?:\/\/[^\s<>"`]+$/i

const md = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      const l = lang && hljs.getLanguage(lang) ? lang : undefined
      const html = l ? hljs.highlight(text, { language: l }).value : hljs.highlightAuto(text).value
      return `<pre class="code"><code class="hljs">${html}</code></pre>`
    },
    codespan({ text }) {
      // A URL or a file path in backticks is as clickable as a real link.
      if (WEB.test(text)) return `<a href="${esc(text)}"><code>${esc(text)}</code></a>`
      if (maybePath(text)) return `<a class="path-maybe" data-path="${esc(text)}"><code>${esc(text)}</code></a>`
      return false
    },
    link({ href, text }) {
      // Audio saved by a text-to-speech model plays inline.
      if (MEDIA.test(href) && /\.(wav|mp3|ogg)$/i.test(href)) return `<audio class="md-audio" controls preload="metadata" src="${href}" title="${text}"></audio>`
      return false
    }
  }
})

/** [name](/path with spaces.html) is not a markdown link until the path is in angle brackets; models forget, so add them. */
const fixSpacedLinks = (s: string) => s.replace(/\]\(((?:\/|~\/|\.\.?\/)[^()<>"'\n]* [^()<>"'\n]*)\)/g, (_m, p: string) => `](<${p.trim()}>)`)

/** DOMPurify's default URI allow-list plus the app's own media scheme. */
const URI_OK = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix|desk-media|file|computer):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noreferrer') }
})

/** The working folder of the chat on screen: relative paths in a message resolve against it. */
export const CwdContext = createContext('')

const HINT = 'Click to open · ⌘-click to show in Finder'
const known = new Map<string, string | null>()
const toast = (m: string) => window.dispatchEvent(new CustomEvent('desk-toast', { detail: m }))
/** A link target that is a file on this Mac rather than a web address. */
const localHref = (h: string) => /^(file|computer):/i.test(h) || !/^[a-z][a-z0-9+.\-]*:/i.test(h)

export function Markdown({ text }: { text: string }) {
  const cwd = useContext(CwdContext)
  const ref = useRef<HTMLDivElement>(null)
  const html = useMemo(() => DOMPurify.sanitize(md.parse(fixSpacedLinks(text)) as string, { ALLOWED_URI_REGEXP: URI_OK }), [text])

  // Backticked paths that exist on disk become links; links to local files get the open hint.
  useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    for (const a of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      const h = a.getAttribute('href') ?? ''
      if (!h.startsWith('#') && localHref(h)) { a.classList.add('file-link'); let shown = h; try { shown = decodeURIComponent(h.replace(/^computer:\/\//i, '')) } catch { /* keep as written */ } a.title = `${shown}\n${HINT}` }
    }
    const els = [...root.querySelectorAll<HTMLElement>('a.path-maybe')]
    const key = (e: HTMLElement) => `${cwd}\n${e.dataset.path}`
    const mark = () => { for (const e of els) { const p = known.get(key(e)); if (p) { e.classList.add('file-link'); e.title = `${p}\n${HINT}` } } }
    mark()
    const ask = [...new Set(els.filter((e) => !known.has(key(e))).map((e) => e.dataset.path!))]
    if (!ask.length) return
    let live = true
    void window.desk.pathsExist(ask, cwd).then((r) => { ask.forEach((p, i) => known.set(`${cwd}\n${p}`, r[i])); if (live) mark() }).catch(() => {})
    return () => { live = false }
  }, [html, cwd])

  const onClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    const h = a.getAttribute('href')
    const p = h == null ? (a.classList.contains('file-link') ? a.dataset.path : undefined) : h.startsWith('#') ? undefined : localHref(h) ? h : null
    if (p === null) return // a web link: the app hands it to the browser
    e.preventDefault()
    if (!p) return
    void window.desk.openPath(p, cwd, e.metaKey || e.altKey).then((r) => { if (!r.ok) toast(r.error ?? 'Could not open that file.'); else if (r.revealed && !(e.metaKey || e.altKey)) toast('Shown in Finder.') })
  }

  return <div ref={ref} className="md" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
}
