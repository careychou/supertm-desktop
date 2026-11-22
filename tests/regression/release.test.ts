// Release hygiene: run on every release so the version, changelog and in-app notes stay in step.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { compareVersions, parseChangelog } from '../../src/shared/updates'

const root = path.join(__dirname, '..', '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const log = parseChangelog(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'))

describe('release metadata', () => {
  it('has a CHANGELOG entry for the package version at the top', () => {
    expect(log[0]?.version).toBe(pkg.version)
    expect(log[0].notes.length).toBeGreaterThan(0)
  })
  it('lists every version once, newest first, each with notes', () => {
    const versions = log.map((e) => e.version)
    expect(new Set(versions).size).toBe(versions.length)
    for (let i = 1; i < versions.length; i++) expect(compareVersions(versions[i - 1], versions[i])).toBeGreaterThan(0)
    for (const e of log) expect(e.notes, e.version).not.toBe('')
  })
})
