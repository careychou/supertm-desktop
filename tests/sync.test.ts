import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store, type SessionRow } from '../src/main/store'
import { exportSessions, importSessions, resolveSyncFile, scanSessions } from '../src/main/sync'
import { ageDiff } from '../src/shared/sync'

const row = (id: string, updated_at: number, extra: Partial<SessionRow> = {}): SessionRow =>
  ({ id, title: id, cwd: '/w', model: 'm', created_at: 1, updated_at, parent_id: null, fork_turn: null, ...extra })

let tmp: string, laptop: Store, desktop: Store, file: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-'))
  laptop = new Store(path.join(tmp, 'laptop'))
  desktop = new Store(path.join(tmp, 'desktop'))
  laptop.createSession(row('a', 5_000_000))
  laptop.saveMessages('a', [{ role: 'user', content: 'from laptop' }])
  laptop.saveUiItems('a', [{ t: 'user', text: 'from laptop' }, { t: 'answer' }])
  laptop.createSession(row('b', 2_000))
  laptop.createSession(row('c', 3_000, { parent_id: 'b', fork_turn: 0 }))
  exportSessions(laptop, path.join(tmp, 'share'), 'Test')
  file = resolveSyncFile(path.join(tmp, 'share'))
})

describe('Sync sessions', () => {
  it('exports a standalone db and flags UUIDs that already exist locally', () => {
    desktop.createSession(row('a', 1_000_000, { title: 'desk a' }))
    const { manifest, sessions } = scanSessions(desktop, file)
    expect(manifest?.sessions).toBe(3)
    const a = sessions.find((s) => s.id === 'a')!
    expect(a.turns).toBe(1)
    expect(a.local).toEqual({ title: 'desk a', updated_at: 1_000_000 })
    expect(sessions.find((s) => s.id === 'b')!.local).toBeNull()
  })

  it('adds new sessions with their UUID, history and fork tree', () => {
    const r = importSessions(desktop, file, [{ id: 'b' }, { id: 'c' }])
    expect(r).toMatchObject({ added: 2, overwritten: 0, forked: 0, skipped: 0 })
    expect(desktop.getSession('c')!.parent_id).toBe('b')
    expect(desktop.getSession('c')!.updated_at).toBe(3_000)
  })

  it('files new chats, fork tree included, under the chosen folder and never adds the source folder', () => {
    desktop.addFolder('/here/aitm')
    desktop.createSession(row('a', 1_000_000, { cwd: '/mine' }))
    importSessions(desktop, file, [{ id: 'a', choice: 'fork' }, { id: 'b' }, { id: 'c' }], undefined, '/here/aitm')
    expect(desktop.getSession('b')!.cwd).toBe('/here/aitm')
    expect(desktop.getSession('c')).toMatchObject({ cwd: '/here/aitm', parent_id: 'b' })
    // a fork of a chat already here stays in that chat's folder
    expect(desktop.listSessions().find((s) => s.title === 'a · imported')!.cwd).toBe('/mine')
    expect(desktop.listFolders().map((f) => f.path)).not.toContain('/w')
  })

  it('files a fork at the top level when its parent is not imported', () => {
    importSessions(desktop, file, [{ id: 'c' }])
    expect(desktop.getSession('c')!.parent_id).toBeNull()
  })

  it('on a UUID conflict: skip by default, overwrite replaces, fork adds a new UUID under the local chat', () => {
    desktop.createSession(row('a', 1_000_000))
    desktop.saveMessages('a', [{ role: 'user', content: 'from desktop' }])
    expect(importSessions(desktop, file, [{ id: 'a' }]).skipped).toBe(1)
    expect(desktop.loadMessages('a')[0].content).toBe('from desktop')

    const f = importSessions(desktop, file, [{ id: 'a', choice: 'fork' }])
    expect(f.forked).toBe(1)
    const forkId = f.ids[0]
    expect(forkId).not.toBe('a')
    expect(desktop.getSession(forkId)).toMatchObject({ parent_id: 'a', title: 'a · imported', updated_at: 5_000_000 })
    expect(desktop.loadMessages(forkId)[0].content).toBe('from laptop')
    expect(desktop.loadMessages('a')[0].content).toBe('from desktop')

    expect(importSessions(desktop, file, [{ id: 'a', choice: 'overwrite' }]).overwritten).toBe(1)
    expect(desktop.loadMessages('a')[0].content).toBe('from laptop')
    expect(desktop.loadUiItems('a')).toHaveLength(2)
    expect(desktop.getSession(forkId)!.parent_id).toBe('a')
  })

  it('rejects a folder without an export', () => {
    expect(() => resolveSyncFile(tmp)).toThrow(/sessions\.db/)
  })
})

describe('ageDiff', () => {
  it('describes how much newer or older the import is', () => {
    expect(ageDiff(10_000, 0)).toBe('same time')
    expect(ageDiff(125 * 60_000, 0)).toBe('2 h 5 min newer')
    expect(ageDiff(0, 3 * 86_400_000)).toBe('3 days older')
  })

  it('brings folder memory along with imported chats unless the folder already has some', () => {
    laptop.setFolderMemory('/w', JSON.stringify({ files: [], notes: 'fiscal weeks start Sunday' }))
    laptop.setFolderMemory('/x', JSON.stringify({ files: [], notes: 'other' }))
    laptop.createSession(row('d', 4_000, { cwd: '/x' }))
    exportSessions(laptop, path.join(tmp, 'share2'), 'Test')
    const f2 = resolveSyncFile(path.join(tmp, 'share2'))
    desktop.setFolderMemory('/x', JSON.stringify({ files: [], notes: 'mine' }))
    importSessions(desktop, f2, [{ id: 'a' }, { id: 'd' }])
    expect(JSON.parse(desktop.getFolder('/w')!.memory!).notes).toBe('fiscal weeks start Sunday')
    expect(JSON.parse(desktop.getFolder('/x')!.memory!).notes).toBe('mine')
  })
})
