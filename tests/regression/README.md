# Release regression suite

Every release must pass this before it is tagged:

```bash
npm run release:check   # typecheck + every test (unit + regression)
```

`npm run test:regression` runs only this folder.

## Layout

- `tests/*.test.ts` — unit tests per module (the bulk of coverage).
- `tests/regression/` — release-keyed checks: one file per release line (`v1.4.x.test.ts`, …), one `describe('<version> — <feature>')` per CHANGELOG heading that isn't already pinned by a unit test, plus `release.test.ts` (package version ↔ CHANGELOG).
- `tests/fixtures/` — shared fixtures (e.g. `certs/` test CA + leaf for `mcp.example.test`, valid to 2126).

## Adding a release

1. Write the CHANGELOG entry and bump `package.json`; `release.test.ts` fails until both agree.
2. For each new `###` heading: point to the unit test that covers it below, or add a case to `tests/regression/v<major>.<minor>.x.test.ts`, or list it under **Manual checks** if it needs the UI or an outside service.
3. Never delete a case for an older release; if behavior changes on purpose, update the case and say why in the CHANGELOG.

## Coverage map

| Release | Feature | Covered by |
|---|---|---|
| 1.4.3 | Import list from index only (no event logs, Claude head/tail, read-only store) | `import-external.test.ts` |
| 1.4.2 | Several MCP servers: add/rename/disable/remove, form ↔ entry | `mcp.test.ts` (mcp config) |
| 1.4.2 | MCP browser sign-in, tools, re-sign-in | `mcp.test.ts` (McpHub OAuth) |
| 1.4.2 | Extra trusted certificates (company CA) | `regression/v1.4.x` |
| 1.4.2 | Launch update check, skip version | `updates.test.ts` (launchOffer), `regression/v1.4.x` |
| 1.4.2 | Export names, skill instruction | `regression/v1.4.x` |
| 1.4.1 | Output uses model max, 400 retry | `adapter.test.ts`, `regression/v1.4.x` |
| 1.4.1 | read_file paging, write_file append | `tools.test.ts` |
| 1.4.1 | Configurable limits with fallback | `regression/v1.4.x` |
| 1.4.0 | Export chat as skill (files, heredocs, secrets, no overwrite) | `skill-export.test.ts`, `regression/v1.4.x` |
| 1.4.0 | Import progress | `import-external.test.ts` |
| 1.3.0 | Settings reach open chats | `limits.test.ts` |
| 1.3.0 | Higher defaults | `regression/v1.3.x` |
| 1.2.17 | Chat running off-screen keeps cards | `background.test.ts` |
| 1.2.17/1.2.15 | File links (`computer://`, encoded, :line) | `filelinks.test.ts` |
| 1.2.16 | Word / PowerPoint tools | `office.test.ts` |
| 1.2.16 | Group chats under a parent | `move-session.test.ts` |
| 1.2.12 | Release notes in app | `updates.test.ts`, `regression/release.test.ts` |
| 1.2.11 | Excel tools | `excel.test.ts` |
| 1.2.10 | Claude on Azure | `providers.test.ts`, `regression/v1.2.x` |
| 1.2.8 | Text-to-speech models | `vertex.test.ts`, `regression/v1.2.x` |
| 1.2.9 | Check for updates | `updates.test.ts`, `regression/v1.2.x` |
| 1.2.7 | Refused keychain keeps keys | `settings.test.ts` |
| 1.2.6 | Gemini thought_signature | `adapter.test.ts` |
| 1.2.5 | Azure usage sign-in | `usage.test.ts` |
| 1.2.4 | Jump between turns | `turns.test.ts` |
| 1.2.1 | Import without duplicate folder | `sync.test.ts` |
| 1.2.0 | Folder plugins (no overwrite) | `plugins.test.ts` |
| 1.1.0 | Folder / session memory | `memory.test.ts`, `sync.test.ts` |
| 1.0.1 | Session picker tree | `session-tree.test.ts`, `fork.test.ts` |
| 1.0.0 | Import Copilot / Claude | `import-external.test.ts` |
| 1.0.0 | Export markdown | `export.test.ts` |
| 0.x | Engine, sub-agents, skills/agents registry, compaction, attachments | `engine.test.ts`, `registry.test.ts`, `compact.test.ts`, `attach.test.ts` |

## Manual checks (packaged app, before publishing)

- [ ] App opens from the downloaded DMG (not reported as "damaged"); About shows the new version.
- [ ] Launch update banner appears when a newer release exists; "Skip this version" hides it.
- [ ] MCP server with browser sign-in: Sign in opens the browser, status turns Connected, a tool call works.
- [ ] Send a prompt; a sub-agent runs; Stop works; switching chats mid-run keeps the reply.
- [ ] Settings ⓘ tooltips show; Limits save and apply to an open chat.
- [ ] Progress shows for Import, Export, Compact, Refresh and Generate skill.
- [ ] Export to Skill Pack: tree, edit, save writes the folder.
- [ ] Dialogs resize from edges, ✕ and ⤢ work; drag a chat under another.
- [ ] Turn rail jumps between prompts; file links open / reveal.
- [ ] Excel / Word / PowerPoint live edit asks first and applies (if installed).
- [ ] Keychain prompt "Always Allow" keeps keys after restart.
