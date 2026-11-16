import { useMemo } from 'react'
import { Marked } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'

const MEDIA = /^desk-media:\/\/media\//

const md = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      const l = lang && hljs.getLanguage(lang) ? lang : undefined
      const html = l ? hljs.highlight(text, { language: l }).value : hljs.highlightAuto(text).value
      return `<pre class="code"><code class="hljs">${html}</code></pre>`
    },
    link({ href, text }) {
      // Audio saved by a text-to-speech model plays inline.
      if (MEDIA.test(href) && /\.(wav|mp3|ogg)$/i.test(href)) return `<audio class="md-audio" controls preload="metadata" src="${href}" title="${text}"></audio>`
      return false
    }
  }
})

/** DOMPurify's default URI allow-list plus the app's own media scheme. */
const URI_OK = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix|desk-media):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noreferrer') }
})

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(md.parse(text) as string, { ALLOWED_URI_REGEXP: URI_OK }), [text])
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
}
