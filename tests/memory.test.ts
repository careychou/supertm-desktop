import { describe, it, expect } from 'vitest'
import { parseMemory, serializeMemory } from '../src/shared/memory'

describe('memory column', () => {
  it('reads the older array-of-paths form and the notes+files form', () => {
    expect(parseMemory('["/a.md","/b.md"]')).toEqual({ files: ['/a.md', '/b.md'], notes: '' })
    expect(parseMemory('{"files":["/a.md"],"notes":"hi"}')).toEqual({ files: ['/a.md'], notes: 'hi' })
    expect(parseMemory(null)).toEqual({ files: [], notes: '' })
    expect(parseMemory('not json')).toEqual({ files: [], notes: '' })
  })
  it('stores null when empty and de-duplicates files', () => {
    expect(serializeMemory({ files: [], notes: '  ' })).toBeNull()
    expect(JSON.parse(serializeMemory({ files: ['/a', '/a'], notes: 'n' })!)).toEqual({ files: ['/a'], notes: 'n' })
  })
})
