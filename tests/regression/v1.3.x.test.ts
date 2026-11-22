// Regression cases for the 1.3.x line.
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (v: string) => Buffer.from(v), decryptString: (b: Buffer) => b.toString() }
}))

import { loadSettings, setSettingsDir } from '../../src/main/settings'

describe('1.3.0 — higher defaults', () => {
  it('starts with 20 parallel agents and 500 turns for main and sub-agents', () => {
    setSettingsDir(fs.mkdtempSync(path.join(os.tmpdir(), 'reg-settings-')))
    expect(loadSettings()).toMatchObject({ maxConcurrency: 20, maxTurnsMain: 500, maxTurnsSub: 500 })
  })
  it('keeps values the user saved over the new defaults', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-settings-'))
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ maxConcurrency: 4, maxTurnsMain: 50 }))
    setSettingsDir(dir)
    expect(loadSettings()).toMatchObject({ maxConcurrency: 4, maxTurnsMain: 50, maxTurnsSub: 500 })
  })
})
