import { useEffect, useState } from 'react'

/** Seconds since mount, ticking once a second. */
function useElapsed(): number {
  const [t0] = useState(() => Date.now())
  const [now, setNow] = useState(t0)
  useEffect(() => { const h = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(h) }, [])
  return Math.floor((now - t0) / 1000)
}
const fmt = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`)

/**
 * Busy indicator for slow actions. Determinate when `prog` has a total; otherwise an
 * indeterminate bar with an elapsed-time counter so it's clear the app is still working.
 */
export function ProgressBar({ label, prog, hint }: { label: string; prog?: { done: number; total: number } | null; hint?: string }) {
  const known = !!prog && prog.total > 0
  const pct = known ? Math.round((prog!.done / prog!.total) * 100) : 0
  const secs = useElapsed()
  return (
    <div className="import-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={known ? pct : undefined} aria-label={label} aria-busy="true">
      <div className="import-progress-label">
        <span><span className="spinner" /> {label}</span>
        <span className="muted small">{known ? `${prog!.done} of ${prog!.total} · ${pct}%` : fmt(secs)}</span>
      </div>
      <div className={`import-progress-track${known ? '' : ' indeterminate'}`}><div className="import-progress-fill" style={known ? { width: `${pct}%` } : undefined} /></div>
      {hint && <div className="muted small">{hint}</div>}
    </div>
  )
}

/** Button content while busy: spinner + verb. */
export const Busy = ({ text }: { text: string }) => <><span className="spinner" /> {text}</>
