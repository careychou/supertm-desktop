import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// keychain stand-in: sealing is reversible base64 until access is "refused"
const keychain = vi.hoisted(() => ({ refused: false }))
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (v: string) => Buffer.from('sealed:' + v),
    decryptString: (b: Buffer) => {
      if (keychain.refused) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
      return b.toString().slice('sealed:'.length)
    }
  }
}))

import { loadSettings, saveSettings, setSettingsDir } from '../src/main/settings'

describe('settings secrets', () => {
  it('keeps a key it cannot decrypt instead of blanking it on the next save', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-'))
    setSettingsDir(dir)
    const s = loadSettings()
    saveSettings({ ...s, providers: [{ id: 'az', name: 'Azure', kind: 'azure', baseUrl: 'https://x', apiKey: 'secret-1', models: ['m'] } as any] })

    keychain.refused = true
    const locked = loadSettings()
    expect(locked.providers.map((p) => [p.id, p.apiKey])).toEqual([['az', '']])
    saveSettings({ ...locked, defaultModel: 'az::m' })

    keychain.refused = false
    const again = loadSettings()
    expect(again.defaultModel).toBe('az::m')
    expect(again.providers[0].apiKey).toBe('secret-1')
  })
})
