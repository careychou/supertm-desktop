# Release notes

## 1.4.1

### Long replies and file writes no longer cut off
- Model replies were capped at 16k tokens, so writing a large file could stop midway and a half-written tool call still ran. Each model now gets its full output limit (for example ~128k tokens for Claude 5). If a provider allows less, the app retries once with the limit the provider reports
- A reply cut off at the limit is detected: an incomplete tool call is not run, and the model is told to write the content in smaller parts. `write_file` can now append, so big files can be written in pieces
- Tool calls with missing required arguments, or arguments that aren't a JSON object, are reported back to the model instead of failing silently

### Limits you can change (Settings → General → Limits)
- New settings: Max output tokens (0 = model maximum), Shell output kept, Shell timeout max, read_file per call, web_fetch per call, Memory file max and Skill/agent description length
- read_file and web_fetch limits are per call, not file size limits: a long file is returned in parts that end on a whole line, and the model is told which line to read from next
- Image descriptions on Vertex are no longer capped at 4,096 tokens

### ⓘ explanations in Settings
- Every setting on the General, MS Office and Memory compaction tabs has an ⓘ. Hover, tab to it or click it to see what the setting does, with an example

## 1.4.0

### Export a chat as a skill
- Share session now has a **Skill** option next to Markdown. It turns the chat (or the turns you pick) into a ready-to-use skill pack: `SKILL.md` plus the scripts and files the chat used, under `scripts/` and `assets/`
- Name the skill yourself and choose where it goes: this folder's `.github/skills` or your personal `~/.copilot/skills`. An existing skill is never overwritten
- **Generate & review** drafts `SKILL.md` with the Memory compaction model, including a Requirements section. Nothing is saved until you click **Save skill**
- The review shows the pack as a folder tree. Click any file to view and edit it; edits change only the skill's copy, not your original files. You can rename, untick or add files (**+ Add files…**)
- Scripts the chat ran or wrote are found automatically, including in chats imported from Copilot or Claude and scripts run after a `cd`. Longer inline scripts (`python3 - <<EOF`) can be saved as files too
- Temp files (`/tmp` and similar) and inline snippets start unticked and hidden behind "Show N more…", so only real project files are included by default
- Before saving, the pack is scanned for secrets (tokens, keys, passwords) and you are warned before anything is written
- New skills show up in new chats

### Progress for long actions
- Import, export, memory compaction (analyze and compact), plugin install/remove/update and skill generate/save now show a working bar with elapsed time, or a real progress bar when the count is known (for example, sessions imported or turns compacted)
- Dialogs can't be closed by accident while one of these is running

## 1.3.0

### Settings changes reach open chats
- Max turns (main and sub-agent) and max concurrent model calls now apply to chats that are already open, including one that is running right now. Before, a busy chat or one with a background command kept the old limits until the app restarted
- Raising the concurrency limit starts waiting model calls right away; lowering it lets calls in flight finish first

### Higher defaults
- New installs start with 20 concurrent model calls, 500 max turns for the main agent and 500 for sub-agents (was 4, 50 and 30). Saved settings are kept
- Max concurrent model calls can now be set up to 64 (was 16)

### Clearer Settings buttons
- The Model providers, General, MS Office and Memory compaction tabs now show Close and Save. Close leaves without saving that tab's changes

## 1.2.17

### Switching chats while one is running
- A chat no longer goes blank when you switch to another chat before it finishes. Its reply, thinking, tool steps and any waiting permission or question now show when you switch back
- Chats that already went blank are not restored by this fix

### File links
- A link to a file written as `computer:///path/to/file` now opens the file. Before, it showed as plain text you could not click, while the folder next to it was a link

### One MS Office tab in Settings
- **Settings → MS Office** replaces the separate **Excel** and **Word & PowerPoint** tabs
- **Connect to Office** connects to Excel, Word and PowerPoint in one press, for whichever of them are open. Each app shows its own status line
- One choice turns Office on or off: all three, Excel only, Word and PowerPoint only, or off
- Ask-first and backup are now one setting each for all three apps. If you had them set differently for Excel and for Word and PowerPoint, the tab shows the safer one (ask first, backup on) and applies it to all three the next time you change it
- Tracked changes stays a Word-only setting
- macOS still asks once per app the first time, since it grants control app by app

## 1.2.16

### Attach an open Word document or PowerPoint presentation
- The 📎 menu now lists the documents open in Word and the presentations open in PowerPoint, next to the workbooks open in Excel. Before, it listed Excel only, so an open document could not be picked even though Settings showed Word as connected
- Picking one adds a **Live** chip (blue for Word, orange for PowerPoint) showing the paragraph your cursor is in or the slide on screen. The agent gets a reference to the document, not its text, and reads what it needs
- The chip follows you: the cursor position and selection are looked up again when you press Enter, so "tighten this paragraph" means the one you are in
- The menu appears when either Excel or Word and PowerPoint are turned on in Settings

### Work with Word and PowerPoint without an add-in
- The agent can now read and edit Word documents and PowerPoint presentations live, the same way it works with Excel: the file changes in the app while you watch, and nothing is saved until you save
- **Word:** read the document, replace, insert or delete a paragraph, format text or apply a style, add review comments, and insert or edit tables
- **PowerPoint:** read the slides, edit a bullet, a title or the speaker notes, format text, add or delete a slide, and add a text box or a table
- Give a file path and the app opens the file for you; or just ask about the document or deck you have open
- In Interactive chats each change shows a card with the text now and the text after, with **Apply**, **Apply all** and **Skip**
- **Settings → Word & PowerPoint:** turn it on or off, check the connection, make Word edits arrive as **tracked changes** you accept or reject, and keep a backup of the last saved version before the first edit
- If you edit the same paragraph while the agent is working, it makes no change and reads again instead of overwriting you
- Not supported: pictures, charts, headers and footers, and reordering slides

### Group chats under a parent chat
- Drag a chat onto the middle of another chat in the same working folder to file it under that chat. It is then listed there like a fork, and any chats already under it come along
- Or use a chat's **⋯** menu → **Move under another chat…** and pick the parent from a list you can filter. Useful after an import leaves related chats scattered
- To take a chat back out, drop it on its folder's name, drop it on the top or bottom edge of a top-level chat, or choose **Move to top level** in its ⋯ menu
- Dragging to the top or bottom edge of a chat still reorders; it now also works between levels
- Moving only changes where a chat is listed. The conversations themselves are untouched, and a chat cannot be moved to another working folder or under one of its own children
- A fork that is moved under a different chat no longer shows "forked at turn N", since it was not forked from its new parent

## 1.2.15

### Files and links you can click
- When an answer names a file it made or changed (a report, HTML page, workbook, export), the name is a link: click it to open the file in its default app, or ⌘-click to show it in Finder
- This works for links the assistant writes and for file paths it puts in `code` style, as long as the file exists. Paths can be absolute, start with `~/`, or be relative to the chat's working folder, and may contain spaces
- Web addresses in `code` style are clickable too and open in your browser
- Scripts, apps and other files that could run something are shown in Finder instead of opened. A link to a file that is gone says so
- The assistant is now told to give every artifact it produces, local or uploaded, as a clickable link

## 1.2.14

### Dialogs resize from any edge
- Drag any edge or corner of a dialog to resize it, not just the bottom-right corner. Each dialog still remembers its size
- When a dialog is taller than its content, the buttons stay at the bottom

### Test connection only on Model providers
- **Test connection** now shows only on Settings → Model providers, not on General, Excel or Memory compaction

## 1.2.13

### Import shows progress
- **Settings → Sync sessions** shows a progress bar while it reads a Copilot or Claude Code folder and while it imports, with how many chats are done
- When an import finishes, a summary replaces the list, with **Import more from this source**, and **Close** at the bottom of the tab

### Dialogs you can resize and close
- Every dialog (Settings, AI usage, memory, share, compact, export, plugins) has a **✕** close button and the **⤢** expand button in its top-right corner
- Drag a dialog's bottom-right corner to resize it; each dialog remembers its size. Double-click ⤢ to go back to the default size
- Settings → Skills & agents and Sync sessions now have a **Close** button at the bottom too
- A drag that starts inside a dialog and ends outside it (selecting text, resizing) no longer closes it

## 1.2.12

### Release notes inside the app
- **Settings → About** now shows the release notes for your version and earlier ones, built into the app. You no longer need to open GitHub to read them, and they show even when the update check fails

### Fixed
- **"fetch failed" on the update check.** That message meant the Mac never reached GitHub, and hid why. The check now names the cause and what to try: offline, an untrusted secure connection (typical of a company network that inspects traffic), a proxy, a name that cannot be looked up, or no answer from the server
- **Update checks and downloads now use the system proxy and the certificates in the macOS keychain**, like a browser does, which is what a company network usually needs
- **A new chat shows in the sidebar as soon as you send its first prompt.** Before, it only appeared once the first reply had finished, so you could not switch to another chat and come back while it was working. The blue pulsing dot marks a chat that is still running

## 1.2.11

### Work with Excel, without an add-in
- SuperTM can now read and edit Excel workbooks directly. A workbook **open in Excel** is edited in place while you watch, and Excel recalculates. A **closed `.xlsx` file** is edited on disk
- **Attach an open workbook**: click 📎 and pick it under *Use a workbook open in Excel*. The chip shows your current selection, so you can say "these cells". The first time, macOS asks whether SuperTM may control Excel
- **See the change before it is made**: in Interactive chats a card shows the cells that will be written and any they replace, with **Apply**, **Apply all Excel changes in this chat** and **Skip**. Autopilot chats apply without asking. Reading never asks
- **Each step is readable**: "Read Sales!A1:F40", "Write 40 cells to Sales!G1:G40". Click a step to see the cells as a grid
- **Exact highlighting**: for "highlight the stores under 20%", SuperTM tests every cell itself instead of leaving the model to pick the rows
- **Safety**: a backup (`name.backup.xlsx`) is made before the first edit; a write returns what the cells held before, so SuperTM can put it back; files with charts, pivot tables or macros are only edited while open in Excel, never on disk
- **Settings → Excel**: turn the feature off, check the connection, choose whether to ask before changes, turn backups off
- New: [tutorial section](doc/tutorial.md#work-with-excel) and [how it works](doc/excel.md)

### Fixed
- **Allow all … this session** now also answers requests of the same kind that were already waiting. Before, when the agent made several tool calls at once, the other cards stayed up

## 1.2.10

### Claude on Azure AI Foundry
- Claude deployments on Azure (e.g. `claude-…`) failed with *HTTP 404: Requested API is currently not supported*: Azure serves Claude only through the Anthropic Messages API, not chat/completions
- Deployments whose name contains `claude` now go to `/anthropic/v1/messages` on the same resource host and API key, with the same thinking, tools, images and prompt caching as Claude on Google Vertex. Nothing to change in Settings
- Any other deployment that answers chat/completions with *not supported* is retried on the Anthropic API once, and remembered

## 1.2.9

### Check for updates from inside the app
- **Settings → About → Updates** lists every newer release on GitHub with its release notes, so you can decide whether to upgrade
- **Download** fetches the macOS zip and checks its version; **Restart to install** replaces the app in Applications and reopens it. Chats, settings and keys are kept
- About 15 seconds after launch the app checks quietly; a **⬆** next to ⚙ in the sidebar means a newer release is out

### Expandable Settings window
- The **⤢** button in Settings (and in the Export sessions dialog) enlarges the dialog to fill most of the window, so long lists are easier to read. The choice is remembered

## 1.2.8

### Text-to-speech models (Google Vertex)
- Add a Gemini TTS model to your Vertex model list, for example `google/gemini-3.8-flash-tts`. Pick it in the composer and it **reads your text aloud**. The reply has a player you can play and scrub, plus where the WAV file was saved (the `media` folder in the app's data folder)
- Any model ending in `-tts` is recognized automatically; add `tts` to the line for other names
- **Pick the voice per message:** start the prompt with `voice: Puck — Hello team…`. Set a model's default voice on its line with `voice=Name` (e.g. `google/gemini-3.8-flash-tts voice=Puck`); otherwise it's **Kore**. 30 Gemini voices are available (Kore, Puck, Charon, Fenrir, Aoede, Leda, Orus, Zephyr, …)
- **Steer the delivery** in plain words: "Say cheerfully: …", "Read slowly and calmly: …", "In a whisper: …". It is sent to the model as a director's note, so only your text is spoken, not the instruction
- **Two-speaker dialogue:** put `voices: Carey=Puck, Pearl=Kore` on the first line, then `Carey: …` / `Pearl: …` lines. A script whose lines all start with one of two names is read as a dialogue even without the `voices:` line
- With a TTS model selected, the chat box shows a hint with these patterns; click one to insert it
- A TTS model reads only your latest message. It doesn't see the chat history and can't use tools

## 1.2.7

### Fix: a refused keychain prompt no longer wipes your settings
- After an update, macOS asks for keychain access again. If that prompt was refused or interrupted, the app could not read the saved provider keys and fell back to default settings. The next save then wiped every provider, key and setting
- Keys it cannot read are now kept exactly as they were saved, and only the affected key shows as blank. Restart and choose **Always Allow** to get it back; there is no need to re-enter it

## 1.2.6

### Fix: Gemini 3.x tool calls on Google Vertex
- Gemini 3 models (e.g. `google/gemini-3.8-flash`, `google/gemini-4-argon`) failed as soon as they used a tool, with *Function call is missing a thought_signature*
- The app now keeps the `thought_signature` Gemini attaches to each tool call and sends it back on the next request. It is only sent to `google/*` models, so switching a chat to another provider still works

## 1.2.5

### Fix: downloaded app no longer reported as "damaged"
- Earlier builds kept only the Electron binary's signature, so a browser-downloaded copy failed macOS's signature check and was reported as **"SuperTM Desktop" is damaged and can't be opened**
- The app is now fully signed ad hoc. It still isn't notarized by Apple, so the first launch shows **can't verify the developer**: approve it once in **System Settings → Privacy & Security → Open Anyway**, or run `xattr -cr "/Applications/SuperTM Desktop.app"` (see the README)
- After each update, macOS asks once for your login password to unlock the app's saved keys (*Safe Storage*): click **Always Allow**. Ad-hoc signed apps are identified by build, so only Apple Developer ID signing would avoid this prompt

## 1.2.4

### Fix: AI usage → Azure resource asks you to sign in instead of failing
- When the Azure CLI is installed but not signed in (or its sign-in expired), the tab now shows **Sign in to Azure** instead of an `az account get-access-token failed` error
- Click it to run `az login` (using the provider's tenant, if set) and finish Microsoft sign-in in the browser; the tab reloads with your usage and cost. **Cancel** stops a sign-in you don't want to finish
- Tokens stay in the Azure CLI's cache and are never shown. A missing CLI or a missing role still gets its own message

## 1.2.3

### New: jump between turns in long chats
- **Turn rail**: tick marks on the right edge of the chat, one per prompt. The current turn is highlighted; hover a tick for the prompt and the first line of the reply, click to jump to it
- **Pinned prompt**: while you read a long reply, its prompt stays pinned at the top of the chat; click it to go back to the start of the turn
- **⌥↑ / ⌥↓** jump to the previous / next prompt (inside a non-empty message box they keep their text-editing meaning)

## 1.2.2

### New: About page shows which version you are running
- **Settings → About**: app version, build (git commit and build date), Electron, Chromium and Node.js versions, macOS and the data folder
- **Copy version info** for bug reports, and **Check for newer releases** opens the Releases page
- The macOS menu **SuperTM Desktop → About SuperTM Desktop** now shows the version and build too

## 1.2.1

### Fix: imports no longer add a duplicate working folder
Importing chats (from another Mac's SuperTM export, GitHub Copilot or Claude Code) used to keep the source machine's folder path, so the sidebar grew a second folder with the same name (e.g. two **aitm** folders).
- The import panel now asks **Import into working folder**: pick one of your folders or **Choose another folder…**. **Import** stays disabled until you choose
- Only the chats are imported, never the other Mac's folder path. Forked chats are imported under their parent in the same folder
- Chats that already exist here (**Overwrite** / **Import as fork**) stay in their current folder
- The source folder's memory is copied to the destination when that folder has none

## 1.2.0

### New: folder plugins from a marketplace
Install plugins **into one working folder's `.github/`** instead of your global `~/.copilot/`, so each folder loads only the skills and agents it needs.
- Right-click a working folder (or its **⋯** button) → **⧉ Plugins…**
- **Marketplaces** tab: add any git URL plus an optional branch (e.g. `https://github.com/github/awesome-copilot`, branch `marketplace`). Copilot and Claude-style marketplaces both work; private repos use your SSH key or git credentials
- **Browse** tab: search, **Install**, **Remove**. Agents are installed as `*.agent.md`; hooks, MCP servers and commands are reported but not installed
- The app never overwrites skills you wrote yourself, and **Remove** deletes only the files the plugin added (tracked in `.github/supertm.lock.json`)
- **Updates**: checked every 6 hours and when you open a chat in the folder. A **⬆** badge on the folder means updates are ready
- The agent can manage plugins too (`folder_plugins` tool), asking permission before changes
- The skill count under the composer updates as soon as you close the dialog

## 1.1.0

### New: folder memory
Give **every chat in a working folder** the same standing context: facts, preferences, decisions, reference docs.
- Right-click a working folder in the sidebar (or use its **⋯** button) → **Add folder memory…**
- Write free-text **notes** and/or attach `.md` / `.txt` files
- Applies to new **and existing** chats in that folder, read at the start of every turn; edits take effect on the next message
- A 🗂 icon marks folders with memory; a green **🗂 Folder memory** chip in the composer opens it for editing
- Folder memory travels with export / import and never overwrites folder memory you already have

### Improved: session memory takes notes too
**＋ Memory** now opens an editor with free-text **notes** plus attached files (previously files only). When folder and session memory disagree, session memory wins. Chats with older file-only memory keep working unchanged.

## 1.0.1

### Improved: session picker is a folder tree
Export and all three import sources (this app, GitHub Copilot, Claude Code) now show chats as a **collapsible tree by working folder** (e.g. `~ › projects › demo`):
- folders nest by path; folders with only one subfolder and no chats of their own merge into one row (`Library/CloudStorage/…`)
- forks sit under their parent chat
- filter by title or folder (matching folders open automatically), plus Expand all / Collapse all
- folder checkboxes select everything inside, with a running "N of M selected" count
- small lists open fully; large ones (hundreds of Copilot chats) open only the top folders
- conflict choices (Skip / Overwrite / Fork) stay on each conflicting chat

## 1.0.0 — major release

1.0 makes the app a home for **all** your agent chats. It brings in your GitHub Copilot and Claude Code history, moves chosen chats between Macs, and adds real cost tracking for Azure.

### New: import from GitHub Copilot and Claude Code
Settings → **Sync sessions** → *Import from* has three sources:

| Source | Pick | What happens |
|---|---|---|
| **This app** (an export folder) | The folder you exported to on another Mac | Same flow as before. A chat already on this Mac shows how much newer or older the import is, and you choose **Skip**, **Overwrite local** or **Import as fork**. |
| **GitHub Copilot** | A Copilot session-state folder (`~/.copilot` or a synced copy) | Lists every Copilot chat with turns, grouped by working folder, titled by its session name. |
| **Claude Code** | `~/.claude/projects` (or one project) | Lists every Claude Code chat, grouped by project, titled by its custom title or first prompt. |

- Copilot and Claude chats are always **added as new chats** with new IDs, so nothing conflicts.
- Each import keeps the full transcript: prompts, answers, reasoning, tool calls and results, plus earlier compaction summaries. You can continue it on your own models right away.
- Sub-agent chatter, autopilot and notification messages, slash commands and hook noise are filtered out.
- Large histories are fast: 500+ Copilot chats are listed in under a second, and a 380 MB transcript imports in about a second.

### Improved: export
**Export sessions…** asks for a destination folder first, then shows every chat (grouped by folder, with a filter) all checked. Uncheck the ones to leave out, then confirm. The export holds only the chats you picked.

### Improved: session picker
Export and all three import sources share one picker:
- a title/folder filter
- select-all for what is shown
- per-folder checkboxes
- a running "N selected" count

### Azure
- **Responses API fallback:** deployments that refuse tools on `chat/completions` (newer reasoning and codex models) are retried on the Responses API automatically and remembered per deployment.
- **Cost estimation:** the AI usage panel shows Azure token usage from Azure Monitor and actual billed cost from Cost Management for the resource. Local estimates use the price of the model the deployment actually serves.

### Also in this release (since 0.9)
- Native **Google Vertex AI** provider: service-account auth, Claude with prompt caching, OpenAI-compatible models, Cloud Monitoring project usage. No local proxy is needed.
- **Model providers** tab: Vertex AI, Azure OpenAI and custom OpenAI-compatible endpoints side by side, with a primary provider. Chats keep their provider.
- **Memory compaction** settings: a separate compaction model and cache-aware auto-compact that waits for the prompt cache to expire.
- **Skills & agents** tab listed per working folder, plus Personal.
- **Esc** closes dialogs and menus, topmost first.

### Upgrade notes
- Existing chats, settings and exports are unchanged. Exports from 0.10 import fine.
- Importing from Copilot or Claude only reads their folders; it never changes them.
