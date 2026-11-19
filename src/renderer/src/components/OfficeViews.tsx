import type { PermissionDecision } from '../../../shared/api'
import { OFFICE_NAME, type OfficePreview } from '../../../shared/office'

const MARK = { word: 'W', powerpoint: 'P' } as const

/** Approval card for a change to a Word document or a PowerPoint presentation: what it reads now, and what it will read. */
export function OfficePermission({ detail, agentId, onDecide }: { detail: string; agentId: string; onDecide(d: PermissionDecision): void }) {
  let p: OfficePreview | null = null
  try { p = JSON.parse(detail) } catch { /* shown as text below */ }
  const app = p?.app === 'powerpoint' ? 'powerpoint' : 'word'
  return (
    <div className={`prompt-card of-approve ${app}`}>
      <div className="prompt-title">
        <span className={`of-dot ${app}`}>{MARK[app]}</span> Change {p?.document ?? 'this file'}?
        <span className="xl-badge live">Live</span>
        {agentId !== 'main' && <span className="muted"> · {agentId}</span>}
      </div>
      {p ? (
        <>
          <p className="xl-approve-sum">{p.summary}</p>
          {p.changes.map((c, i) => (
            <div key={i} className="of-change">
              <div className="label">{c.where}</div>
              {c.before !== undefined && <div className="of-text del" aria-label="Text now">{c.before}</div>}
              {c.after !== undefined && <div className="of-text add" aria-label="Text after the change">{c.after}</div>}
            </div>
          ))}
          {p.more && <div className="xl-grid-foot">{p.more}</div>}
        </>
      ) : <pre>{detail}</pre>}
      <div className="prompt-actions">
        <button className="primary" onClick={() => onDecide('allow')}>Apply</button>
        <button onClick={() => onDecide('allow_session')}>Apply all Word and PowerPoint changes in this chat</button>
        <button className="danger" onClick={() => onDecide('deny')}>Skip</button>
      </div>
    </div>
  )
}

/** The result of a word_* or powerpoint_* call: what was done, then the text it replaced. */
export function OfficeResult({ args, output, ok }: { args: Record<string, any>; output?: string; ok?: boolean }) {
  if (output === undefined) return typeof args.text === 'string' ? <pre className="term">{args.text.slice(0, 2000)}</pre> : null
  const i = ok === false ? -1 : output.indexOf('\n--- before ---\n')
  if (i < 0) return <pre className="term">{output}</pre>
  return (
    <div className="xl-result">
      <div className="xl-summary">{output.slice(0, i)}</div>
      <div className="label">Before</div>
      <div className="of-text del">{output.slice(i + 16)}</div>
      {typeof args.text === 'string' && args.text && <><div className="label">Now</div><div className="of-text add">{args.text}</div></>}
    </div>
  )
}

export { OFFICE_NAME }
