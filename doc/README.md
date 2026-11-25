# Technical documentation

How SuperTM Desktop works inside. Start here, then read the deep dives.

| Doc | What it covers |
|---|---|
| [tutorial.md](tutorial.md) | **Start here.** Illustrated walkthrough: working folders, providers (Vertex + Azure examples), chatting, skills per folder, compaction, AI usage, Sync sessions export/import |
| [agent-framework.md](agent-framework.md) | Agent loop, sub-agents, context passing, request queue, tool calls, permissions, cancellation, system prompt, event model |
| [prompt-queue.md](prompt-queue.md) | Sending while the agent works: the per-chat prompt queue, the step boundary where prompts join, how it syncs with parallel tools, sub-agents and background notifications, races, stop and failure |
| [context-memory.md](context-memory.md) | Context memory: **recall** (the turn index in SQLite, the agent's `recall` tool, recall hints on versus off, cross-chat recall by name), a live capture of the real requests sent to the model, and **compaction** (keep / summarize / drop plans, clustering, summarization, incremental merge, turn map, compaction model, cache-aware auto-compact). |
| [excel.md](excel.md) | Working with Excel without an add-in: the four tools, the round trip between the model and Excel, the live path (Apple events) and the file path (`exceljs`), routing, approval, backups, limits |
| [office.md](office.md) | Working with Word and PowerPoint without an add-in: the twelve tools, addressing by paragraph and slide, editing alongside the user, tracked changes, approval, backups, known gaps |
| [algorithms-and-internals.md](algorithms-and-internals.md) | Model providers and routing (custom endpoint, Azure OpenAI, native Google Vertex AI with service-account auth), adapter and streaming, attachment compression and request budget, persistence and forks, ordering, memory export, usage and cost, shell/sql/web_fetch tools, settings |
| [features.md](features.md) | Feature reference: every feature in detail (moved out of the top-level README) |
| [provider-setup.md](provider-setup.md) | Step-by-step setup of Google Vertex AI (GCP project, service account, roles, model lines), Azure OpenAI (resource host, key, API version, deployments) and custom endpoints; primary provider; troubleshooting |

> [`history/design.md`](history/design.md) and [`history/plan.md`](history/plan.md) are the original MVP spec and plan. They are historical: compaction, attachments, queueing, usage and modes were added later and are documented here.

## Architecture at a glance

```mermaid
flowchart LR
  subgraph Electron main process
    IPC[IPC handlers<br/>src/main/index.ts]
    ENG[Engine<br/>src/engine]
    ST[(SQLite store<br/>supertm.db)]
    ATT[Attachment pipeline]
    USE[Usage ledger]
  end
  R[Renderer - React<br/>src/renderer] <-->|invoke / push events| IPC
  CLI[Headless CLI<br/>src/cli] --> ENG
  IPC --> ENG
  IPC --> ST
  IPC --> ATT
  ENG -->|HTTPS + SSE| P[Model providers<br/>Vertex AI · Azure OpenAI · custom]
  ENG -->|reads| FS[.github/ and ~/.copilot<br/>skills, agents, instructions]
  ENG --> TOOLS[Tools: shell, files, web, sql, ...]
  ENG -- usage events --> USE --> ST
```

Key design decisions:

- **The engine is headless.** `src/engine` has no Electron imports. The desktop app and the CLI both drive it through the same `Session` class and a `Hooks` object (events out, permission/ask questions in). This is why it can be tested without a UI.
- **One conversation per chat, one `Session` object per open chat.** The main agent's message history is a plain OpenAI-style `messages[]` array. Everything else (UI items, sub-agent transcripts) is derived from engine events.
- **Sub-agents are just nested loops** with fresh context; they share the model concurrency limit, the permission gate and the shell manager.
- **The UI is an event fold.** The renderer never asks the engine "what happened"; it folds a stream of `AgentEvent`s into an item tree (`src/renderer/src/state.ts`).
- **Pure functions for the hard parts.** Compaction planning, fork slicing, ordering, attachment sizing and pricing are pure and unit-tested (`tests/`).

## Source map

| Path | Role |
|---|---|
| `src/engine/loop.ts` | One agent's turn loop (model call → tool calls → repeat) |
| `src/engine/engine.ts` | `Session`: history, queue, busy state, compaction entry points |
| `src/engine/manager.ts` | `AgentManager`: agent tree, sync/background sub-agents, notifications |
| `src/engine/prompt.ts`, `registry/` | System prompt, skills, agents, instructions discovery |
| `src/engine/permissions.ts`, `semaphore.ts` | Approval gate, model-call concurrency |
| `src/engine/compact.ts` | Compaction algorithms |
| `src/engine/content.ts` | User content with attachments, request budget (`fitRequest`) |
| `src/engine/adapter/` | OpenAI-compatible / Azure streaming client, native Vertex AI adapter (Anthropic + openapi) and auth, provider router, delta assembler |
| `src/engine/tools/` | Tool implementations and the tool catalog |
| `src/main/` | Electron main: IPC, SQLite store, attachments, settings, usage, data home |
| `src/shared/` | Pure helpers shared by main and renderer (fork, attach, usage, export) |
| `src/renderer/src/` | React UI and the event-to-item fold |

## Data home

Everything lives in `~/.supertm` (override with `SUPERTM_HOME`):

```
~/.supertm/
  supertm.db                  chats, messages, UI items, folders, bookmarks, usage ledger
  settings.json            settings; provider API keys are stored encrypted (providers[].apiKeyEnc, Electron safeStorage)
  pricing.json             optional price table for the usage panel
  sessions/<chat-id>/session.db   the per-chat scratch SQL database used by the `sql` tool
```

Exports ("shares") go to `~/Documents/<app name>/shares` so users can find them. On first launch after the move from the old Electron userData folder, `migrateDataHome` copies the database with `VACUUM INTO` (a consistent snapshot even if the source is in WAL mode).
