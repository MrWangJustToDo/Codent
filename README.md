# Codent

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/codent-cli?label=npm)](https://www.npmjs.com/package/codent-cli)
[![Node](https://img.shields.io/badge/Node-24%2B-339933?logo=node.js)](https://nodejs.org)
[![pnpm](https://img.shields.io/badge/pnpm-9%2B-F69220?logo=pnpm)](https://pnpm.io)
[![TanStack AI](https://img.shields.io/badge/TanStack%20AI-0.68-000000?logo=vercel)](https://tanstack.com/ai)

A **runtime-agnostic** AI coding agent — same core logic, runs in terminal, Chrome extension, or WebContainer playground. Workspace, LLM provider, and agent session are three orthogonal planes; mix local/remote however you want. Built on [TanStack AI SDK](https://tanstack.com/ai).

---

## Why Codent?

| Traditional AI IDEs | Codent |
|---------------------|---------|
| Tied to specific editors | Works with any editor + terminal |
| Cloud black box | Fully local, or remote only what you choose |
| Single interaction mode | Terminal / browser / extension — switch freely |
| Fixed toolset | Skills + Extensions + MCP — extend on demand |

---

## Features

| Category | Description |
|----------|-------------|
| **Multi-Model** | OpenAI, Anthropic, DeepSeek, Ollama, OpenRouter — any LLM provider via model adapter |
| **Terminal UI** | React-powered TUI with Shiki syntax highlighting, a lightweight LiteDiff renderer for message-stream diffs (hunk-highlighted, full/lite toggle via `/settings diff`), streaming markdown, and theme support |
| **Workspace Browser** | Full-screen file tree (`Ctrl+E`) with git status, Seti/Nerd Font icons, scrollable file preview, and HEAD diff view |
| **Chrome Extension** | Full agent UI running in the browser via remote CoreEnv (WXT + HeroUI) |
| **Local / Remote** | Independent planes: workspace (`--remote-env`), LLM provider (`--remote-provider`), Agent Session (`--remote-session`) — all three support HTTP remoting with SSE auto-reconnect |
| **Tool Approval** | Review + approve/deny tool calls (`y` / `n`) with inline diff previews |
| **Ask User** | Agent asks questions with selectable options or freeform answers |
| **Subagents** | Context-isolated read-only tasks (50-step cap) with live `Ctrl+T` preview; eager pre-fork runs parallel tasks concurrently (rolling window), per-task phase machine (`running` → `summary`), streaming progress summaries, and LLM retry status surfaced in the task UI |
| **Skills** | On-demand domain knowledge injection (list → load workflow) |
| **Context Compaction** | `toModelOutput` tool shaping + auto/reactive LLM summarization; compacted-away detail stays in the session log and is reachable via `session_search` |
| **Session Persistence** | Save/resume conversations under `.agents/sessions/` with auto-save |
| **Usage Tracking** | Global per-LLM-call usage history (`/usage`, `.agents/usage/`) with a contribution graph, per-model totals, and cost rollups |
| **Memory** | Automatic cross-session knowledge extraction under `.agents/memory/` |
| **Modes** | `Shift+Tab` cycles Normal → Auto (skip approvals) → Plan; `/mode` for explicit control (`plan` / `auto` / `off`) |
| **Plan Mode** | Explore → review → Build → forced retro (`/mode plan`, persisted under `.agents/plans/`) |
| **Background commands** | `run_command(run_in_background)` plus `get_command_output` / `kill_command` |
| **Telemetry** | Lifecycle telemetry bus bridged to a persisted agent log — a run-scoped event timeline (JSONL under `.agents/logs/<sessionId>/`, size-rotated); hosts subscribe via AgentSession `lifecycle` |
| **Extensions** | Capability model like [Pi](https://pi.dev) — declarative extension modules (tools / commands / hooks); built-ins (LSP, Memory, Skills, MCP) + third-party modules under `.agents/extension` (`Ctrl+Y` panel). See [Extensions](#extensions) |
| **Sandbox** | Isolated command execution with OS-level sandboxing (`@anthropic-ai/sandbox-runtime`) |
| **Code Mode** | Sandboxed TypeScript execution via TanStack `ai-code-mode` — the model can write and run TS in an isolated V8 context with a curated subset of agent tools exposed as `external_*` functions (read-only fs eager, shell/websearch lazy) |
| **MCP Integration** | Connect to external MCP servers for additional tools |
| **LSP / Tree-sitter** | Built-in LSP extension: diagnostics, hover, definition, references, symbols, completions, rename, code actions + structural tree-sitter search/rewrite (`.lsp.json` config) |
| **Web** | Multi-provider search (a configured API key provider — Brave/Exa/Parallel/Tavily — else free providers spread by session across Parallel/Exa, else DuckDuckGo) + page fetch |
| **Devtools** | Built-in [myreact-devtools](https://github.com/MrWangJustToDo/myreact-devtools) for debugging |

---

## Extensions

Codent's extension model works like [Pi](https://pi.dev) (the `pi-lsp` / `pi-*` extension ecosystem): capabilities are delivered as **declarative extension modules** rather than hard-coded feature flags. Each extension registers tools, slash commands, and lifecycle hooks through one `ExtensionAPI` surface, so the same model powers both the built-ins below and third-party modules under `.agents/extension` (browse with `Ctrl+Y`).

### Built-in extensions

| Extension | ID | What it provides | Data / config |
|-----------|----|------------------|---------------|
| **LSP Integration** | `codent-lsp` | 8 LSP tools (`lsp_diagnostics`, `lsp_hover`, `lsp_definition`, `lsp_references`, `lsp_symbols`, `lsp_rename`, `lsp_completions`, `lsp_code_actions`) + 3 tree-sitter tools (`code_overview`, `ast_search`, `code_rewrite`) + commands `/lsp`, `/lsp-restart`, `/lsp-config`; auto file-sync and diagnostics injection | `.lsp.json` |
| **Memory** | `codent-memory` | `memory_list`, `memory_read`, `memory_write`; MEMORY.md index injected into turn context | `.agents/memory/` |
| **Skills** | `codent-skills` | `list_skills`, `load_skill`; available-skills index injected into turn context | `.agents/skills/` |
| **MCP** | `codent-mcp` | Connect external MCP servers (stdio/SSE/HTTP); each tool exposed as `mcp__<server>_<tool>` + `/mcp` status command; per-server failure isolation | `.agents/mcp.json` (fallback `.mcp.json`) |
| **Code Mode** | `codent-code-mode` | `execute_typescript` (run model-written TS in a secure V8 isolate via `isolated-vm`) + `discover_tools` (lazy-tool discovery); sandbox exposes a curated subset of agent tools as `external_*` — read-only fs (`read_file`/`grep`/`glob`/`list_file`/`tree`) eager, shell (`run_command`) + `websearch` lazy; injects code-mode system prompt each turn. Requires the host to provide a CoreEnv `createIsolateDriver` (Node host does; degrades gracefully when absent) | — (Node host built-in) |

Beyond the built-ins, drop your own extension modules into `.agents/extension` (hooks, custom tools, slash commands), or point the `codent-mcp` built-in at external MCP servers for more tools.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Runtime Hosts                                              │
│  ┌────────────┐  ┌──────────────────┐  ┌─────────────────┐  │
│  │ cli (TUI)  │  │ extension (WXT)  │  │ playground      │  │
│  └──────┬─────┘  └────────┬─────────┘  └────────┬────────┘  │
│         │   AgentAdapter   │                     │          │
│  ┌──────┴──────────────────┴─────────────────────┴───────┐  │
│  │  @codent/app  (Session-only UI, hooks, commands)    │  │
│  └──────────────────────────┬────────────────────────────┘  │
│                             │  AgentSession                 │
│  ┌──────────────────────────┴────────────────────────────┐  │
│  │  @codent/core  (agent loop, tools, models, MCP)     │  │
│  └──────────────────────────┬────────────────────────────┘  │
│                             │                              │
│   ┌─────────────┐  ┌────────┴───────┐  ┌───────────────┐   │
│   │  CoreEnv    │  │  ModelProvider │  │  AgentSession │   │
│   │  workspace  │  │  LLM plane     │  │  agent plane  │   │
│   │ (node/http) │  │ (direct/http)  │  │ (local/http)  │   │
│   └──────┬──────┘  └────────┬───────┘  └───────┬───────┘   │
│          └──────────────────┴──────────────────┘           │
│                            │ Hono RPC                      │
│  ┌─────────────────────────┴────────────────────────────┐  │
│  │  @codent/server (uses @codent/node)              │  │
│  │  /api/env · /api/fs · /api/command · /api/fetch ·    │  │
│  │  /api/provider · /api/agent                          │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Three Planes — Workspace · LLM · Agent Session

Hosts talk to the agent through three **independent, orthogonal planes**. Each can run locally or be proxied through `@codent/server` (`pnpm start:server`, default `:3100`). On the CLI client, `--remote-env` and `--remote-provider` combine freely, but `--remote-session` is **exclusive** — see [Combinations](#combinations) for the boundary rules.

| Plane | Local | Remote (HTTP) |
|-------|-------|---------------|
| **Workspace** — CoreEnv (fs, shell, fetch, platform) | `createNodeEnv()` (`@codent/node`) | `createRemoteEnv(url)` → `/api/env · /api/fs · /api/command · /api/fetch` |
| **LLM** — ModelProvider (model keys / baseURL) | `createDirectModelProvider()` (host-held keys) | `createRemoteProvider(url)` → `/api/provider/*` (keys on server) |
| **Agent** — AgentSession (messages, todos, approvals, plan) | `createLocalAgentSessionHost()` (in-process) | `createRemoteAgentSessionHost(url)` → `/api/agent` (REST + SSE) |

### CoreEnv — Workspace Plane

`CoreEnv` is the central interface that decouples `@codent/core` from any specific runtime. All filesystem, shell, fetch, and platform APIs go through it — making the core truly runtime-agnostic.

| Implementation | Package | Use Case |
|:--------------|:--------|:---------|
| `createNodeEnv()` | `@codent/node` | Local workspace — Node.js APIs with optional OS sandbox |
| `createRemoteEnv(url)` | `@codent/server` (client) | Remote workspace (`--remote-env` / `REMOTE_ENV`) — Hono RPC to a CoreEnv server |

### ModelProvider — LLM Plane (orthogonal to CoreEnv)

LLM credentials are **not** part of CoreEnv — the workspace and the model keys are separate planes, so local/remote workspace and local/remote keys combine freely. Remote mode re-forces `baseURL`/`apiKey` from the server (so upstream URLs cannot bypass) and `/api/env/vars` strips `API_KEY` / `*_API_KEY`.

| Implementation | Package | Use Case |
|:--------------|:--------|:---------|
| `createDirectModelProvider()` | `@codent/core` | Local LLM keys / baseURL (default) |
| `createRemoteProvider(url)` | `@codent/server` (client) | Remote LLM provider (`--remote-provider` / `REMOTE_PROVIDER`) — keys live on the server, requests proxied through `/api/provider/*` |

### AgentSession — Agent Loop Plane

The agent loop and its full session state (messages, queued messages, todos, approvals, plan, usage) can run in-process or on the server. The UI stays **Session-only** either way — hosts talk to an `AgentSession` interface and never touch the loop directly.

- **Local (default):** `createLocalAgentSessionHost()` — an in-process `AgentManager` + `ManagedAgent` running against the registered CoreEnv and provider.
- **Remote (`--remote-session` / `REMOTE_SESSION`):** `createRemoteAgentSessionHost(url)` — commands go over REST (`POST /api/agent/:id/command`) and the loop streams back via SSE (`/api/agent/:id/events`) with a snapshot cache and auto-reconnect (plus tool-buffer and summary-stream remounting). The loop then runs server-side against the server's own registered workspace/keys.

**One session per runtime.** A runtime holds exactly one live root session; multiple sessions mean multiple runtimes (each with its own `CodentAgent`). `/clear` `/clone` `/fork` branch the live agent to a new on-disk session (they swap the conversation, not the runtime). On the core side, `AgentManager` maintains a process-local ownership registry (`Map<sessionId, agentId>`): a disk session already bound to one live agent is **rejected** when another tries to `restore` it, and `startNewDiskSession`/`destroyAgent` release that ownership. `AgentSessionListEntry` carries a `sessionId` so `/resume` can mark entries as `bound (active)`.

`--remote-session` is **exclusive on the client**: the agent loop runs server-side, so a single CLI cannot also proxy a remote workspace (`--remote-env`) or remote keys (`--remote-provider`). To use local LLM settings on the remote server, pass them with `--model <id>`; the **server** itself may register its own `REMOTE_ENV` / `REMOTE_PROVIDER` to run against an even further workspace/provider.

### Combinations

Client planes combine per the boundary rules below; every row is a working configuration. `--remote-session` cannot be combined with `--remote-env` / `--remote-provider` on the same CLI:

| CoreEnv | Provider | Agent Session | Host | Notes |
|---------|----------|---------------|------|-------|
| local (`createNodeEnv`) | direct | local | CLI | Fully working (default) |
| remote (`--remote-env`) | remote | local | CLI | Workspace + keys on server |
| local | remote (`--remote-provider`) | local | CLI | Local workspace, keys on server |
| remote (`--remote-env`) | direct | local | CLI | Workspace on server, local keys |
| local | direct | remote (`--remote-session`) | CLI | Agent loop on server; push local LLM settings with `--model`; SSE auto-reconnect |
| remote | remote or direct | local or remote | Chrome | Extension requires a running server |
| WebContainer | direct or remote | local | Browser | Playground (CORS / fetch proxy for web tools) |

> The boundary is on the **CLI client**. A server (`pnpm start:server`) may itself register `REMOTE_ENV` / `REMOTE_PROVIDER` to front an even further workspace/provider — this is how a `--remote-session` server chains remote planes without violating client exclusivity.

### Package Overview

| Package | Description |
|---------|-------------|
| `@codent/core` | Runtime-agnostic core: `ManagedAgent`, AgentSession, tools, models, MCP, skills, memory, compaction, telemetry |
| `@codent/app` | Shared UI: React components, hooks, commands. **Session-only** for agent control |
| `@codent/cli` | Terminal host using [@my-react/react-terminal](https://github.com/MrWangJustToDo/MyReact) |
| `@codent/acp` | Agent-side Agent Client Protocol host — serves the agent over ACP (stdio) for editors and ACP→IM bridges; bundled into the release `codent acp` |
| `@codent/node` | Node.js CoreEnv: native filesystem, shell, OS sandbox |
| `@codent/server` | CoreEnv HTTP + provider proxy + Agent Session routes + type-safe clients |
| `@codent/extension` | Chrome extension host (WXT); requires a running server |
| `@codent/playground` | In-browser WebContainer host (Vite); see [packages/playground/README.md](packages/playground/README.md) |
| `@codent/mcp-server` | Standalone MCP server for external tool integration |

> **Deep dive:** See [AGENTS.md](AGENTS.md) for full architecture, code conventions, and detailed guidelines. See [packages/core/ARCHITECTURE.md](packages/core/ARCHITECTURE.md) for the core runtime startup, initialization, session, memory, compaction, and approval flows.

---

## Screenshots

### Welcome Screen

Default and alternate theme on the idle screen. Header shortcuts: `/` commands, `Shift+Tab` cycle mode, `Ctrl+E` workspace, `Ctrl+T` task panel, `Ctrl+Y` extensions, `Esc` abort.

![Welcome — default theme](start-default.png)
![Welcome — alternate theme](start-theme.png)

### Slash Commands

Type `/` to open the command palette with autocomplete (`/help`, `/mode`, `/compact`, `/resume`, `/usage`, …).

![Slash commands](command.png)

### Tool Flow & Approval

Agent tool calls with inline status, approval prompts (`y` / `n`), and token/cost tracking in the status bar.

![Tool flow and approval](tool-flow.png)

### Ask User

Interactive questions with arrow-key selection, multi-select toggles, and optional freeform answers.

![Ask user](ask-user.png)

### Code Edits with Diff View

`edit_file` / `write_file` tool previews render inline through the **LiteDiff** renderer — whole-file add/delete collapse the gutter, and hunk regions are highlighted for accurate multi-line syntax. Approve / deny a pending edit with **y** / **n**. Toggle the renderer at runtime with `/settings diff` (`lite` hunk rows vs `full` git-diff-view Split/Unified). For interactive diff scrolling, open the workspace browser (`Ctrl+E`) and use the **Diff vs HEAD** view (**↑↓** scrolls when the right pane is focused).

![Edit diff view](edit-diff.png)

### Markdown Rendering

Streaming markdown with syntax-highlighted code blocks in the message stream.

![Markdown rendering](markdown.png)

### Task & Subagents

Spawn read-only subagents via the `task` tool. Open the task panel with `Ctrl+T` to inspect live runs and summaries.

![Task in main chat](task-main.png)
![Task panel — live run](task-stream.png)
![Task panel — completed summary](task-view.png)

### Task Panel

Press `Ctrl+T` to open the task panel and inspect live subagent runs and completed summaries.

![Task panel](task-panel.png)

### Plan Mode

Plan Mode (`/mode plan`, `Shift+Tab`) — explore → review → Build → forced retro. Preview plans before execution and track progress with the todo list.

![Plan — review mode](plan-mode.png)
![Plan — building](plan-build.png)
![Plan — preview](plan-preview.png)

### Context Compaction

Auto/reactive LLM summarization compresses the conversation into a streaming summary. Compaction only appends the summary — the compacted-away messages remain in `.agents/sessions/` and are reachable through the `session_search` / `session_read` tools.

![Compact — summary stream](compact.png)

### Workspace Browser

Press `Ctrl+E` for a full-screen workspace panel: file tree with git status badges, scrollable **Preview** (`CodeView`), and **Diff vs HEAD** (`DiffView`). **Tab** toggles preview/diff; **←→** moves focus; **↑↓** scrolls; **R** refreshes.

![Workspace — file preview](workspace-file.png)
![Workspace — git diff](workspace-diff.png)

### Devtools Debug

Built with [myreact-devtools](https://github.com/MrWangJustToDo/myreact-devtools) powered by [@my-react framework](https://github.com/MrWangJustToDo/MyReact)

![Devtools debug 1](devtools-debug-1.png)
![Devtools debug 2](devtools-debug-2.png)

### Playground

Check the link https://mrwangjusttodo.github.io/Codent/, you can create your own site
![Playground start](playground-start.png)
![Playground end](playground-end.png)
![Playground devtool](playground-devtool.png)

---

## Quick Start

### Install from npm (CLI)

Install the CLI globally and run it in any directory:

```bash
npm install -g codent-cli

codent                                 # start in the current directory
codent "Explain this codebase"          # start with a prompt
codent --version                        # print installed version
```

> Published as **`codent-cli`** on npm (the command is still `codent`). Currently a
> **pre-release** — `0.0.1-beta.5`. Requires **Node.js 24+**.

**Editor integration (ACP).** `codent acp` serves the agent over the
[Agent Client Protocol](https://agentclientprotocol.com) on stdio, so editors such as Zed or
JetBrains drive it directly. It is headless — stdout carries only JSON-RPC frames — and an ACP
client must spawn it with **cwd = the workspace root**. See
[packages/codent/README.md](packages/codent/README.md#agent-client-protocol-acp).

Runtime data (sessions, memory, plans, …) is written to `./.agents/` in the directory you run from.

### From source

#### Prerequisites
- Node.js 24+, pnpm 9+

```bash
git clone https://github.com/MrWangJustToDo/Codent.git
cd Codent
pnpm install
pnpm build
```

### Configuration

Create `.env` in the root:

```bash
# Provider: openai | anthropic (or any OpenAI-compatible gateway)
MODEL_STYLE=openai
BASE_URL=https://api.deepseek.com
API_KEY=sk-your-key-here
MODEL=deepseek-v4-flash

# Optional: unified model config (.agents/config/models.json) replaces the
# MODEL_* env vars — global settings + multiple provider entries + active
# selection; /models switches the active entry/model at runtime.

# Optional MODEL_* metadata overrides (name, context window, pricing, capabilities, …)
# See packages/cli/src/model-env.ts

# Sandbox: native (no sandbox) | local (OS sandbox)
SANDBOX_ENV=native

# Optional websearch (no key required — free providers are used and spread by session)
# BRAVE_API_KEY=...        # Brave Search API (keyed)
# EXA_API_KEY=...          # Exa keyed tier (free public MCP without it)
# PARALLEL_API_KEY=...     # Parallel keyed tier (free public MCP without it)
# TAVILY_API_KEY=...       # Tavily (has no free tier — required to use it)
# WEBSEARCH_PROVIDER=brave # pin one: brave | parallel | exa | tavily | duckduckgo | auto

# Remote planes (CLI: --remote-env and --remote-provider combine freely;
# --remote-session is exclusive — cannot be combined with the other two.
# A server may register its own REMOTE_ENV / REMOTE_PROVIDER.)
# REMOTE_ENV=http://localhost:3100
# REMOTE_PROVIDER=http://localhost:3100
# REMOTE_SESSION=http://localhost:3100

SERVER_PORT=3100
```

Runtime data (sessions, usage history, memory, logs, cache, plans, skills, extensions, MCP config, unified model config) lives under a single gitignored **`.agents/`** directory. See [AGENTS.md — Workspace `.agents/` layout](AGENTS.md#workspace-agents-layout).

### Running

```bash
# Terminal CLI (local workspace + local keys)
pnpm start:cli

# Start with a prompt
pnpm start:cli -- "Explain this codebase"

# Remote workspace (CoreEnv HTTP)
pnpm start:cli -- --remote-env http://localhost:3100

# Remote LLM keys only (local workspace)
pnpm start:cli -- --remote-provider http://localhost:3100

# Remote Agent Session (agent loop runs server-side; SSE auto-reconnect).
# Exclusive on the client: do NOT combine with --remote-env / --remote-provider.
# Push local LLM settings to the server with --model <id> instead.
pnpm start:cli -- --remote-session http://localhost:3100

# Server-side remote planes: a server may itself register a remote CoreEnv
# (REMOTE_ENV) to front an even further workspace (server-side REMOTE_PROVIDER
# forwarding is planned).
REMOTE_ENV=http://localhost:3200 pnpm start:server

# Continue last session / pick a session
pnpm start:cli -- --continue
pnpm start:cli -- --resume

# CoreEnv + provider + Agent Session HTTP server (required for extension / remote CLI)
pnpm start:server

# Browser extension dev server
pnpm dev:extension

# In-browser playground (WebContainer)
pnpm dev:playground

# MCP server
pnpm start:mcp-server
```

### IM (through ACP)

Codent reaches chat platforms through an **external ACP client** — the same stdio surface an editor
uses. The supported recipe is [cc-connect](https://github.com/chenhg5/cc-connect):

```bash
npm i -g codent-cli cc-connect
# configure the project + platforms from docs/cc-connect.example.toml, then:
cc-connect
```

cc-connect owns the platform connections (Telegram, Feishu/Lark, DingTalk, WeCom, Slack, Discord,
QQ, …), access control and delivery; `codent acp` owns the agent. There is no Codent-specific IM
bridge. See [docs/acp-im.md](docs/acp-im.md) and
[docs/cc-connect.example.toml](docs/cc-connect.example.toml).

---

## Tools

| Category | Tools |
|----------|-------|
| **File** | `read_file`, `write_file`, `edit_file`, `delete_file`, `glob`, `grep`, `tree`, `list_file` |
| **System** | `run_command`, `get_command_output`, `kill_command` |
| **Web** | `websearch` (a configured keyed provider — Brave / Exa / Parallel / Tavily — else free providers spread by session across Parallel / Exa, else DuckDuckGo), `webfetch` |
| **Agent** | `task` (subagents), `ask_user`, `todo` |
| **Skills** | `list_skills`, `load_skill` |
| **Memory** | `memory_list`, `memory_read`, `memory_write` |
| **LSP** | `lsp_diagnostics`, `lsp_hover`, `lsp_definition`, `lsp_references`, `lsp_symbols`, `lsp_completions` (plus `lsp_rename` / `lsp_code_actions` / `ast_search` / `code_rewrite` / `code_overview` when enabled) |
| **Plan** | `create_plan`, `update_plan`, `complete_plan` (offered only in the matching plan phase) |

---

## Workspace Browser

Open with **`Ctrl+E`** from the main CLI (toggle close with `Ctrl+E` or `Esc`).

| Key | Action |
|-----|--------|
| `←` `→` | Move focus between file tree and preview/diff pane |
| `↑` `↓` | Navigate tree, or scroll preview/diff when right pane is focused |
| `Enter` / `→` | Expand directory or open file for preview |
| `Tab` | Toggle **Preview** ↔ **Diff vs HEAD** |
| `R` | Refresh tree, git status, and file/diff caches |
| `Esc` | Close workspace |

The file tree shows git porcelain status (`M`, `?`, `D`, …), Seti/Nerd Font file icons (disable with `MY_AGENT_NERD_ICONS=0`), and chevron + folder icons for expanded/collapsed directories.

---

## CLI Keyboard Shortcuts

Global shortcuts (from the header):

| Key | Action |
|-----|--------|
| `/` | Open slash-command autocomplete |
| `Shift+Tab` | Cycle mode: Normal → Auto → Plan |
| `Ctrl+E` | Toggle workspace browser |
| `Ctrl+T` | Open task / subagent panel |
| `Ctrl+Y` | Open extensions panel |
| `Ctrl+V` | Paste image from clipboard |
| `Esc` | Abort run / dismiss panels (context-dependent) |

The CLI has **4 input modes** — shortcuts adapt to the current mode:

| Key | Normal | Approval | Select (Ask User) | Freeform |
|-----|--------|----------|-------------------|----------|
| `Enter` | Submit | Submit command | Confirm selection | Submit |
| `Esc` | Dismiss autocomplete / Abort | Cancel deny reason | Close list | Go back |
| `y` / `n` | — | Approve / Deny pending tool call | — | — |
| `↑` `↓` | History / Autocomplete | Autocomplete / Command-output scroll | Navigate options | — |
| `Space` | — | — | Toggle (multi-select) | — |
| `Tab` | Accept autocomplete | Accept autocomplete | — | — |
| `Ctrl+V` | Paste image | — | — | — |
| `Ctrl+C` | Exit | Exit | Exit | Exit |

Slash commands: `/help` (shortcuts + commands merged), `/mode`, `/compact`, `/clear`, `/rename`, `/resume`, `/usage`, `/settings` (theme · display · diff · model config), `/models`, `/effort`, `/quit` — plus extension commands: `/mcp`, `/skill [name]`, `/memory [name]`, `/lsp`, `/lsp-restart`, `/lsp-config`

---

## Development

```bash
pnpm dev          # Watch all packages
pnpm typecheck    # TypeScript check
pnpm lint         # ESLint
pnpm format       # Prettier
pnpm build        # Production build (core → app → rest)
pnpm clean        # Remove build artifacts
```

> **Note:** There is no shared test runner. Packages use focused `validate:*` scripts plus `pnpm typecheck` and package builds. See [AGENTS.md — Task Completion Checklist](AGENTS.md#task-completion-checklist).

### Build Order

`@codent/core` → `@codent/app` → `cli` / `node` / `server` / `extension` / `playground`. Handled automatically by `pnpm build`.

> **Code style:** ESM-only with `.js` imports, double quotes, semicolons, 2-space indent, 120-char width, Zod v4 schemas, `workspace:*` deps — see [CLAUDE.md](CLAUDE.md).

---

## Reference Documentation

| Document | Description |
|----------|-------------|
| [CLAUDE.md](CLAUDE.md) | Quick reference for AI coding agents working in this repo |
| [AGENTS.md](AGENTS.md) | Full architecture, code conventions, and detailed guidelines |
| [packages/core/ARCHITECTURE.md](packages/core/ARCHITECTURE.md) | Core runtime deep-dive: startup, session, compaction, approval |
| [packages/app/README.md](packages/app/README.md) | App Session-only import allowlist |
| [packages/acp/README.md](packages/acp/README.md) | ACP agent host: coverage, model/mode selectors, IM usage |
| [docs/acp-im.md](docs/acp-im.md) | ACP → IM integration recipe (cc-connect) |
| [docs/cc-connect.example.toml](docs/cc-connect.example.toml) | cc-connect example configuration for `codent acp` |
| [packages/playground/README.md](packages/playground/README.md) | WebContainer playground + GitHub Pages deploy |

---

## License

MIT © [MrWangJustToDo](https://github.com/MrWangJustToDo)

Built with [@my-react framework](https://github.com/MrWangJustToDo/MyReact), [TanStack AI SDK](https://tanstack.com/ai), and [Ollama](https://ollama.ai)
