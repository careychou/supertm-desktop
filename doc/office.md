# Word and PowerPoint: how it works

SuperTM Desktop reads and edits Word documents and PowerPoint presentations without an add-in, the same way it works with [Excel](excel.md). This page explains the mechanics and the limits. For how to use it, see the [tutorial](tutorial.md#work-with-word-and-powerpoint).

## The short version

- The model never sees Word or PowerPoint. It sees twelve tools (`word_*`, `powerpoint_*`) and gets text back.
- Everything is **live**: the app sends Apple events to the running Word or PowerPoint, so the change appears on screen and the user can undo it. Nothing is saved until the user saves.
- A file path that is not open yet is opened in the app first, in the background. There is no on-disk editing path as there is for `.xlsx`.
- No screenshots and no mouse control are involved.

## The pieces

| Piece | File | Job |
|---|---|---|
| Tools | `src/main/office/service.ts` | Defines the tools, opens files, asks for approval, makes backups, formats the result text |
| Live backend | `src/main/office/live.ts` | One script, run by `osascript`, holding every Word and PowerPoint operation |
| Shared helpers | `src/shared/office.ts` | Types, the text the model reads, span and colour parsing |
| Wiring | `src/main/office/index.ts` | Registers the tools and two IPC calls (`office:status`, `office:attach`) |
| Chat UI | `src/renderer/src/components/OfficeViews.tsx` | The approval card and the before/after view in tool rows |
| Composer and Settings | `Composer.tsx`, `SettingsModal.tsx` | The paperclip menu, the document chip, and Settings → Word & PowerPoint |

## Attaching an open document

The paperclip menu lists what is open in Word and PowerPoint, under the workbooks open in Excel. Picking a document calls `office:attach`, which builds a short *document note*: the name to pass to the tools, the path, the size (paragraphs, tables, comments and track-changes state for Word; slides for PowerPoint), and where the user is (the paragraphs the cursor or selection covers, or the slide on screen, plus up to 300 characters of selected text). The content is not included; the note tells the model to read it with `word_read` or `powerpoint_read`.

Just before sending, the app asks again, so the note carries the cursor position at the moment the user pressed Enter. If the document was closed in between, the chip from the first lookup is sent as it was.

The menu is shown when Excel, or Word and PowerPoint, are turned on and installed. Each app is asked separately, so a slow answer from one does not hold up the others. Opening the menu is one of the moments the app talks to Word or PowerPoint, so the first time macOS may ask whether the app may control them.

## The tools

| Tool | What it does |
|---|---|
| `word_info`, `powerpoint_info` | What is open, its size, and where the user's cursor or selection is |
| `word_read` | The document as numbered paragraphs; headings marked `[H1]`…, table cells marked `[table]`. One table as rows with `table` |
| `word_edit` | Replace, insert after, or delete one paragraph |
| `word_format` | Bold, italic, underline, highlight, colour, size, or a paragraph style, on paragraphs or one phrase |
| `word_comment` | A review comment on a paragraph or a phrase |
| `word_table` | Insert a filled table, change cells, add a row |
| `powerpoint_read` | Each slide's shapes by number, each shape's paragraphs, and the notes |
| `powerpoint_edit` | Replace one paragraph (bullet), a whole shape's text, table cells, or the speaker notes |
| `powerpoint_format` | Bold, italic, underline, size, colour on a shape or one paragraph |
| `powerpoint_slide` | Add a slide (layout, title, body, notes) or delete one |
| `powerpoint_add` | Add a text box or a table to a slide |

## Addressing, and editing alongside the user

Excel has cell addresses. Word has none, so the tools address a document by **paragraph number** and a deck by **slide, shape and paragraph number**. These shift when something is inserted or deleted, by the model or by the user. Three things keep an edit from landing in the wrong place:

1. The service reads the target just before it asks for approval, so the card shows the text as it is now.
2. That text travels with the edit. The script compares it with the document again and refuses with "changed since it was read" if they differ. Nothing is written in that case.
3. The model can pass `expect` (a few words the target should contain), checked before the approval card appears.

Calls run one at a time in the order they were made, because every edit can renumber what follows.

Positions inside a Word document always come from Word itself, never from arithmetic on the text: a tracked deletion stays in the document, and a table cell carries marks that are not counted.

## Tracked changes

Word edits can be made as tracked changes, so they arrive as suggestions the user accepts or rejects. Settings → Word & PowerPoint sets the default; a call's own `track` argument wins. The script turns tracking on for the one edit and restores the user's setting afterwards. PowerPoint has no equivalent.

## Safety around changes

- **Approval.** In Interactive chats every change shows a card with the text now and the text after. Autopilot applies without asking, as for other tools. "Apply all" covers Word and PowerPoint changes for the rest of the chat.
- **Backup.** Before the first edit of a saved file, a copy of the last saved version is written next to it as `name.backup.docx` / `.pptx`.
- **Not saved.** The tools never save. The user saves, or closes without saving to discard.

## Two forms of scripting

Most operations use JavaScript for Automation. A few commands are only accepted from AppleScript (a new slide, a new shape, a new Word comment, a new table row); the script sends those as AppleScript from inside the same run.

One call is deliberately never made: creating a Word table with a `text object` in its properties makes Word quit. A table is placed by giving the paragraph as its position.

## Scope and known gaps

- macOS only, and only the desktop Word and PowerPoint apps.
- Not supported: pictures, charts, headers and footers, footnotes, moving or resizing existing shapes, and reordering slides (PowerPoint refuses it).
- Replacing a whole shape's text resets formatting that differed between its paragraphs. Replacing one paragraph does not.
- Reading a Word document costs one call to Word per paragraph, so long documents come back in parts of up to 600 paragraphs.
- Files shared on SharePoint with other people editing at the same time have not been tested.

## Tests

`tests/office.test.ts` runs the tools against a stand-in for the two apps: reads, edits, the stale-text guard, approval, tracked changes, backups, opening a file by path, and the note built when an open document is attached.
