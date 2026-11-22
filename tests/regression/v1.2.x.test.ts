// Regression cases for the 1.2.x line not pinned down elsewhere.
import { describe, it, expect } from 'vitest'
import { isAzureClaude } from '../../src/engine/adapter/openai'
import { isTtsId, parseVertexModels } from '../../src/shared/providers'
import { launchOffer, type ReleaseInfo } from '../../src/shared/updates'

describe('1.2.10 — Claude on Azure AI Foundry', () => {
  it('routes only Claude deployments to the Anthropic API', () => {
    for (const d of ['claude-sonnet-5', 'my-claude-opus', 'team_claude', 'prod/claude-haiku']) expect(isAzureClaude(d)).toBe(true)
    for (const d of ['gpt-6', 'o4-mini', 'notclaude']) expect(isAzureClaude(d)).toBe(false)
  })
})

describe('1.2.8 — text-to-speech models', () => {
  it('recognizes -tts ids and keeps chat models as chat models', () => {
    expect(isTtsId('google/gemini-3.8-flash-tts')).toBe(true)
    expect(isTtsId('google/gemini-3.1-flash-tts-preview')).toBe(true)
    expect(isTtsId('google/gemini-3.8-flash')).toBe(false)
    expect(parseVertexModels(['google/gemini-3.8-flash']).every((m) => !m.tts)).toBe(true)
  })
})

describe('1.2.9 — check for updates', () => {
  const rel = (version: string): ReleaseInfo => ({ version, tag: `v${version}`, name: version, notes: '', date: '', url: '' })
  it('offers nothing when already up to date', () => {
    expect(launchOffer([], '')).toBeUndefined()
    expect(launchOffer([rel('2.0.0'), rel('1.9.0')], '')?.version).toBe('2.0.0')
  })
})
