import { describe, expect, it } from 'vitest'
import { currentTurn, jumpTarget, turnSummaries } from '../src/renderer/src/turns'
import type { Item } from '../src/renderer/src/state'

describe('turn navigation', () => {
  it('summarises each prompt with the first line of the main reply', () => {
    const items: Item[] = [
      { t: 'user', text: 'First  question\nwith detail' },
      { t: 'assistant', agentId: 'sub1', text: 'sub-agent chatter', reasoning: '' },
      { t: 'assistant', agentId: 'main', text: '\n## Answer one\nmore', reasoning: '' },
      { t: 'answer', text: 'yes' },
      { t: 'user', text: '', attachments: [{ name: 'a.png', kind: 'image', info: '1 KB' }] },
    ]
    expect(turnSummaries(items)).toEqual([
      { prompt: 'First question with detail', reply: 'Answer one' },
      { prompt: 'a.png', reply: '' },
    ])
  })

  it('tracks the turn being read, and the last one at the bottom', () => {
    const tops = [0, 500, 1200, 1900]
    expect(currentTurn(tops, 0)).toBe(0)
    expect(currentTurn(tops, 800)).toBe(1)
    expect(currentTurn(tops, 1500, { height: 600, scrollHeight: 2100 })).toBe(3)
  })

  it('jumps up to the current prompt before the previous one, and down to the next', () => {
    const tops = [0, 500, 1200]
    expect(jumpTarget(tops, 800, -1)).toBe(1)
    expect(jumpTarget(tops, 500, -1)).toBe(0)
    expect(jumpTarget(tops, 0, -1)).toBeNull()
    expect(jumpTarget(tops, 500, 1)).toBe(2)
    expect(jumpTarget(tops, 1200, 1)).toBeNull()
  })
})
