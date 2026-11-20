import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Semaphore } from '../src/engine/semaphore'
import { Session } from '../src/engine/engine'
import type { ChatRequest, Delta, ModelAdapter } from '../src/engine/types'

const tick = () => new Promise((r) => setTimeout(r, 5))

describe('Semaphore.setMax', () => {
  it('starts queued callers when the limit is raised', async () => {
    const sem = new Semaphore(1)
    await sem.acquire()
    let started = 0
    const waiting = [sem.acquire().then(() => started++), sem.acquire().then(() => started++)]
    await tick(); expect(started).toBe(0)
    sem.setMax(3)
    await Promise.all(waiting); expect(started).toBe(2)
  })

  it('lets running callers finish when lowered, then holds to the new limit', async () => {
    const sem = new Semaphore(2)
    const r1 = await sem.acquire(); const r2 = await sem.acquire()
    sem.setMax(1)
    let got = false
    const p = sem.acquire().then((r) => { got = true; return r })
    r1(); await tick(); expect(got).toBe(false)
    r2(); await p; expect(got).toBe(true)
  })
})

describe('Session.setLimits', () => {
  it('raises max turns for a run already in progress', async () => {
    let calls = 0
    let s!: Session
    const adapter: ModelAdapter = {
      async *stream(_req: ChatRequest) {
        calls++
        if (calls === 2) s.setLimits({ maxTurnsMain: 10 })
        const ds: Delta[] = calls < 5
          ? [{ type: 'tool_call', index: 0, id: `c${calls}`, name: 'list_agents', args: '{}' }, { type: 'finish', reason: 'tool_calls' }]
          : [{ type: 'text', text: 'done' }, { type: 'finish', reason: 'stop' }]
        for (const d of ds) yield d
      }
    }
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lim-'))
    s = new Session({ adapter, cwd, model: 'm', home: path.join(cwd, 'nohome'), autoApprove: true, maxTurnsMain: 3,
      hooks: { onEvent: () => {}, requestPermission: async () => 'allow', askUser: async () => 'yes' } })
    expect(await s.send('go')).toEqual({ status: 'completed', text: 'done' })
  })
})
