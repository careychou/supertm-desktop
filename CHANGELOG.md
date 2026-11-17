# Release notes

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
