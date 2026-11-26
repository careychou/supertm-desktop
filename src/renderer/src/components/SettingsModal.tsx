import { useEffect, useState } from 'react'
import type { AppInfo, ExcelStatus, ModelGroup, RegistryInfo, Settings } from '../../../shared/api'
import { OFFICE_NAME, type OfficeApp, type OfficeStatus } from '../../../shared/office'
import { bareModel } from '../../../shared/providers'
import { BRAND } from '../../../shared/brand'
import { ProvidersTab } from './ProvidersTab'
import { SyncTab } from './SyncTab'
import { UpdatesPanel } from './UpdatesPanel'
import { Dialog } from './Dialog'
import { Lbl } from './Info'
import { McpTab } from './McpTab'

type Tab = 'providers' | 'general' | 'office' | 'mcp' | 'compaction' | 'skills' | 'sync' | 'about'

export function SettingsModal({ cwd, folders, onClose, initialTab }: { cwd: string; folders: string[]; onClose(): void; initialTab?: Tab }) {
  const [s, setS] = useState<Settings | null>(null)
  const [groups, setGroups] = useState<ModelGroup[]>([])
  const [health, setHealth] = useState('')
  const [tab, setTab] = useState<Tab>(initialTab ?? 'providers')
  useEffect(() => {
    void window.desk.getSettings().then(setS)
    void window.desk.listModels().then((r) => setGroups(r.groups ?? []))
  }, [cwd])
  if (!s) return null
  const set = (k: keyof Settings, v: string | number | boolean) => setS({ ...s, [k]: v })
  const testAll = async () => {
    await window.desk.saveSettings(s)
    const r = await window.desk.listModels()
    setGroups(r.groups ?? [])
    setHealth(r.error ? `✗ ${r.error}` : `✓ ${r.models.length} models from ${r.groups.filter((g) => !g.error).length} provider(s)`)
  }
  const tabs: Array<[Tab, string]> = [['providers', 'Model providers'], ['general', 'General'], ['office', 'MS Office'], ['mcp', 'MCP servers'], ['compaction', 'Memory compaction'], ['skills', 'Skills & agents'], ['sync', 'Sync sessions'], ['about', 'About']]
  const compactKnown = !s.compactModel || groups.some((g) => g.models.includes(s.compactModel))
  return (
    <Dialog id="settings" className="settings" onClose={onClose} head={
      <div className="tabs">{tabs.map(([k, label]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>)}</div>
    }>
        {tab === 'providers' && <ProvidersTab s={s} setS={setS} />}
        {tab === 'general' && (
          <div className="form">
            <label><Lbl text="Default thinking for new chats (each chat can override it below its chat box)" tip="How much the model reasons before answering in a new chat. More thinking helps hard problems but is slower and uses more tokens. Models without thinking ignore it." ex="Medium for everyday work; switch one chat to High to debug a tricky formula, or Off for quick lookups." />
              <select value={s.reasoning} onChange={(e) => set('reasoning', e.target.value)}>
                <option value="off">Off — no thinking block</option>
                <option value="low">Low</option>
                <option value="medium">Medium (default)</option>
                <option value="high">High — deeper, slower</option>
              </select>
            </label>
            <label><Lbl text="Default mode for new chats (each chat can switch below its chat box)" tip="Whether the agent may run shell commands, write files and fetch web pages on its own, or must ask you first each time." ex="Autopilot: asked to tidy a folder, it moves the files itself. Interactive: you approve each move." />
              <select value={s.defaultMode} onChange={(e) => set('defaultMode', e.target.value)}>
                <option value="autopilot">Autopilot — run shell, file and web tools without asking</option>
                <option value="interactive">Interactive — ask before shell, file writes and web fetches</option>
              </select>
            </label>
            <label><Lbl text="Check for a new release when the app starts" tip="A few seconds after launch the app looks for a newer release. If there is one, a banner offers to show its notes and install it; nothing is downloaded until you choose to. Settings → About → Check for updates always works, whatever this is set to." ex="On: after 1.5.2 is published, starting 1.5.1 shows “1.5.2 is available — See what's new & install”." />
              <select value={s.checkUpdatesOnLaunch === false ? 'off' : 'on'} onChange={(e) => setS({ ...s, checkUpdatesOnLaunch: e.target.value === 'on' })}>
                <option value="on">On — tell me when a new release is available (default)</option>
                <option value="off">Off — I'll check in Settings → About</option>
              </select>
            </label>
            <label><Lbl text="Bookmarked chats in working folders" tip="A chat you pin to Bookmarks, together with its sub-chats, can be listed only under Bookmarks so the folder lists stay short, or in both places. A hidden chat is not moved or changed: unpin it and it is back in its folder. Each folder shows how many of its chats are in Bookmarks." ex="Hide: pin “req queue” and it and its forks leave the demo folder; the folder ends with “★ 3 in Bookmarks”." />
              <select value={s.hidePinnedInFolders === false ? 'show' : 'hide'} onChange={(e) => setS({ ...s, hidePinnedInFolders: e.target.value === 'hide' })}>
                <option value="hide">Hide — show them only under Bookmarks (default)</option>
                <option value="show">Show — list them under Bookmarks and in their folder</option>
              </select>
            </label>
            <div className="sub-h">Attachments: compress to save tokens and stay under the provider's request limit</div>
            <div className="row3">
              <label><Lbl text="Image max edge (px)" tip="Attached images are shrunk so their longest side is at most this many pixels. Smaller images cost fewer tokens; most models see little benefit above ~1568." ex="At 1568, a 4000×3000 photo is sent as 1568×1176." /><input type="number" min={256} max={4096} step={64} value={s.imageMaxEdge} onChange={(e) => set('imageMaxEdge', Number(e.target.value))} /></label>
              <label><Lbl text="JPEG quality" tip="Compression quality (40–100) used when an image is re-encoded. Lower means smaller files with more blur." ex="82 keeps text in screenshots readable at about a third of the size of 100." /><input type="number" min={40} max={100} value={s.imageQuality} onChange={(e) => set('imageQuality', Number(e.target.value))} /></label>
              <label><Lbl text="Max per image (KB)" tip="If an image is still larger than this after resizing, quality is lowered until it fits." ex="At 1500, a 6 MB PNG screenshot is sent as a JPEG under 1.5 MB." /><input type="number" min={100} step={100} value={s.imageMaxKB} onChange={(e) => set('imageMaxKB', Number(e.target.value))} /></label>
            </div>
            <div className="row3">
              <label><Lbl text="Max document chars" tip="Text pulled from an attached document (PDF, Word, Excel, etc.) is clipped to this many characters. About 4 characters ≈ 1 token." ex="At 80000, a 300-page PDF sends its first ~80k characters (~20k tokens); the agent can still read the rest with its file tools." /><input type="number" min={2000} step={10000} value={s.docMaxChars} onChange={(e) => set('docMaxChars', Number(e.target.value))} /></label>
              <label><Lbl text="Re-send images from last N prompts" tip="Images attached in your most recent N prompts are re-sent on every model call; older ones are replaced by a short note to save tokens. 0 = always re-send all." ex="At 4, a screenshot from 10 prompts ago becomes [image omitted], so the model no longer sees its pixels." /><input type="number" min={0} max={50} value={s.imageTurns} onChange={(e) => set('imageTurns', Number(e.target.value))} /></label>
              <label><Lbl text="Max request size (MB)" tip="Upper bound for one request to the provider. If a request would be larger, the oldest images are dropped first. Vertex rejects requests above 30 MB." ex="At 20, a chat with 15 large screenshots drops the earliest ones instead of failing." /><input type="number" min={1} max={100} value={s.requestMaxMB} onChange={(e) => set('requestMaxMB', Number(e.target.value))} /></label>
            </div>
            <div className="row3">
              <label><Lbl text="PDF max pages" tip="A scanned PDF (no text layer) is sent as one image per page, up to this many pages. A PDF with more pages than this is sent as extracted text only." ex="At 20, a 35-page scan sends pages 1-20 as images; the agent is told where the file is on disk." /><input type="number" min={1} max={100} value={s.pdfMaxPages} onChange={(e) => set('pdfMaxPages', Number(e.target.value))} /></label>
              <label><Lbl text="Send PDF as file up to (MB)" tip="PDFs up to this size are sent to Claude models as the PDF itself, so the model also sees layout, charts and tables. Larger PDFs, and all other models, get the extracted text. 0 = always text only." ex="At 8, a 3 MB report with charts is read by Claude page by page; a 40 MB one is sent as text." /><input type="number" min={0} max={30} value={s.pdfNativeMaxMB} onChange={(e) => set('pdfNativeMaxMB', Number(e.target.value))} /></label>
            </div>
            <div className="sub-h">AI usage (⌘⇧U)</div>
            <div className="row3">
              <label><Lbl text="Daily budget (USD, 0 = off)" tip="Your own spending target. It only fills the usage ring in the sidebar against today's estimated cost; nothing is blocked." ex="At 25, spending $10 today shows the ring 40% full." /><input type="number" min={0} step={5} value={s.dailyBudget} onChange={(e) => set('dailyBudget', Number(e.target.value))} /></label>
              <label><Lbl text="pricing.json" tip="Path to a file with per-model token prices used to estimate cost in the usage view. Leave blank to use the default location." ex="~/prices/pricing.json with an entry for claude-sonnet-5 at $3 / $15 per million input / output tokens." /><input value={s.pricingPath} placeholder={`auto: ~/${BRAND.homeDir}/pricing.json`} onChange={(e) => set('pricingPath', e.target.value)} /></label>
            </div>
            <div className="row3">
              <label><Lbl text="Max concurrent model calls" tip="How many model requests may run at the same time across the main agent and its sub-agents. Lower it if your provider rate-limits you." ex="At 20, a task that fans out to 30 sub-agents runs 20 at once and queues the other 10." /><input type="number" min={1} max={64} value={s.maxConcurrency} onChange={(e) => set('maxConcurrency', Number(e.target.value))} /></label>
              <label><Lbl text="Max turns (main)" tip="Safety stop: the most model calls (each followed by its tool calls) the main agent may make for one prompt before it stops and reports." ex="At 500, a runaway loop that keeps retrying a failing command stops after 500 steps." /><input type="number" min={1} value={s.maxTurnsMain} onChange={(e) => set('maxTurnsMain', Number(e.target.value))} /></label>
              <label><Lbl text="Max turns (sub-agent)" tip="The same safety stop for each sub-agent the main agent delegates to." ex="At 500, a research sub-agent stops after 500 steps and returns what it has." /><input type="number" min={1} value={s.maxTurnsSub} onChange={(e) => set('maxTurnsSub', Number(e.target.value))} /></label>
            </div>
            <div className="sub-h">Limits</div>
            <div className="row3">
              <label><Lbl text="Max output tokens (0 = model max)" tip="Longest reply the model may write in one call, including a file it writes in a tool call. 0 uses each model's maximum; if a provider accepts less, the app retries with what it allows." ex="0 lets Claude 5 write up to ~128k tokens. Setting 8000 would cut off writing a large file, and the model would be told to write it in parts." /><input type="number" min={0} step={1000} value={s.maxOutputTokens} onChange={(e) => set('maxOutputTokens', Math.max(0, Number(e.target.value)))} /></label>
              <label><Lbl text="Shell output kept (chars)" tip="When a shell command prints more than this, only the last part is shown to the model. Larger values let it see more, at the cost of context." ex="At 30000, a build that prints 200k characters of logs shows the model the final 30k, where errors usually are." /><input type="number" min={1000} step={10000} value={s.shellOutputChars} onChange={(e) => set('shellOutputChars', Number(e.target.value))} /></label>
              <label><Lbl text="Shell timeout max (s)" tip="The longest a regular shell command may run before it is stopped. Longer jobs can run in async (background) mode." ex="At 600, a 15-minute test suite run normally is stopped after 10 minutes; run in async mode it continues." /><input type="number" min={10} step={60} value={s.shellTimeoutMaxSec} onChange={(e) => set('shellTimeoutMaxSec', Number(e.target.value))} /></label>
            </div>
            <div className="row3">
              <label><Lbl text="read_file per call (chars)" tip="Not a file size limit. Each read_file call returns at most this much; a longer file is returned in parts and the model is told which line to continue from." ex="At 50000, a 200k-character log is read in about 4 calls." /><input type="number" min={1000} step={10000} value={s.readFileChars} onChange={(e) => set('readFileChars', Number(e.target.value))} /></label>
              <label><Lbl text="web_fetch per call (chars)" tip="Not a page size limit. Each web_fetch call returns at most this much text; the model pages through longer content with start_index." ex="At 20000, a 70k-character article takes 4 fetches." /><input type="number" min={1000} step={10000} value={s.webFetchMaxChars} onChange={(e) => set('webFetchMaxChars', Number(e.target.value))} /></label>
              <label><Lbl text="Memory file max (chars)" tip="Each memory file and your notes are clipped to this length in the system prompt. Applies to new or restarted chats." ex="At 60000, a 90k-character memory file contributes only its first 60k characters." /><input type="number" min={1000} step={10000} value={s.memoryCapChars} onChange={(e) => set('memoryCapChars', Number(e.target.value))} /></label>
            </div>
            <div className="row3">
              <label><Lbl text="Skill/agent description (chars)" tip="Skill and agent descriptions listed in the system prompt are clipped to this so the list stays compact. The full skill is still loaded when used. Applies to new or restarted chats." ex="At 250, a 600-character description is shortened, so put the key trigger words first." /><input type="number" min={50} step={50} value={s.descriptionChars} onChange={(e) => set('descriptionChars', Number(e.target.value))} /></label>
              <label><Lbl text="MCP tool output (chars)" tip="Longest result an MCP server tool can return to the model; longer results are clipped with a note so the model can ask for less." ex="At 50000, a 200 KB JSON reply is cut to the first 50,000 characters." /><input type="number" min={1000} step={1000} value={s.mcpOutputChars} onChange={(e) => set('mcpOutputChars', Number(e.target.value))} /></label>
            </div>
          </div>
        )}
        {tab === 'office' && <OfficeTab s={s} setS={setS} />}
        {tab === 'compaction' && (
          <div className="form">
            <div className="muted small">Compaction folds older turns into a summary so long chats stay fast and cheap. It rewrites the start of the conversation, so the provider's prompt cache (Claude: ~5 min) is rebuilt once on the next call. It pays off when you keep using the chat, so the defaults wait until the cache has gone cold anyway, unless the chat is very large.</div>
            <label><Lbl text="Compaction model (summaries and topic grouping)" tip="The model that writes the summary when older turns are compacted, and groups turns by topic in the compact dialog." ex="Pick a fast model like Haiku or Flash: summaries come back quicker and cheaper than with the chat's large model." />
              <select value={s.compactModel} onChange={(e) => set('compactModel', e.target.value)}>
                <option value="">Same as the chat's model</option>
                {!compactKnown && <option value={s.compactModel}>{s.compactModel} (not listed)</option>}
                {groups.map((g) => (
                  <optgroup key={g.provider} label={g.name}>{g.models.map((m) => <option key={m} value={m}>{bareModel(m)}</option>)}</optgroup>
                ))}
              </select>
              <span className="muted small">A fast, cheaper model is usually enough to summarize. If it fails, the chat's model is used instead.</span>
            </label>
            <div className="row3">
              <label><Lbl text="Long chats" tip="What to do when a chat grows past the threshold: nothing, show a suggestion to compact, or compact automatically using the rules below." ex="Suggest: at 85k tokens a banner offers Compact. Auto: it compacts by itself once the rules are met." />
                <select value={s.autoCompact} onChange={(e) => set('autoCompact', e.target.value)}>
                  <option value="off">Do nothing</option>
                  <option value="suggest">Suggest compacting</option>
                  <option value="auto">Auto-compact (cache-aware)</option>
                </select>
              </label>
              <label><Lbl text="Threshold (tokens)" tip="Chats larger than this become candidates for compaction." ex="At 80000, a chat at ~80k tokens gets a compact suggestion (or auto-compacts, if enabled)." /><input type="number" min={5000} step={5000} value={s.compactThreshold} onChange={(e) => set('compactThreshold', Number(e.target.value))} /></label>
              <label><Lbl text="Keep last N turns verbatim" tip="The most recent N turns are never summarized, so the model keeps exact details of what you were just doing." ex="At 2, your last two prompts and replies stay word-for-word; everything older becomes a summary." /><input type="number" min={0} max={20} value={s.compactKeepRecent} onChange={(e) => set('compactKeepRecent', Number(e.target.value))} /></label>
            </div>
            <label><Lbl text="Recall hints" tip="Every turn is kept in a searchable index, even after compaction removes it from the chat, and the agent can search it with its recall tool. With hints on, each new prompt is also matched against earlier turns of chats in the same folder and up to four short pointers are attached after the prompt. Nothing is attached when no earlier turn matches well." ex="You ask 'what retry limit did we pick?' 60 turns later: a hint points to the turn where it was decided, and the agent reads it with recall." />
              <select value={s.recallHints ? 'on' : 'off'} onChange={(e) => set('recallHints', e.target.value === 'on')}>
                <option value="on">On — attach pointers to matching earlier turns</option>
                <option value="off">Off — the agent searches only when it decides to</option>
              </select>
            </label>
            <div className="sub-h">Auto-compact rules (when Long chats = Auto)</div>
            <div className="row3">
              <label><Lbl text="Wait until idle (minutes)" tip="Auto-compact only after the chat has had no model call for this long, so the provider's prompt cache has already expired and isn't wasted. 0 = compact immediately." ex="At 5, a chat you are actively using isn't compacted until you pause for 5 minutes." /><input type="number" min={0} max={240} value={s.compactIdleMinutes} onChange={(e) => set('compactIdleMinutes', Number(e.target.value))} /></label>
              <label><Lbl text="Compact anyway above (tokens)" tip="Above this size, compact even if the chat is active and the cache is warm, because the chat is getting slow and expensive. 0 = always wait for idle." ex="At 120000, a 130k-token chat compacts right away instead of waiting." /><input type="number" min={0} step={10000} value={s.compactHardLimit} onChange={(e) => set('compactHardLimit', Number(e.target.value))} /></label>
              <label><Lbl text="Minimum saving (tokens)" tip="Skip compaction if the turns that would be summarized are smaller than this. Small compactions cost more in cache rebuilding than they save." ex="At 20000, if only 8k tokens of older turns could be summarized, nothing happens." /><input type="number" min={0} step={5000} value={s.compactMinGain} onChange={(e) => set('compactMinGain', Number(e.target.value))} /></label>
            </div>
            <div className="muted small">Rule: compact when the chat is over the threshold <b>and</b> at least the minimum saving would be summarized <b>and</b> (it has been idle for the wait time <b>or</b> it is over the hard limit).</div>
          </div>
        )}
        {tab === 'skills' && (
          <SkillsTab cwd={cwd} folders={folders} />
        )}
        {tab === 'mcp' && <McpTab s={s} setS={setS} />}
        {tab === 'sync' && <SyncTab />}
        {tab === 'about' && <AboutTab onClose={onClose} />}
        {tab !== 'skills' && tab !== 'sync' && tab !== 'about' && (
          <div className="row-actions modal-foot">
            {tab === 'providers' && <><button onClick={testAll}>Test connection</button><span className="muted small">{health}</span></>}
            <div className="spacer" />
            <button onClick={onClose} title="Close without saving changes on this tab">Close</button>
            <button className="primary" onClick={async () => { await window.desk.saveSettings(s); onClose() }}>Save</button>
          </div>
        )}
        {(tab === 'skills' || tab === 'sync') && (
          <div className="row-actions modal-foot">
            <div className="spacer" />
            <button onClick={onClose}>Close</button>
          </div>
        )}
    </Dialog>
  )
}

type OfficeKey = 'excel' | OfficeApp
const OFFICE_KEYS: OfficeKey[] = ['excel', 'word', 'powerpoint']
const OFFICE_LABEL: Record<OfficeKey, string> = { excel: 'Excel', ...OFFICE_NAME }
const OFFICE_UNIT: Record<OfficeKey, string> = { excel: 'workbook', word: 'document', powerpoint: 'presentation' }

/** Excel, Word and PowerPoint in one place: one switch, one connection check, one set of rules. */
function OfficeTab({ s, setS }: { s: Settings; setS(s: Settings): void }) {
  const [xl, setXl] = useState<ExcelStatus | null>(null)
  const [st, setSt] = useState<OfficeStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const load = async (probe: boolean) => {
    const [x, o] = await Promise.all([window.desk.excel.status(probe).catch(() => null), window.desk.office.status(probe).catch(() => null)])
    setXl(x); setSt(o)
  }
  useEffect(() => { void load(false) }, [])
  const check = async () => { setBusy(true); try { await load(true) } finally { setBusy(false) } }
  const view = (k: OfficeKey) => (k === 'excel' ? xl && { ...xl, count: xl.workbooks.length } : st?.[k] && { ...st[k], count: st[k].docs.length }) || null
  const on = (k: OfficeKey) => (k === 'excel' ? s.excelEnabled : s.officeEnabled)
  const line = (k: OfficeKey): [string, string] => {
    const a = view(k), name = OFFICE_LABEL[k], unit = OFFICE_UNIT[k]
    return !on(k) ? ['', `${name} is turned off.`]
      : !a ? ['', `${name}: checking…`]
      : !a.installed ? ['', `${name} is not installed on this Mac.${k === 'excel' ? ' .xlsx files can still be read and edited on disk.' : ''}`]
      : !a.running ? ['', `${name} is installed but not running. Open a ${unit} to work on it live.`]
      : a.permission === 'granted' ? ['ok', `Connected to ${name} · ${a.count ? `${a.count} ${unit}${a.count === 1 ? '' : 's'} open` : `no ${unit} open`}`]
      : a.permission === 'needed' ? ['warn', `macOS has not allowed ${BRAND.title} to control ${name}. Turn it on in System Settings → Privacy & Security → Automation, then check again.`]
      : a.error ? ['warn', a.error]
      : ['', `${name} is running but not connected yet.`]
  }
  const live = OFFICE_KEYS.filter((k) => on(k) && view(k)?.running)
  const waiting = live.filter((k) => view(k)?.permission !== 'granted')
  const apps = s.excelEnabled && s.officeEnabled ? 'all' : s.excelEnabled ? 'excel' : s.officeEnabled ? 'office' : 'off'
  const confirm = s.excelConfirm === 'ask' || s.officeConfirm === 'ask' ? 'ask' : 'never'
  return (
    <div className="form">
      <p className="muted small">Lets the agent read and edit Excel workbooks, Word documents and PowerPoint presentations without an add-in. A file open in its app is edited in place while you watch, and nothing is saved until you save it. Attach an open file with the 📎 button in the chat box, or give the agent a file path.</p>
      <label><Lbl text="Work with Microsoft Office" tip="Which Office apps the agent may read and edit through their own scripting, without an add-in." ex="Excel only: the agent can update a workbook you have open, but can't touch Word or PowerPoint files." />
        <select value={apps} onChange={(e) => setS({ ...s, excelEnabled: e.target.value === 'all' || e.target.value === 'excel', officeEnabled: e.target.value === 'all' || e.target.value === 'office' })}>
          <option value="all">On — Excel, Word and PowerPoint</option>
          <option value="excel">Excel only</option>
          <option value="office">Word and PowerPoint only</option>
          <option value="off">Off</option>
        </select>
      </label>
      <div className="sub-h">Connection</div>
      {OFFICE_KEYS.map((k) => { const [tone, text] = line(k); return (
        <div key={k} className="xl-status" role="status"><span className={`dot ${tone}`} /><span>{text}</span></div>
      ) })}
      <div className="xl-status">
        <button onClick={() => void check()} disabled={busy || !live.length}>{busy ? 'Checking…' : waiting.length ? 'Connect to Office' : 'Check again'}</button>
        {!!waiting.length && !busy && <span className="muted small">Connects to {waiting.map((k) => OFFICE_LABEL[k]).join(', ')} in one go. macOS asks once for each app the first time.</span>}
      </div>
      <label><Lbl text="Before changing a file" tip="Whether to preview an Office edit and ask for approval before applying it. Applies to Interactive chats; Autopilot chats apply edits without asking." ex="Ask first: before filling column D with formulas, you see the planned change and click Allow." />
        <select value={confirm} onChange={(e) => { const v = e.target.value as Settings['excelConfirm']; setS({ ...s, excelConfirm: v, officeConfirm: v }) }}>
          <option value="ask">Show the change and ask first (Interactive chats; Autopilot applies without asking)</option>
          <option value="never">Apply without asking</option>
        </select>
      </label>
      <label><Lbl text="Back up a file before the first edit" tip="Before the agent first edits a file, a copy of its last saved version is saved next to it." ex="Editing Budget.xlsx first creates Budget.backup.xlsx in the same folder." />
        <select value={s.excelBackup || s.officeBackup ? 'on' : 'off'} onChange={(e) => { const v = e.target.value === 'on'; setS({ ...s, excelBackup: v, officeBackup: v }) }}>
          <option value="on">On — saves name.backup.xlsx / .docx / .pptx next to the file</option>
          <option value="off">Off</option>
        </select>
      </label>
      <label><Lbl text="Word: make edits as tracked changes" tip="In Word, the agent's edits appear as tracked suggestions you can accept or reject, instead of direct changes." ex="On: asking it to tighten a paragraph shows deletions and insertions in Review › Track Changes." />
        <select value={s.officeTrack ? 'on' : 'off'} onChange={(e) => setS({ ...s, officeTrack: e.target.value === 'on' })}>
          <option value="off">Off — edits are made directly; undo with ⌘Z</option>
          <option value="on">On — edits appear as suggestions you accept or reject in Word</option>
        </select>
      </label>
      <p className="muted small">Reading never asks. The backup is a copy of the last saved version. A closed .xlsx file is edited on disk; a closed Word or PowerPoint file is opened in its app. Tracked changes apply to Word only. In Word and PowerPoint, pictures, charts, headers and footers, and reordering slides are not supported.</p>
    </div>
  )
}

function AboutTab({ onClose }: { onClose(): void }) {
  const [a, setA] = useState<AppInfo | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => { void window.desk.appInfo().then(setA) }, [])
  if (!a) return null
  const built = a.builtAt ? new Date(a.builtAt).toLocaleString() : ''
  const rows: Array<[string, string]> = [
    ['Build', [a.commit, built].filter(Boolean).join(' · ') || 'development'],
    ['Electron', a.electron], ['Chromium', a.chrome], ['Node.js', a.node], ['System', `${a.os} (${a.arch})`], ['Data folder', a.dataHome]
  ]
  const text = `${a.name} ${a.version}\n` + rows.map(([k, v]) => `${k}: ${v}`).join('\n')
  return (
    <div className="about">
      <div className="about-head">
        {BRAND.logo && <img src={BRAND.logo} alt="" />}
        <div><div className="about-name">{a.name}</div><div className="about-ver">Version {a.version}</div></div>
      </div>
      <table className="about-table"><tbody>
        {rows.map(([k, v]) => <tr key={k}><th>{k}</th><td><code>{v}</code></td></tr>)}
      </tbody></table>
      <UpdatesPanel />
      <div className="row-actions modal-foot">
        <button onClick={() => { void navigator.clipboard.writeText(text); setCopied(true) }}>{copied ? '✓ Copied' : 'Copy version info'}</button>
        {BRAND.releasesUrl && <a href={BRAND.releasesUrl} target="_blank" rel="noreferrer">All releases ↗</a>}
        <div className="spacer" />
        <button onClick={onClose}>Close</button>
      </div>
    </div>
  )
}

const PERSONAL = ''
const baseName = (p: string) => p.split('/').filter(Boolean).pop() ?? p

/** Skills and agents per working folder: each folder's own .github items, plus the personal ~/.copilot items every folder shares. */
function SkillsTab({ cwd, folders }: { cwd: string; folders: string[] }) {
  const list = folders.includes(cwd) || !cwd ? folders : [cwd, ...folders]
  const [sel, setSel] = useState<string>(cwd || list[0] || PERSONAL)
  const [regs, setRegs] = useState<Record<string, RegistryInfo>>({})
  useEffect(() => {
    for (const k of [PERSONAL, ...list]) void window.desk.registryInfo(k || undefined).then((r) => setRegs((m) => ({ ...m, [k]: r })))
  }, [list.join('\n')])
  const personal = regs[PERSONAL]
  const own = (k: string) => {
    const r = regs[k]
    if (!r) return null
    if (k === PERSONAL) return r
    const p = (x: { source: string }) => x.source === 'project'
    return { skills: r.skills.filter(p), agents: r.agents.filter(p), warnings: r.warnings.filter((w) => w.startsWith(k + '/')) }
  }
  const count = (k: string) => { const r = own(k); return r ? `${r.skills.length} · ${r.agents.length}` : '…' }
  const cur = own(sel)
  const items = (xs: RegistryInfo['skills']) => xs.map((a) => (
    <li key={a.name}><b>{a.name}</b><div className="muted">{a.description.slice(0, 160)}</div></li>
  ))
  return (
    <div className="reg-split">
      <div className="reg-folders">
        {list.map((f) => (
          <button key={f} className={sel === f ? 'on' : ''} onClick={() => setSel(f)} title={f}>
            <span>📂 {baseName(f)}</span><span className="muted small">{count(f)}</span>
          </button>
        ))}
        <button className={sel === PERSONAL ? 'on' : ''} onClick={() => setSel(PERSONAL)} title="~/.copilot">
          <span>👤 Personal</span><span className="muted small">{count(PERSONAL)}</span>
        </button>
        <div className="muted small reg-legend">skills · agents</div>
      </div>
      <div className="reg">
        {sel === PERSONAL
          ? <div className="muted">From <code>~/.copilot</code>. Loaded in every folder; a folder's own skill or agent with the same name wins.</div>
          : <div className="muted">From <code>{sel}/.github</code>. Chats in this folder also load the {personal ? `${personal.skills.length} skills and ${personal.agents.length} agents` : 'items'} under <b>Personal</b>.</div>}
        {!cur ? <div className="muted">Loading…</div> : <>
          <h4>Agents ({cur.agents.length})</h4>
          {cur.agents.length ? <ul>{items(cur.agents)}</ul> : <div className="muted small">None</div>}
          <h4>Skills ({cur.skills.length})</h4>
          {cur.skills.length ? <ul>{items(cur.skills)}</ul> : <div className="muted small">None</div>}
          {cur.warnings.length ? <><h4>Warnings</h4><ul>{cur.warnings.map((w) => <li key={w} className="muted">{w}</li>)}</ul></> : null}
        </>}
      </div>
    </div>
  )
}
