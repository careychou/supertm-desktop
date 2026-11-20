import { splitTurns, type ExportItem } from './export'

/** Name prefixes owned by app-managed skill packs; exported skills may not use them. */
export const RESERVED_PREFIXES: string[] = []

/** Lowercase-hyphen skill name (max 64 chars). */
export function skillName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/g, '')
}

/** Why a skill name can't be used, or '' if it's fine. */
export function skillNameError(name: string): string {
  if (!name) return 'Enter a skill name.'
  const r = RESERVED_PREFIXES.find((p) => name.startsWith(p))
  return r ? `Names starting with "${r}" are reserved for managed skills.` : ''
}

export type SkillFileKind = 'scripts' | 'assets'
/** A file for the pack: on disk (`path`) or captured inline from a shell heredoc (`content` + `name`). */
export interface SkillFileRef { path?: string; name?: string; content?: string; kind: SkillFileKind; origin: 'written' | 'ran' | 'inline' | 'added' }

const SCRIPT_EXT = /\.(py|js|mjs|cjs|ts|sh|bash|zsh|rb|r|sql|ps1|pl|jl|ipynb)$/i
const RUN = /(?:^|[\s;&|(])(?:python3?|node|tsx|ts-node|bash|sh|zsh|ruby|Rscript|deno run|bun|uv run|poetry run python)\s+(?:-[\w-]+\s+)*([^\s;&|'"<>-][^\s;&|'"<>]*)/g
// `python3 - <<'EOF'` … `EOF`: code the agent ran without saving it to a file
const HEREDOC_RUN = /(?:^|[\s;&|(])(python3?|node|bash|sh|zsh|ruby|Rscript)(?:\s+-[\w-]*)*\s*<<-?\s*(['"]?)(\w+)\2[^\n]*\n([\s\S]*?)\n\s*\3\s*(?:\n|$)/g
// `cat > path <<EOF` / `tee path <<EOF`: a file written from the shell
const HEREDOC_WRITE = /(?:cat\s*>>?|tee(?:\s+-a)?)\s*([^\s;&|<>'"]+)\s*<<-?\s*['"]?\w+/g
const EXT: Record<string, string> = { python: '.py', python3: '.py', node: '.js', bash: '.sh', sh: '.sh', zsh: '.sh', ruby: '.rb', Rscript: '.r' }
const MIN_INLINE = 3

export const kindOf = (p: string): SkillFileKind => (SCRIPT_EXT.test(p) ? 'scripts' : 'assets')
const args = (s: string): Record<string, unknown> => { try { return JSON.parse(s) as Record<string, unknown> } catch { return {} } }

// Tool names differ by origin: this app, imported Copilot chats, imported Claude Code chats.
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'create', 'edit', 'str_replace_editor', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const SHELL_TOOLS = new Set(['shell', 'bash', 'Bash', 'powershell'])
const CD = /(?:^|[;&|\n]\s*)cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g
const isAbs = (p: string) => p.startsWith('/') || p.startsWith('~')
const join = (dir: string, p: string) => (isAbs(p) || !dir ? p : `${dir.replace(/\/+$/, '')}/${p.replace(/^\.\//, '')}`)

/** Paths in a shell command are relative to its last `cd` before them (if any). */
function dirAt(cmd: string, at: number): string {
  let dir = ''
  for (const m of cmd.matchAll(CD)) { if (m.index! >= at) break; const d = m[1] ?? m[2] ?? m[3]; dir = isAbs(d) ? d : join(dir, d) }
  return dir
}

function walk(items: ExportItem[], out: Map<string, SkillFileRef>) {
  for (const it of items) {
    if (it.t === 'agent') { walk(it.children, out); continue }
    if (it.t !== 'tool' || it.ok === false) continue
    const a = args(it.args)
    const fp = typeof a.path === 'string' ? a.path : typeof a.file_path === 'string' ? a.file_path : typeof a.notebook_path === 'string' ? a.notebook_path : null
    if (WRITE_TOOLS.has(it.name) && fp) {
      if (it.name === 'str_replace_editor' && a.command === 'view') continue
      out.set(fp, { path: fp, kind: kindOf(fp), origin: 'written' })
    } else if (SHELL_TOOLS.has(it.name) && typeof a.command === 'string') {
      const cmd = a.command
      for (const m of cmd.matchAll(HEREDOC_WRITE)) { if (/[$`*]/.test(m[1])) continue; const p = join(dirAt(cmd, m.index!), m[1]); out.set(p, { path: p, kind: kindOf(p), origin: 'written' }) }
      for (const m of cmd.matchAll(RUN)) {
        if (!SCRIPT_EXT.test(m[1]) || /[$`*]/.test(m[1])) continue
        const p = join(dirAt(cmd, m.index!), m[1])
        if (!out.has(p)) out.set(p, { path: p, kind: 'scripts', origin: 'ran' })
      }
      for (const m of cmd.matchAll(HEREDOC_RUN)) {
        const body = m[4].replace(/\s+$/, '') + '\n'
        if (body.split('\n').filter((l) => l.trim()).length < MIN_INLINE) continue
        const key = `inline:${body}`
        if (!out.has(key)) out.set(key, { name: `inline-${[...out.values()].filter((f) => f.origin === 'inline').length + 1}${EXT[m[1]] ?? '.txt'}`, content: body, kind: 'scripts', origin: 'inline' })
      }
    }
  }
}

/** Files the selected turns wrote, edited or ran, plus inline heredoc scripts (paths as the agent used them). */
export function collectSkillFiles(items: ExportItem[], turns?: number[]): SkillFileRef[] {
  const all = splitTurns(items)
  const pick = turns ?? all.map((_, i) => i)
  const out = new Map<string, SkillFileRef>()
  for (const i of [...pick].sort((a, b) => a - b)) if (all[i]) walk(all[i], out)
  return [...out.values()]
}

/** Unique base names for files inside scripts/ or assets/ (a.py, a-2.py …). */
export function skillTargets(files: SkillFileRef[]): string[] {
  const used = new Set<string>()
  return files.map((f) => {
    const base = (f.name ?? f.path ?? '').split(/[\\/]/).pop() || 'file'
    const dot = base.lastIndexOf('.')
    const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, '']
    let name = base, n = 2
    while (used.has(`${f.kind}/${name}`)) name = `${stem}-${n++}${ext}`
    used.add(`${f.kind}/${name}`)
    return `${f.kind}/${name}`
  })
}

export interface SecretFinding { kind: string; sample: string }

const SECRET_RULES: Array<[string, RegExp]> = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g],
  ['GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ['Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ['Databricks token', /\bdapi[a-f0-9]{32}\b/g],
  ['API key', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['AWS key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['bearer token', /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g],
  ['password / secret', /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*['"]?(?!\$|\{|<|os\.|process\.|getenv)[^\s'"]{6,}/gi],
  ['email address', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g]
]

const mask = (s: string) => (s.length <= 8 ? '••••' : `${s.slice(0, 4)}…${s.slice(-2)}`)

/** Likely secrets or personal data in text (masked samples, one per distinct match). */
export function scanSecrets(text: string): SecretFinding[] {
  const out: SecretFinding[] = []
  const seen = new Set<string>()
  for (const [kind, re] of SECRET_RULES) {
    for (const m of text.matchAll(re)) {
      if (seen.has(m[0])) continue
      if (kind === 'email address' && /@(?:example\.(?:com|org)|users\.noreply\.github\.com)$/i.test(m[0])) continue
      seen.add(m[0]); out.push({ kind, sample: mask(m[0]) })
    }
  }
  return out
}

/** Prompt that turns a chat transcript into a reusable SKILL.md. */
export function skillDraftPrompt(name: string, transcript: string, files: string[]): string {
  return [
    `Turn the chat below into a reusable agent skill named "${name}". Write the complete SKILL.md and nothing else (no code fences around it).`,
    '',
    'Format:',
    '---',
    `name: ${name}`,
    'description: <one or two sentences: what the skill does and WHEN an agent should use it (trigger phrases, inputs). This is all the agent sees before loading the skill.>',
    '---',
    '# <Title>',
    'Sections: "When to use", "Inputs" (values the user must supply), "Requirements" (tools, packages and environment variables needed, if any), "Steps" (numbered, imperative, generalized), "Preferences & conventions" (the user\'s stated choices), "Pitfalls" (what failed and the fix), and "Files" if any.',
    '',
    'Rules:',
    '- Write instructions for doing the task again, not a recap of this chat. Generalize: replace one-off values (dates, ids, names, paths in the user\'s home) with named inputs.',
    '- Keep only what worked. Mention dead ends only as pitfalls.',
    '- Never include secrets, tokens, passwords or personal data. Refer to credentials by environment variable name.',
    files.length
      ? `- These files are bundled with the skill; reference them by these relative paths and say when to run/use each:\n${files.map((f) => `  - ${f}`).join('\n')}`
      : '- No files are bundled; put any essential short commands inline.',
    '- Be concise: aim for under 150 lines.',
    '',
    '<chat>',
    transcript,
    '</chat>'
  ].join('\n')
}

/** Strips a wrapping code fence and forces the frontmatter name to `name`. */
export function finalizeSkillMd(text: string, name: string): string {
  let s = text.trim().replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i, '$1').trim()
  if (!s.startsWith('---')) s = `---\nname: ${name}\ndescription: ${name}\n---\n\n${s}`
  const end = s.indexOf('\n---', 3)
  const head = end > 0 ? s.slice(0, end) : s
  const fixed = /^name:.*$/m.test(head) ? head.replace(/^name:.*$/m, `name: ${name}`) : `${head}\nname: ${name}`
  return (end > 0 ? fixed + s.slice(end) : fixed) + '\n'
}

/** Keeps the start and end of a long transcript within `max` chars. */
export function clipTranscript(s: string, max = 150_000): string {
  if (s.length <= max) return s
  const half = Math.floor(max / 2)
  return `${s.slice(0, half)}\n\n… (${s.length - max} chars omitted) …\n\n${s.slice(-half)}`
}
