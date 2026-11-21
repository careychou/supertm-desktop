import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { collectSkillFiles, finalizeSkillMd, scanSecrets, skillName, skillNameError, skillTargets } from '../src/shared/skill-export'
import { addedFiles, draftSkill, findingsFor, writeSkill } from '../src/main/skill-export'
import type { ExportItem } from '../src/shared/export'

const tool = (name: string, args: object, ok = true): ExportItem => ({ t: 'tool', name, args: JSON.stringify(args), ok })

describe('skill names', () => {
  it('slugifies and rejects reserved prefixes', () => {
    expect(skillName('Carey Weekly Sales Report!')).toBe('carey-weekly-sales-report')
    expect(skillName('a'.repeat(100)).length).toBe(64)
    expect(skillNameError('carey-x')).toBe('')
    expect(skillNameError('')).toMatch(/Enter/)
  })
})

describe('collectSkillFiles', () => {
  const items: ExportItem[] = [
    { t: 'user', text: 'one' },
    tool('write_file', { path: 'etl/load.py', content: 'x' }),
    tool('write_file', { path: 'out/report.csv', content: 'x' }),
    tool('write_file', { path: 'bad.py', content: 'x' }, false),
    { t: 'user', text: 'two' },
    tool('shell', { command: 'python3 -u etl/load.py --day 1; node tools/run.js' }),
    { t: 'agent', name: 'a', mode: 'sync', prompt: 'p', status: 'completed', finalText: '', children: [tool('edit_file', { path: 'lib/util.sh', old_str: 'a', new_str: 'b' })] }
  ]
  it('finds written, edited and run files in the selected turns; skips failed calls', () => {
    expect(collectSkillFiles(items).map(({ path, kind }) => ({ path, kind }))).toEqual([
      { path: 'etl/load.py', kind: 'scripts' }, { path: 'out/report.csv', kind: 'assets' },
      { path: 'tools/run.js', kind: 'scripts' }, { path: 'lib/util.sh', kind: 'scripts' }
    ])
    expect(collectSkillFiles(items, [1]).map((f) => f.path)).toEqual(['etl/load.py', 'tools/run.js', 'lib/util.sh'])
  })
  it('captures heredoc scripts the agent ran and files written with cat > path', () => {
    const cmd = "cat > cfg/settings.json <<'EOF'\n{}\nEOF\npython3 - <<'PY'\nimport pandas as pd\ndf = pd.read_csv('x.csv')\nprint(df.head())\nPY\npython3 - <<EOF\nprint(1)\nEOF"
    const f = collectSkillFiles([{ t: 'user', text: 'u' }, tool('shell', { command: cmd })])
    expect(f.map((x) => [x.path ?? x.name, x.origin])).toEqual([['cfg/settings.json', 'written'], ['inline-1.py', 'inline']])
    expect(f[1].content).toBe("import pandas as pd\ndf = pd.read_csv('x.csv')\nprint(df.head())\n")
  })
  it('understands imported Copilot / Claude tool names and paths after cd', () => {
    const f = collectSkillFiles([{ t: 'user', text: 'u' },
      tool('bash', { command: 'cd /Users/me/docs; wc -l build.py; python3 build.py --out x.html && cd sub && node gen.js' }),
      tool('create', { path: '/abs/notes.md', file_text: 'x' }),
      tool('Write', { file_path: 'rel/load.sql', content: 'x' }),
      tool('str_replace_editor', { command: 'view', path: '/abs/readme.md' })])
    expect(f.map((x) => [x.path, x.kind])).toEqual([['/Users/me/docs/build.py', 'scripts'], ['/Users/me/docs/sub/gen.js', 'scripts'], ['/abs/notes.md', 'assets'], ['rel/load.sql', 'scripts']])
  })
  it('gives clashing base names unique targets', () => {
    expect(skillTargets([{ path: 'a/x.py', kind: 'scripts', origin: 'written' }, { path: 'b/x.py', kind: 'scripts', origin: 'written' }, { path: 'x.py', kind: 'assets', origin: 'written' }])).toEqual(['scripts/x.py', 'scripts/x-2.py', 'assets/x.py'])
  })
})

describe('scanSecrets', () => {
  it('flags tokens and emails, masked; ignores env references', () => {
    const f = scanSecrets('token ghp_abcdefghijklmnopqrstuvwxyz123456\nemail bob@corp.com\npassword = os.environ["PW"]\nuser@example.com')
    expect(f.map((x) => x.kind)).toEqual(['GitHub token', 'email address'])
    expect(f[0].sample).not.toContain('abcdefghij')
  })
})

describe('finalizeSkillMd', () => {
  it('strips a fence and forces the name', () => {
    expect(finalizeSkillMd('```markdown\n---\nname: other\ndescription: d\n---\n# T\n```', 'carey-x')).toBe('---\nname: carey-x\ndescription: d\n---\n# T\n')
    expect(finalizeSkillMd('# T', 'carey-x')).toContain('name: carey-x\n')
  })
})

describe('draft + write', () => {
  it('drafts with bundled files and writes a skill folder without overwriting', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'skx-'))
    fs.writeFileSync(path.join(cwd, 'load.py'), 'print(1)')
    const items: ExportItem[] = [{ t: 'user', text: 'load data' }, tool('write_file', { path: 'load.py', content: 'print(1)' }), tool('write_file', { path: 'gone.py', content: '' })]
    let prompt = ''
    const d = await draftSkill({ items, name: 'carey-load', title: 'T', cwd, model: 'm', complete: async (_s, u) => { prompt = u; return { text: '---\nname: x\ndescription: Load data.\n---\n# Load', model: 'cm' } } })
    expect(prompt).toContain('scripts/load.py')
    expect(prompt).not.toContain('scripts/gone.py')
    expect(prompt).not.toContain('<instructions>')
    await draftSkill({ items, name: 'carey-load', instruction: '  Make the store number an input.  ', title: 'T', cwd, model: 'm', complete: async (_s, u) => { prompt = u; return { text: '# x', model: 'cm' } } })
    expect(prompt).toContain('<instructions>\nMake the store number an input.\n</instructions>')
    expect(prompt.indexOf('</instructions>')).toBeLessThan(prompt.indexOf('<chat>'))
    expect(d.md).toContain('name: carey-load')
    expect(d.files.map((f) => [f.target, f.exists])).toEqual([['scripts/load.py', true], ['scripts/gone.py', false]])
    const root = path.join(cwd, '.github', 'skills')
    const dir = writeSkill(root, 'carey-load', d.md, [{ source: d.files[0].source!, target: d.files[0].target }])
    expect(fs.readFileSync(path.join(dir, 'scripts', 'load.py'), 'utf8')).toBe('print(1)')
    expect(() => writeSkill(root, 'carey-load', d.md, [])).toThrow(/already exists/)
    expect(() => writeSkill(root, '../evil', d.md, [])).toThrow(/invalid/)
    expect(() => writeSkill(root, 'carey-y', d.md, [{ source: d.files[0].source!, target: '../x' }])).toThrow(/invalid/)
    expect(() => writeSkill(root, 'carey-z', d.md, [{ content: 'a', target: 'assets/a' }, { content: 'b', target: 'assets/a' }])).toThrow(/both named/)
  })
  it('writes edited/inline content instead of copying, and scans it for secrets', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'skx-'))
    fs.writeFileSync(path.join(cwd, 'q.sql'), 'select 1 -- bob@corp.com')
    const files = [{ source: path.join(cwd, 'q.sql'), target: 'scripts/q.sql' }]
    expect(findingsFor('# x', files).map((f) => f.kind)).toEqual(['email address'])
    const edited = [{ target: 'scripts/q.sql', content: 'select 1' }, { target: 'scripts/inline-1.py', content: 'print(2)\n' }]
    expect(findingsFor('# x', edited)).toEqual([])
    const dir = writeSkill(path.join(cwd, 'skills'), 'carey-q', '# x', edited)
    expect(fs.readFileSync(path.join(dir, 'scripts', 'q.sql'), 'utf8')).toBe('select 1')
    expect(fs.readFileSync(path.join(cwd, 'q.sql'), 'utf8')).toContain('bob@')
    expect(fs.readFileSync(path.join(dir, 'scripts', 'inline-1.py'), 'utf8')).toBe('print(2)\n')
  })
  it('gives added files targets that do not clash', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'skx-'))
    fs.writeFileSync(path.join(cwd, 'load.py'), 'x'); fs.writeFileSync(path.join(cwd, 'ref.pdf'), 'x')
    const a = addedFiles([path.join(cwd, 'load.py'), path.join(cwd, 'ref.pdf')], ['scripts/load.py'])
    expect(a.map((f) => [f.target, f.origin, f.exists])).toEqual([['scripts/load-2.py', 'added', true], ['assets/ref.pdf', 'added', true]])
  })
})
