import { useEffect, useState } from 'react'
import type { PushEvent } from '../../../shared/api'
import type { UpdateCheck, UpdateState } from '../../../shared/updates'
import { Markdown } from '../Markdown'

const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`
const day = (d: string) => (d ? new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '')

/** Settings → About: lists newer releases with their notes and installs the one the user picks. */
export function UpdatesPanel({ onSecrets }: { onSecrets?(): void }) {
  const [check, setCheck] = useState<UpdateCheck | null>(null)
  const [checking, setChecking] = useState(false)
  const [st, setSt] = useState<UpdateState>({ phase: 'idle' })
  const [err, setErr] = useState('')
  const run = async () => { setChecking(true); setErr(''); try { setCheck(await window.desk.checkUpdates()) } finally { setChecking(false) } }
  useEffect(() => {
    void run()
    void window.desk.updateState().then(setSt)
    return window.desk.onPush((p: PushEvent) => { if (p.type === 'update') setSt(p.state) })
  }, [])

  const latest = check?.newer[0]
  const install = async () => { setErr(''); const r = await window.desk.installUpdate(); if (!r.ok) setErr(r.error ?? 'Install failed') }
  return (
    <div className="updates">
      <div className="updates-head">
        <b>Updates</b>
        <span className="muted small">
          {checking ? 'Checking…'
            : check?.error ? `✗ ${check.error}`
            : check && !latest ? `✓ You're on the latest version (${check.current})`
            : latest ? `${check!.newer.length === 1 ? 'A newer release is' : `${check!.newer.length} newer releases are`} available`
            : ''}
        </span>
        <div className="spacer" />
        <button disabled={checking || st.phase === 'downloading'} onClick={() => void run()}>Check for updates</button>
      </div>
      {check?.needsToken && onSecrets && <div className="small">Releases are on a private GitLab project. <button className="link" onClick={onSecrets}>Save a GitLab token in AI Teammate secrets</button>, then check again.</div>}
      {latest && (
        <>
          <div className="update-action">
            {!check!.canInstall ? (
              <span className="small muted">{check!.installBlocked} Download it from the <button className="link" onClick={() => void window.desk.openRelease(latest.url)}>release page ↗</button> instead.</span>
            ) : st.phase === 'downloading' ? (
              <>
                <progress max={st.total || 1} value={st.total ? st.received : undefined} />
                <span className="small muted">Downloading {st.version}… {mb(st.received)}{st.total ? ` of ${mb(st.total)}` : ''}</span>
                <button onClick={() => void window.desk.cancelUpdate()}>Cancel</button>
              </>
            ) : st.phase === 'ready' ? (
              <>
                <button className="primary" onClick={() => void install()}>Restart to install {st.version}</button>
                <span className="small muted">Running chats stop. Your chats, settings and keys are kept.</span>
              </>
            ) : (
              <>
                <button className="primary" onClick={() => void window.desk.downloadUpdate(latest.version)}>Download {latest.version}</button>
                {st.phase === 'error' && <span className="small err">✗ {st.error}</span>}
              </>
            )}
            {err && <span className="small err">✗ {err}</span>}
          </div>
          {check!.canInstall && <div className="small muted">After it restarts, macOS asks once for keychain access. Choose <b>Always Allow</b> to keep your saved keys.</div>}
          <div className="release-list">
            {check!.newer.map((r, i) => (
              <details key={r.tag} className="release" open={i === 0}>
                <summary><b>{r.version}</b> <span className="muted small">{day(r.date)}</span>{r.url && <button className="link small" onClick={(e) => { e.preventDefault(); void window.desk.openRelease(r.url) }}>release page ↗</button>}</summary>
                <div className="release-notes">{r.notes.trim() ? <Markdown text={r.notes} /> : <span className="muted">No release notes.</span>}</div>
              </details>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
