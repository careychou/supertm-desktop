import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { existingPaths, linkAction, resolveLocal } from '../src/main/filelinks'

let dir = ''
beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'links-')))
  fs.mkdirSync(path.join(dir, 'out'))
  fs.writeFileSync(path.join(dir, 'out', 'recap 11.18.2026.html'), '<p>hi</p>')
  fs.writeFileSync(path.join(dir, 'run.sh'), 'echo hi')
  fs.writeFileSync(path.join(dir, 'app.ts'), '')
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('chat file links', () => {
  it('resolves relative, absolute, encoded and file:// forms', () => {
    const f = path.join(dir, 'out', 'recap 11.18.2026.html')
    expect(resolveLocal('out/recap 11.18.2026.html', dir)).toBe(f)
    expect(resolveLocal('out/recap%2011.18.2026.html', dir)).toBe(f)
    expect(resolveLocal(f, '/elsewhere')).toBe(f)
    expect(resolveLocal(pathToFileURL(f).href, '/elsewhere')).toBe(f)
    expect(resolveLocal('computer://' + f.replace(/ /g, '%20'), '/elsewhere')).toBe(f)
    expect(resolveLocal('out/recap 11.18.2026.html#tab2', dir)).toBe(f)
    expect(resolveLocal('app.ts:12:3', dir)).toBe(path.join(dir, 'app.ts'))
    expect(resolveLocal('~/x.txt', dir)).toBe(path.join(os.homedir(), 'x.txt'))
  })
  it('reports which mentioned paths exist', () => {
    expect(existingPaths(['app.ts', 'nope.ts', 'out'], dir)).toEqual([path.join(dir, 'app.ts'), null, path.join(dir, 'out')])
  })
  it('opens documents, reveals anything that could run, flags missing files', () => {
    expect(linkAction(path.join(dir, 'out', 'recap 11.18.2026.html'))).toBe('open')
    expect(linkAction(path.join(dir, 'out'))).toBe('open')
    expect(linkAction(path.join(dir, 'run.sh'))).toBe('reveal')
    expect(linkAction(path.join(dir, 'app.ts'), true)).toBe('reveal')
    expect(linkAction(path.join(dir, 'gone.html'))).toBe('missing')
  })
})
