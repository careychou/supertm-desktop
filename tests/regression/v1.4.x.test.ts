// Regression cases for the 1.4.x line that no unit test elsewhere pins down.
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (v: string) => Buffer.from(v), decryptString: (b: Buffer) => b.toString() }
}))

import { chainProblem, readBundle, trustedChain } from '../../src/main/mcp/trust'
import { DEFAULT_TOOL_LIMITS, modelMaxOutput, outputCap, resetLearnedCaps, setToolLimits, toolLimits } from '../../src/engine/limits'
import { loadSettings, saveSettings, setSettingsDir } from '../../src/main/settings'
import { skillFiles } from '../../src/main/skill-export'
import { RESERVED_PREFIXES, skillDraftPrompt, skillNameError } from '../../src/shared/skill-export'
import type { ExportItem } from '../../src/shared/export'
import { Store } from '../../src/main/store'
import { applyCompaction } from '../../src/engine/compact'
import { formatHints, pickHints } from '../../src/engine/recall'
import type { Message } from '../../src/engine/types'

const certs = path.join(__dirname, '..', 'fixtures', 'certs')
const ca = readBundle(path.join(certs, 'ca.pem'))
const leaf = readBundle(path.join(certs, 'leaf.pem'))
const other = readBundle(path.join(certs, 'other-ca.pem'))
const HOST = 'mcp.example.test'
const NOW = new Date('2030-01-01T00:00:00Z')

describe('1.4.2 — MCP extra trusted certificates', () => {
  it('trusts a chain that reaches a pinned certificate for the right host', () => {
    expect(ca).toHaveLength(1)
    expect(chainProblem([...leaf, ...ca], ca, HOST, NOW)).toBe('')
    expect(trustedChain([...leaf, ...ca], ca, HOST, NOW)).toBe(true)
  })
  it('explains why a chain is not trusted', () => {
    expect(chainProblem([], ca, HOST, NOW)).toMatch(/no certificate/)
    expect(chainProblem([...leaf, ...ca], [], HOST, NOW)).toMatch(/no extra trusted certificates/)
    expect(chainProblem([...leaf, ...ca], other, HOST, NOW)).toMatch(/doesn't include any certificate/)
    expect(chainProblem([...leaf, ...ca], ca, 'evil.example.test', NOW)).toMatch(/not evil\.example\.test/)
    expect(chainProblem([...leaf, ...ca], ca, HOST, new Date('2200-01-01'))).toMatch(/valid only/)
    expect(chainProblem([...leaf, ...other], [...ca, ...other], HOST, NOW)).toMatch(/isn't signed by/)
  })
  it('skips a missing bundle instead of throwing', () => {
    expect(readBundle(path.join(certs, 'missing.pem'))).toEqual([])
  })
})

describe('1.4.2 — launch update check settings', () => {
  it('checks at launch by default and remembers a skipped version', () => {
    setSettingsDir(fs.mkdtempSync(path.join(os.tmpdir(), 'reg-settings-')))
    const s = loadSettings()
    expect(s.checkUpdatesOnLaunch).toBe(true)
    expect(s.skippedVersion).toBe('')
    expect(s.mcpEnabled).toBe(true)
    saveSettings({ ...s, skippedVersion: '9.9.9', checkUpdatesOnLaunch: false })
    expect(loadSettings()).toMatchObject({ skippedVersion: '9.9.9', checkUpdatesOnLaunch: false })
  })
})

describe('1.4.2 — skill instruction', () => {
  it('passes the user instruction to the drafting prompt only when given', () => {
    expect(skillDraftPrompt('my-skill', 'chat', [], 'Focus on the SQL steps')).toContain('Focus on the SQL steps')
    expect(skillDraftPrompt('my-skill', 'chat', [])).toBe(skillDraftPrompt('my-skill', 'chat', [], '   '))
  })
})

describe('1.4.1 — limits you can change', () => {
  it('falls back to the default for blank, zero, negative or non-numeric limits', () => {
    setToolLimits({ readFileChars: 123456, shellOutputChars: 0, webFetchMaxChars: -5, mcpOutputChars: NaN })
    expect(toolLimits.readFileChars).toBe(123456)
    expect(toolLimits.shellOutputChars).toBe(DEFAULT_TOOL_LIMITS.shellOutputChars)
    expect(toolLimits.webFetchMaxChars).toBe(DEFAULT_TOOL_LIMITS.webFetchMaxChars)
    expect(toolLimits.mcpOutputChars).toBe(DEFAULT_TOOL_LIMITS.mcpOutputChars)
    setToolLimits({})
    expect(toolLimits).toEqual(DEFAULT_TOOL_LIMITS)
  })
  it('defaults max output to the model maximum (0 = model max)', () => {
    setSettingsDir(fs.mkdtempSync(path.join(os.tmpdir(), 'reg-settings-')))
    const s = loadSettings()
    expect(s.maxOutputTokens).toBe(0)
    for (const k of Object.keys(DEFAULT_TOOL_LIMITS)) expect((s as any)[k]).toBe((DEFAULT_TOOL_LIMITS as any)[k])
    resetLearnedCaps()
    expect(outputCap('anthropic/claude-sonnet-5', s.maxOutputTokens)).toBe(modelMaxOutput('anthropic/claude-sonnet-5'))
    expect(outputCap('anthropic/claude-sonnet-5', 1000)).toBe(1000)
  })
})

describe('1.4.0 — export a chat as a skill', () => {
  it('keeps every reserved prefix reserved', () => {
    for (const p of RESERVED_PREFIXES) expect(skillNameError(`${p}y`)).toMatch(/reserved/)
  })
  it('offers scratch files but leaves them unticked; files in the folder are ticked', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-skill-'))
    fs.writeFileSync(path.join(cwd, 'load.py'), 'print(1)')
    const venv = path.join(cwd, '..', `reg-venv-${process.pid}`, '.venv', 'lib')
    fs.mkdirSync(venv, { recursive: true })
    fs.writeFileSync(path.join(venv, 'x.py'), 'x')
    const tool = (args: object): ExportItem => ({ t: 'tool', name: 'write_file', args: JSON.stringify(args), ok: true })
    const items: ExportItem[] = [{ t: 'user', text: 'go' }, tool({ path: 'load.py', content: 'x' }), tool({ path: path.join(venv, 'x.py'), content: 'x' })]
    const f = skillFiles(items, undefined, cwd)
    expect(f.map((x) => [path.basename(x.source!), x.suggested])).toEqual([['load.py', true], ['x.py', false]])
  })
})

describe('1.4.x — recall of earlier turns', () => {
  it('recall hints are on by default', () => {
    setSettingsDir(fs.mkdtempSync(path.join(os.tmpdir(), 'reg-settings-')))
    expect(loadSettings().recallHints).toBe(true)
  })
  it('a turn removed by compaction is still found, and the model is told it can search', () => {
    const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'reg-recall-')))
    store.createSession({ id: 'a', title: 'a', cwd: '/w', model: 'm', created_at: 1, updated_at: 1, parent_id: null, fork_turn: null })
    const hist: Message[] = [{ role: 'user', content: 'Choose the retry limit' }, { role: 'assistant', content: 'Retry limit is 7.' }, { role: 'user', content: 'Ship it' }, { role: 'assistant', content: 'Shipped.' }]
    store.saveMessages('a', hist); store.indexSession('a')
    const next = applyCompaction(hist, 'They chose a limit.', [1], 1)
    store.setTurnMap('a', [1]); store.saveMessages('a', next); store.indexSession('a')
    expect(next[0].content as string).toContain('recall')
    const hits = store.searchTurns('retry limit', 'session', 'a')
    expect(hits[0]).toMatchObject({ turn: 0, answer: 'Retry limit is 7.' })
    expect(formatHints(pickHints('what retry limit did we choose', hits.map((h) => ({ ...h, inContext: false }))))).toContain('removed by compaction')
    expect(formatHints(pickHints('write a haiku about retry', hits))).toBe('')
  })
})
