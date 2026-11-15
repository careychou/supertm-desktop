# Feature reference

Everything SuperTM Desktop does, in detail. New to the app? Start with the [tutorial](tutorial.md).

## Agent
- **Model providers** — Settings → *Model providers* lists your providers, like Copilot's: any **OpenAI-compatible custom endpoint** (vLLM, Ollama, OpenRouter, LiteLLM), **Azure OpenAI** (resource host, API version, deployment names) and **Google Vertex AI** (GCP project + service-account key: Gemini, Claude and Model Garden models directly). Add several; **Make primary** picks the provider whose models show unprefixed; the chat box groups models by provider and you switch models per chat. Keys are encrypted with the macOS Keychain.
- **Tools (Copilot-equivalent)** — `shell` (sync, or `async` for servers/watchers) with `read_shell` / `write_shell` / `stop_shell` / `list_shells`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `web_fetch` (page → Markdown), `sql` (a per-chat SQLite scratch DB with a ready `todos` table for planning), `skill`, `task`, `read_agent`, `list_agents`, `ask_user`. Independent tool calls run in parallel. Copilot names (`view`, `create`, `bash`, `web`…) work in agent `tools:` lists.
- **Interactive / Autopilot** — per chat, next to the folder below the chat box. **Autopilot** (the default) runs shell, file and web tools without asking; **Interactive** asks first (*allow once*, *allow for this chat*, or *deny*). Switching to Autopilot approves anything the chat is waiting on. Set the default for new chats in Settings.
- **Copilot-style activity** — each tool call shows a plain description ("Install dependencies", "Edit src/app.ts", "Fetch docs.python.org/…") instead of the tool name; consecutive calls fold into one row ("Run tests and 3 other tool calls"). Expand to see each call, and expand a call to see the `$ command` and its output in a terminal block, file diffs, or SQL results.
- **Sub-agents** — the `task` tool runs a sub-agent with fresh context. Several `task` calls in one turn run **in parallel**; `mode: "background"` returns immediately and the result is fetched later with `read_agent` (the main agent is woken when it finishes). Nested delegation is capped at depth 2; Stop cancels the whole tree.
- **Model thinking** — a Copilot-style *Thinking → Thought* block streams the model's reasoning and collapses to a one-line peek. Per-chat effort: 💭 off / low / medium / high. Reads `reasoning_content` / `reasoning`, inline `<think>` tags, and Gemini thought parts.
- **Queue follow-ups while it works** — keep typing while the agent runs, the way Copilot does. A queued prompt shows above the box (× to pull it back) and joins **the same conversation** at the agent's next step, after the current tool results and before its next model call, so the agent changes course mid-task. No second agent is started. If the agent has already answered, the queued prompt starts the next turn. *Stop* cancels the run, including any pending approval, and puts queued text back in the box.

## Skills & agents (Copilot-compatible)
- **Skills**: `skills/<name>/SKILL.md` with YAML front-matter (`name`, `description`). Only names + descriptions go into the prompt; the model loads a skill's full body on demand with the `skill` tool.
- **Agents**: `agents/<name>.agent.md` (`name`, `description`, `tools`). The body becomes the sub-agent's system prompt and `tools:` its whitelist (aliases like `read`, `search`, `edit`, `execute`, `agent` are understood).
- Loaded from the chat's working folder (`.github/`) **plus** your personal `~/.copilot/`; also picks up `copilot-instructions.md` from both.
- **Settings → Skills & agents** lists them **per working folder** (each folder's own `.github/` items) plus a **Personal** entry for `~/.copilot/`, which every folder also loads. A folder's item wins over a personal one with the same name.

## Folder plugins (marketplace)
- Right-click a working folder → **⧉ Plugins…** to browse a plugin marketplace and install plugins **into that folder's `.github/`**, not into your global `~/.copilot/`. Each folder gets only the skills and agents it needs.
- Works with Copilot / Claude-style marketplaces (`.github/plugin/marketplace.json` or `.claude-plugin/marketplace.json`). Plugin sources can be folders inside the marketplace repo, other git repos (`url` / `github`, optionally with a `path`), and skills dirs such as `./.claude/skills`. Agents `*.md` are installed as `*.agent.md`. Hooks, MCP servers and commands are reported but not installed.
- **Marketplaces** tab: add any git URL plus an optional branch, e.g. `https://github.com/github/awesome-copilot` on branch `marketplace`. Private repos use your SSH key, falling back to the HTTPS token from your git credentials.
- Settings live in `.github/supertm.json`, next to `supertm.lock.json`, which records file hashes. The app refuses to overwrite skills you wrote yourself, and uninstall removes only the files the plugin added.
- **Updates**: the app checks every 6 hours and when you open a chat in the folder. A **⬆** badge on the folder means updates are ready; **Update all** applies them. Untick *Check for updates automatically* to turn this off.
- The agent can also manage plugins with the `folder_plugins` tool (status, list, install, uninstall, check/update). Changing anything asks for permission first.
- New plugins show up in **new** chats.

## Chats & organization
- **Working folders** — the sidebar groups chats by folder, Copilot-style. Pick the folder when starting a chat; skills/agents reload per folder.
- **Fork from any turn** — hover a turn → *⑂ Fork from here*. The fork gets the history up to that point and is filed **under the chat it came from** (forks of forks nest).
- **Drag & drop** — drag chats to reorder them (within the same folder/level), drag a chat onto **Bookmarks** or a bookmark folder to pin it, and drag pins/folders to reorder or nest them.
- **Rename & delete** — double-click to rename, or use the ⋯ menu / right-click.
- **Sync sessions** — Settings → *Sync sessions* exports all or some chats to a folder (OneDrive, Google Drive, USB) and, on another Mac, imports the ones you pick. Chats are matched by a unique ID; when one already exists you see how much newer or older the import is and choose **Skip**, **Overwrite local** or **Import as fork** (a copy with a new ID under the local chat).
- **Import from GitHub Copilot and Claude Code** — the same tab reads a Copilot session-state folder (`~/.copilot`) or Claude Code projects (`~/.claude/projects`), lists their chats by folder, and imports the ones you pick as new chats with the full transcript, ready to continue on your own models.
- **Bookmarks** — a pinned section at the top of the sidebar with nestable folders.
- **Resizable sidebar** — drag its edge to resize (double-click resets), drag it past the minimum width or press **⌘B** to hide it, and use ◧ or ⌘B to show it again. The width and the hidden/shown state are remembered.

## Attachments
- **Paste, drop or 📎** — paste screenshots/files (⌘V), drag files anywhere onto the window, or pick them with 📎. Chips show the size before → after and estimated tokens.
- **Images** (PNG, JPEG, GIF, WebP, HEIC, TIFF, BMP): downscaled to a max edge (default 1568 px) and re-encoded (JPEG q82, stepping down until ≤ 1.5 MB). They are sent as `image_url` parts and look the same to the model at a fraction of the size.
- **Documents**: PDF (text per page; scanned PDFs fall back to a page image), Word/RTF/ODT/HTML (via macOS `textutil`), PowerPoint (slide text), Excel (sheet rows), and any plain-text or code file. Text is whitespace-normalized and long files are trimmed head + tail (default 80k chars).
- **Request-size guard**: images are re-sent only for the last N prompts (default 4; older ones become a note), and the oldest images are dropped if a request would exceed the cap (default 20 MB, safely under Vertex's 30 MB). All limits are in Settings → *Attachments*.

## Memory & context
- **Share a session** — export **all turns or selected turns** to Markdown (optionally with tool calls and thinking), save to a file or copy to clipboard.
- **Session memory** — *＋ Memory* gives one chat free-text notes and/or attached `.md` files (e.g. shared chat exports); the agent reads them as prior context every turn. Great for handing work between sessions or people.
- **Folder memory** — right-click a working folder → *Add folder memory…* to give **every chat in that folder** (new and existing) shared notes and files: standing facts, preferences, decisions. Session memory takes precedence when the two conflict. Folder memory travels with export/import and never overwrites existing local folder memory.
- **Smart compaction**: *⇲ Compact* (which also shows the estimated context size) has two modes. **Keep the last N turns** word-for-word and summarize everything before them, or **Choose turns** and set each turn to **Keep · Summarize · Drop**. You can set a turn singly, or set a whole **related-topic cluster** at once (clusters can be non-adjacent when a long chat pivoted and came back). Kept turns can be anywhere in the chat, so an important early instruction stays verbatim. Forks made after a compaction still line up with the right turns. Settings → *Memory compaction* picks a separate (cheaper) **compaction model** and a **cache-aware auto-compact** policy: it waits until the chat has been idle long enough for the provider's prompt cache to expire, unless the chat is very large, and skips small gains (see [doc/memory-compaction.md](memory-compaction.md#91-compaction-and-the-prompt-cache-why-auto-waits)).

## AI usage
- **AI usage panel (⌘⇧U)**: the ring button in the sidebar footer, next to ⚙, opens it. The ring fills against an optional **daily budget** and turns amber at 80% and red at 100%; it shows today's estimated spend.
- **This app**: every model call this app makes, from the main agent and sub-agents, is recorded locally in `supertm.db` as it happens. Each record holds input, cached, cache-write and output tokens. The panel shows totals, cache-hit rate, a per-day chart, and breakdowns **by model** and **by chat** (click a chat to open it). Ranges: today, 7 days or 30 days.
- **Cost estimate**: list prices come from a `pricing.json` (USD per 1M tokens, per model, with dated price changes). It is looked up in Settings, then `~/.supertm/pricing.json`. Without one, the panel shows tokens only.
- **Project tab (optional)**: shows token usage for the whole GCP project, covering every caller and not just this app. It reads Cloud Monitoring directly, signed in with your first Google Vertex AI provider (its service account needs `roles/monitoring.viewer`). About 6 weeks of history.
- **Azure resource tab (optional)**: covers the whole Azure OpenAI resource. It shows token use from Azure Monitor, priced by model, next to the actual **billed** cost from Azure Cost Management. It signs in with `az login` or a service principal set on the Azure provider. See [doc/provider-setup.md](provider-setup.md#4-ai-usage--azure-resource-tab-optional).

## Under the hood
- Electron + React UI over a **headless TypeScript engine** (also usable from a CLI).
- Sessions, forks and bookmarks are stored locally in SQLite (`node:sqlite`) at `~/.supertm/supertm.db`, with settings in `~/.supertm/settings.json`. Set `SUPERTM_HOME` to use another folder. Provider API keys are encrypted with the macOS Keychain (`safeStorage`).
- No telemetry. The only network calls go to the model endpoint you configure (plus Google's OAuth and Cloud Monitoring endpoints when you use a Vertex provider).

## Model providers at a glance

| Kind | What you need | Setup |
|---|---|---|
| **Google Vertex AI** | GCP project, service-account JSON key with `roles/aiplatform.user` (+ `roles/monitoring.viewer` for the Project usage tab), model lines like `anthropic/claude-sonnet-5`, `zai-org/glm-5.2-maas describe` | [Vertex guide](provider-setup.md#google-vertex-ai) |
| **Azure OpenAI** | Resource host `https://<resource>.openai.azure.com`, API key, API version (default `2025-04-01-preview`), one deployment name per line | [Azure guide](provider-setup.md#azure-openai) |
| **Custom endpoint** | Base URL of any OpenAI-compatible `/v1` (streaming + tools) and an API key | [Custom guide](provider-setup.md#custom-endpoint) |

Claude on Vertex streams through Anthropic's endpoint with prompt caching and adaptive thinking; other models use the OpenAI-compatible path, which reads `reasoning_content`, `<think>` tags and Gemini thought parts. Models marked `describe` get images transcribed by a vision model. Internals: [doc/algorithms-and-internals.md §1](algorithms-and-internals.md#1-model-adapter-and-streaming).

