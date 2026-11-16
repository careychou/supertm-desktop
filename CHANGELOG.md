# Release notes

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
