import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store, type SessionRow } from '../src/main/store'
import { buildTree, canNest, shownParent } from '../src/shared/fork'

const row = (id: string, updated_at: number, extra: Partial<SessionRow> = {}): SessionRow =>
  ({ id, title: id, cwd: '/w', model: 'm', created_at: 1, updated_at, parent_id: null, fork_turn: null, ...extra })

let store: Store
const shape = (cwd = '/w') => { const f = (n: any): any => (n.children.length ? { [n.row.id]: n.children.map(f) } : n.row.id); return buildTree(store.listSessions().filter((s) => s.cwd === cwd)).map(f) }

beforeEach(() => {
  store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'move-')))
  store.createSession(row('a', 400)); store.createSession(row('b', 300)); store.createSession(row('c', 200))
  store.createSession(row('f', 100, { parent_id: 'c', fork_turn: 2 }))
  store.createSession(row('x', 500, { cwd: '/other' }))
})

describe('moving a chat under another chat', () => {
  it('files imported chats under one parent, with their own children', () => {
    expect(store.placeSession('b', 'a')).toBe(true)
    expect(store.placeSession('c', 'a')).toBe(true)
    expect(shape()).toEqual([{ a: ['b', { c: ['f'] }] }])
    expect(store.getSession('b')).toMatchObject({ parent_id: 'a', fork_turn: null })
  })
  it('refuses a chat from another folder, itself, and its own children', () => {
    expect(store.placeSession('b', 'x')).toBe(false)
    expect(store.placeSession('c', 'c')).toBe(false)
    expect(store.placeSession('c', 'f')).toBe(false)
    expect(store.placeSession('nope', 'a')).toBe(false)
    expect(shape()).toEqual(['a', 'b', { c: ['f'] }])
  })
  it('moves a child back to the top level and beside a given chat', () => {
    store.placeSession('f', null, 'b', true)
    expect(shape()).toEqual(['a', 'f', 'b', 'c'])
    expect(store.getSession('f')).toMatchObject({ parent_id: null, fork_turn: null })
    store.placeSession('a', 'c'); store.placeSession('b', 'c', 'a', false)
    expect(shape()).toEqual(['f', { c: ['a', 'b'] }])
  })
  it('keeps the fork turn when a fork is only reordered under its parent', () => {
    store.createSession(row('g', 50, { parent_id: 'c', fork_turn: 0 }))
    store.placeSession('f', 'c', 'g', false)
    expect(store.getSession('f')).toMatchObject({ parent_id: 'c', fork_turn: 2 })
    expect(shape()).toEqual(['a', 'b', { c: ['g', 'f'] }])
  })
  it('treats a parent in another folder as top level', () => {
    const rows = [row('p', 1, { cwd: '/other' }), row('k', 2, { parent_id: 'p' }), row('m', 3)]
    expect(shownParent(rows, 'k')).toBeNull()
    expect(canNest(rows, 'm', 'k')).toBe(true)
    expect(canNest(rows, 'k', 'p')).toBe(false)
  })
})
