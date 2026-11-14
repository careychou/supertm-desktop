import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { resolveDataHome, migrateDataHome } from '../src/main/datahome'
import { BRAND } from '../src/shared/brand'

const DB = BRAND.dbFile

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dh-'))

describe('resolveDataHome', () => {
  it('prefers <envPrefix>_HOME, then an explicit profile dir, then ~/<homeDir>', () => {
    expect(resolveDataHome({ env: { [`${BRAND.envPrefix}_HOME`]: '/x/y' }, home: '/h', profileDir: '/p' })).toBe('/x/y')
    expect(resolveDataHome({ env: {}, home: '/h', profileDir: '/p' })).toBe('/p')
    expect(resolveDataHome({ env: {}, home: '/h' })).toBe(path.join('/h', BRAND.homeDir))
  })
})

describe('migrateDataHome', () => {
  it('copies the db (including WAL contents) and settings once, keeping the originals', () => {
    const from = tmp(), to = path.join(tmp(), 'new')
    const db = new DatabaseSync(path.join(from, DB))
    db.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('hello')")
    fs.writeFileSync(path.join(from, 'settings.json'), '{"a":1}')

    expect(migrateDataHome(from, to)).toEqual([DB, 'settings.json'])
    db.close()
    const copy = new DatabaseSync(path.join(to, DB))
    expect(copy.prepare('SELECT v FROM t').get()).toEqual({ v: 'hello' })
    copy.close()
    expect(fs.readFileSync(path.join(to, 'settings.json'), 'utf8')).toBe('{"a":1}')
    expect(fs.existsSync(path.join(from, DB))).toBe(true)

    fs.writeFileSync(path.join(from, 'settings.json'), '{"a":2}')
    expect(migrateDataHome(from, to)).toEqual([])
    expect(fs.readFileSync(path.join(to, 'settings.json'), 'utf8')).toBe('{"a":1}')
  })

  it('does nothing when there is no old data or the folders are the same', () => {
    const d = tmp()
    expect(migrateDataHome(path.join(d, 'none'), path.join(d, 'new'))).toEqual([])
    expect(migrateDataHome(d, d)).toEqual([])
  })
})
