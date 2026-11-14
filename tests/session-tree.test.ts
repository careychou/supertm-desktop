import { describe, expect, it } from 'vitest'
import { buildTree } from '../src/renderer/src/components/SessionTree'

const row = (id: string, cwd: string, t: number, parent_id: string | null = null) => ({ id, title: id, cwd, updated_at: t, turns: 1, parent_id })

describe('buildTree', () => {
  it('nests folders by path, collapses empty chains, orders by latest, nests forks', () => {
    const t = buildTree([
      row('a', '/Users/x/projects/demo', 1), row('a2', '/Users/x/projects/demo', 5, 'a'),
      row('b', '/Users/x/projects/demo/sub', 3), row('c', '/Users/x/private/tax', 9)
    ])
    expect(t.name).toBe('~')
    expect(t.folders.map((f) => f.name)).toEqual(['private/tax', 'projects/demo'])
    const demo = t.folders[1]
    expect(demo.ids.sort()).toEqual(['a', 'a2', 'b'])
    expect(demo.latest).toBe(5)
    expect(demo.folders.map((f) => f.name)).toEqual(['sub'])
    expect(demo.sessions).toHaveLength(1)
    expect(demo.sessions[0].forks.map((n) => n.row.id)).toEqual(['a2'])
  })
  it('collapses a single shared prefix into one top folder', () => {
    const t = buildTree([row('a', '/Users/x/projects/demo', 1), row('b', '/Users/x/projects/demo', 2)])
    expect(t.name).toBe('~/projects/demo')
    expect(t.sessions.map((n) => n.row.id)).toEqual(['b', 'a'])
  })
})
