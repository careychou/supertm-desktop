import { parseGrid, sections, type ExcelPreview } from '../../../shared/excel'
import type { PermissionDecision } from '../../../shared/api'

const MAX_ROWS = 12
const MAX_COLS = 10

/** A block of cells drawn like a sheet: column letters across, row numbers down. `tone` colours the cells as new or replaced. */
export function ExcelGrid({ text, tone, label }: { text: string; tone?: 'add' | 'del'; label: string }) {
  const g = parseGrid(text)
  if (!g) return <pre className="term">{text}</pre>
  const cols = g.cols.slice(0, MAX_COLS), rows = g.rows.slice(0, MAX_ROWS)
  const more = [g.rows.length > rows.length && `${g.rows.length - rows.length} more row${g.rows.length - rows.length === 1 ? '' : 's'}`, g.cols.length > cols.length && `${g.cols.length - cols.length} more column${g.cols.length - cols.length === 1 ? '' : 's'}`].filter(Boolean).join(', ')
  return (
    <div className="xl-grid-wrap">
      <table className="xl-grid" aria-label={label}>
        <thead><tr><th />{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.n}><th>{r.n}</th>{cols.map((c, i) => {
              const v = r.cells[i] ?? ''
              return <td key={c} className={`${v === '' ? 'empty' : tone ?? ''}${/^-?[\d,.]+%?$/.test(v) ? ' n' : ''}`} title={v}>{v}</td>
            })}</tr>
          ))}
        </tbody>
      </table>
      {more && <div className="xl-grid-foot">Showing the first {rows.length} rows{g.cols.length > cols.length ? ` and ${cols.length} columns` : ''}; {more} not shown</div>}
    </div>
  )
}

const TITLES: Record<string, string> = { values: 'Cells read', formulas: 'Formulas', now: 'Now', before: 'Before' }

/** The result of an excel_* tool call: its summary line, then each block of cells as a grid. */
export function ExcelResult({ name, args, output, ok }: { name: string; args: Record<string, any>; output?: string; ok?: boolean }) {
  if (output === undefined) return name === 'excel_write' && Array.isArray(args.values) ? <pre className="term">{JSON.stringify(args.values).slice(0, 2000)}</pre> : null
  if (ok === false) return <pre className="term">{output}</pre>
  const s = sections(output)
  if (!s.parts.length) return <pre className="term">{output}</pre>
  return (
    <div className="xl-result">
      <div className="xl-summary">{s.summary}</div>
      {s.parts.map((p, i) => {
        const [grid, ...rest] = p.body.split(/\n(?=[^\d\t])/)
        return (
          <div key={i} className="xl-part">
            <div className="label">{TITLES[p.title] ?? p.title}</div>
            <ExcelGrid text={grid} tone={p.title === 'now' ? 'add' : p.title === 'before' ? 'del' : undefined} label={TITLES[p.title] ?? p.title} />
            {rest.length > 0 && <div className="xl-grid-foot">{rest.join(' ')}</div>}
          </div>
        )
      })}
    </div>
  )
}

/** Approval card for a change to a workbook: what will be written, and what it replaces. */
export function ExcelPermission({ detail, agentId, onDecide }: { detail: string; agentId: string; onDecide(d: PermissionDecision): void }) {
  let p: ExcelPreview | null = null
  try { p = JSON.parse(detail) } catch { /* shown as text below */ }
  return (
    <div className="prompt-card xl-approve">
      <div className="prompt-title">
        <span className="xl-dot">X</span> Change {p?.workbook ?? 'this workbook'}?
        {p && <span className={`xl-badge ${p.mode}`}>{p.mode === 'live' ? 'Live' : 'File'}</span>}
        {agentId !== 'main' && <span className="muted"> · {agentId}</span>}
      </div>
      {p ? (
        <>
          <p className="xl-approve-sum">{p.summary}</p>
          {(p.after || p.before) && (
            <div className="xl-approve-cols">
              {p.before && <div><div className="label">Now in the sheet</div><ExcelGrid text={p.before} tone="del" label="Cells that will be replaced" /></div>}
              {p.after && <div><div className="label">Will be written</div><ExcelGrid text={p.after} tone="add" label="Cells that will be written" /></div>}
            </div>
          )}
          {p.clipped && <div className="xl-grid-foot">{p.clipped}</div>}
        </>
      ) : <pre>{detail}</pre>}
      <div className="prompt-actions">
        <button className="primary" onClick={() => onDecide('allow')}>Apply</button>
        <button onClick={() => onDecide('allow_session')}>Apply all Excel changes in this chat</button>
        <button className="danger" onClick={() => onDecide('deny')}>Skip</button>
      </div>
    </div>
  )
}
