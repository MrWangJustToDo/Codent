
# AGENTS.md - AI Agent Guidelines

This file provides guidelines for AI coding agents working in this repository.

## Project Overview

A pnpm monorepo with ten packages organized in a layered architecture.

**Core runtime deep-dive:** [packages/core/ARCHITECTURE.md](packages/core/ARCHITECTURE.md) — startup, initialization, session/memory/compaction/approval flows.

| Package | Role |
|---------|------|
| `@codent/core` | Runtime-agnostic core: shared managed run, agent loop, tools, LLM model factory, CoreEnv interface |
| `@codent/app` | Shared UI layer: React components, hooks, commands, AgentAdapter interface. **Session-only** for agent control; a UI runtime conventionally binds one live root session (a second session means a second app runtime, not a second app-store entry). The underlying manager/server catalog may hold multiple roots. Reads the workspace env from a host-supplied `CoreEnvProvider` (never ambient `getEnv()`). See [`packages/app/README.md`](packages/app/README.md) import allowlist |
| `@codent/cli` | Terminal host — thin shell that registers CoreEnv and renders `@codent/app` |
| `@codent/node` | Node.js CoreEnv implementation: native filesystem, shell, OS sandbox |
| `@codent/server` | CoreEnv HTTP server (Hono RPC) + remote client factory |
| `@codent/extension` | Chrome extension host using WXT framework |
| `@codent/playground` | In-browser WebContainer host (Vite) |
| `@codent/mcp-server` | MCP server for external tool integration |
| `@codent/acp` | Agent-side Agent Client Protocol host. Serves an `AgentSessionHost` over ACP (stdio) via `@agentclientprotocol/sdk`, so editors (Zed/JetBrains) and ACP→IM bridges drive the agent without host-specific code. `codent acp` / `codent-acp` entry; also used in-process (`createAcpAgent`). Subagents are projected when the client advertises `subagents` (`subagent_update` + child transcripts + formatted task results). See `packages/acp/README.md`. |
| `codent-cli` | **Release host.** Local-only terminal CLI (no remote planes) published as one fully bundled, self-contained tarball — `@codent/app` / `core` / `node` / `acp` are inlined, so no sibling has to be on the registry. The npm name is `codent-cli` (plain `codent` is rejected as too similar to `code` / `dedent`); the installed command is still `codent`. `codent acp` serves ACP over stdio. See `packages/codent/tsdown.config.ts`. |

## Architecture

### Layered Design

```
┌─────────────────────────────────────────────────────────┐
│  Runtime Hosts                                          │
│  ┌──────────────────┐  ┌────────────────────────────┐   │
│  │  @codent/cli   │  │  @codent/extension       │   │
│  │  (Ink terminal)  │  │  (WXT Chrome extension)    │   │
│  └────────┬─────────┘  └─────────────┬──────────────┘   │
│           │     AgentAdapter          │                  │
│           │  (+ playground WebContainer host)            │
│  ┌────────┴───────────────────────────┴──────────────┐   │
│  │  @codent/app  (Session-only UI, hooks, commands)│   │
│  └────────────────────────┬──────────────────────────┘   │
│                           │  AgentSession                │
│  ┌────────────────────────┴──────────────────────────┐   │
│  │  @codent/core  (agent loop, tools, CoreEnv)     │   │
│  └────────────────────────┬──────────────────────────┘   │
│                           │  CoreEnv interface           │
│  ┌────────────────────────┴──────────────────────────┐   │
│  │  CoreEnv Adapter Layer                            │   │
│  │  ┌──────────────────┐  ┌────────────────────────┐ │   │
│  │  │ @codent/node   │  │ @codent/server       │ │   │
│  │  │ (local Node.js)  │  │ (remote HTTP client)   │ │   │
│  │  └──────────────────┘  └───────────┬────────────┘ │   │
│  └────────────────────────────────────┼──────────────┘   │
│                                       │ Hono RPC         │
│  ┌────────────────────────────────────┴──────────────┐   │
│  │  @codent/server (HTTP server, uses @codent/node)  │
│  └───────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### CoreEnv — Runtime Abstraction

`CoreEnv` is the central abstraction that decouples `@codent/core` from any specific runtime. All filesystem, shell, fetch, and platform APIs go through this interface.

```typescript
interface CoreEnv {
  rootPath: string;                // Workspace root
  path?: CoreEnvPath;              // Synchronous path utilities (defaults to pathe/POSIX)
  getPlatform(): Promise<string>;  // Async — may query remote server
  getArch(): Promise<string>;
  getEnv(): Promise<Record<string, string | undefined>>;
  homedir(): Promise<string>;
  fs: CoreEnvFs;                   // Filesystem operations
  runCommand(cmd, opts?): Promise<CommandResult>;
  exec(cmd, opts?): Promise<CoreEnvExecResult>;   // Free-text command through a shell
  fetch(input, init?): Promise<Response>;
  destroy?(): Promise<void>;       // Lifecycle cleanup
  // Optional, defaulted: cwd() (-- the directory commands run in; defaults to rootPath),
  //                      byteLength, base64Encode/Decode, path
  // Optional, feature-gated (absent = the feature degrades, never throws):
  //   execFile (argv-shaped, no shell), startCommand, getShellInfo, commandExists,
  //   readFileRange, appendFile / rename / appendFileSync / mkdirSync / existsSync,
  //   getMimeType, resizeImage, imageToText (image → terminal text rows, optionally a
  //   source-pixel window for zoom/pan, for the workspace preview pane; absent = the panel keeps
  //   its "binary file" placeholder),
  //   locateTreeSitterGrammar,
  //   createMCPStdioTransport, getMCPTransportProcess, createLspConnection,
  //   createIsolateDriver (code-mode TS sandbox backend)
  // Capability marker (not a feature): `remote?: boolean` — true when fs/commands live in another
  // process (`createRemoteEnv`). `loadExtensions` skips DISK discovery for it, because those files
  // are discovered through the remote fs and then `import()`ed in the client process; in-process
  // `config.extensions` and the built-ins still load.
}
```

**Registry pattern:**
```typescript
import { registerCoreEnv, getEnv, clearCoreEnv, hasCoreEnv } from "@codent/core";

registerCoreEnv(env);   // Set the global CoreEnv (must be called before any core usage)
getEnv();               // Get resolved env with defaults applied
clearCoreEnv();         // Clear the registry (call on disconnect/destroy)
hasCoreEnv();           // Check if registered
```

> **Prefer `CodentAgent` over the ambient registry.** `registerCoreEnv()` / `registerModelProvider()` install the *ambient* runtime — the compatibility surface for scripts and code without a runtime in scope. Hosts should build a `CodentAgent` instead (`CodentAgent.create({ env, provider | direct, host? })`) and drive sessions through its `host`; the runtime carries its own `env` + `modelProvider`, so several runtimes (different workspaces / keys / local vs remote) coexist in one process. `getEnv()` / `getModelProvider()` and the ambient `agentManager` are **deprecated for hosts** — ambient-only fallbacks, not the path a host should build on.

**Implementations:**
- `createNodeEnv()` from `@codent/node` — local Node.js APIs, optional OS sandbox
- `createRemoteEnv(url)` from `@codent/server/client` — HTTP RPC to a remote CoreEnv server

### ModelProvider — LLM plane (orthogonal to CoreEnv)

LLM credentials are **not** part of CoreEnv. Hosts register a `ModelProvider` separately so local/remote workspace and local/remote keys combine freely. The provider is carried on the runtime: pass it to `CodentAgent.create({ provider })` (or `{ direct }`), and model resolution reads it back through the runtime — `resolveModelConfigFromProvider(input, provider?)` takes the runtime's provider and only falls back to the ambient registry when none is passed. `CodentAgent.getModelProvider()` exposes the runtime's provider (surfaced to the app as the `AgentRuntimePort` it consumes) so `createAgentSessionFromConfig` resolves per runtime (remote-session runtimes omit it).

**models.dev is the documented ambient-env exception on the provider-metadata path; side-query usage history is the other one.** `provider/models-dev.ts` reads `getEnv()` (not a runtime-injected env): the dataset is identical across workspaces, so the in-memory memo is process-global and there is no runtime in scope. `models/config/models-config.ts` no longer belongs on that list: it takes the owning runtime's env (callers pass it) and falls back to ambient only when none is supplied. The guard allowlists **only `provider/models-dev.ts`** and scans `models/`, `runtime/`, `agent-session/`, `agent/usage/` and `agent/code-mode/` too, so a new ambient read on those paths fails instead of passing unseen. Residual: `sharedUsageHistory` in `runSideTextQuery` still files side-query records under the ambient workspace — an attribution problem, not a correctness one, recorded here rather than hidden. Consequence: its disk cache (`<root>/.agents/cache/models-dev.json`) is workspace-scoped and follows the **ambient** root — harmless for the single-runtime hosts (CLI / ACP), and the one place a second runtime in a process would bind to the last-registered env. The cache lives on the CoreEnv plane and is orthogonal to the provider plane: with `--remote-provider` and a local workspace, models.dev is fetched/cached **locally**; the provider server's `/api/provider/info` carries only the connection (`mode`/`style`/`model`/`basePath`), no metadata. The lookup is best-effort (`resolveModelConfig` catches it), so a models.dev failure just leaves `modelInfo` unset.

```typescript
import { CodentAgent, createDirectModelProvider } from "@codent/core";
import { createRemoteProvider } from "@codent/server/client";

const agent = await CodentAgent.create({
  env,
  provider: createDirectModelProvider({ model, style, baseURL, apiKey }),
  // or: provider: await createRemoteProvider("http://localhost:3100"),
});
// Ambient compatibility (scripts / no runtime in scope):
//   registerModelProvider(createDirectModelProvider({ ... }));
```

| Flag / Env | Plane | Client boundary |
|------------|--------|-----------------|
| `--remote-env` / `REMOTE_ENV` | CoreEnv workspace | combines freely with `--remote-provider` |
| `--remote-provider` / `REMOTE_PROVIDER` | Remote model provider | combines freely with `--remote-env` |
| `--remote-session` / `REMOTE_SESSION` | Remote Agent Session | **exclusive** — cannot combine with the other two on one client; use `--model <id>` to push local LLM settings to the server |

The exclusivity is a **client** rule: a server (`pnpm start:server`) may itself register `REMOTE_ENV` (remote workspace; `REMOTE_PROVIDER` forwarding planned) so a `--remote-session` server chains further remote planes.

`createAgentSessionFromConfig` uses `resolveModelConfigFromProvider()` with the runtime's `getModelProvider()` (the runtime's provider; ambient only for runtimes that omit it). All hosts share one model-config pipeline (`models-config.ts`): a local `.agents/config/models.json` (file), a remote provider (`/api/provider/info`), or a remote-session server (`/api/agent/models`) — `/models` switches the active entry/model (and, since the merge, its thinking depth). Remote mode forces `baseURL`/`apiKey`/`style` from the provider (re-forced after models.dev so upstream URLs cannot bypass) but **not the model**: the provider supplies the *catalog* and the client chooses from it — the same contract the proxy states on its side, where a request's model is validated against the server's allowlist and refused (`model_not_allowed`) instead of rewritten, because a silent substitution has the client believing it talks to model A while the server answers as B. One rule decides the winner everywhere (`selectModel`, `models/config/model-selection.ts`): a requested model the catalog advertises is kept; a requested model it does not offer falls back to the served model (`/api/provider/info.model`, i.e. the server's `MODEL` env) **and reports the substitution** (`modelFallback` from bootstrap, a `warn` on resume); a request that cannot be checked (no catalog, or a plane that advertises none) is trusted, since "we could not verify" is not evidence the client is wrong. `loadModels` reports `active.model` by the same rule, so the displayed model (footer / help / `/models` "(current)") is the one the adapter sends; `ManagedAgent.applyPersistedModel` resumes on a persisted model while the runtime catalog still offers it and otherwise keeps the model the session was created with (never the persisted *style* — the proxy owns it). The serving side keeps the same invariant — `/api/provider/info` advertises the served model first and as `active`, `/api/agent/models` always offers the server's `.env` model, and the served model is always in the catalog, so a fallback is always a legal request. Validate: `pnpm --filter @codent/core run validate:provider-model-list`, `validate:resolve-from-provider`, `validate:model-selection`, `validate:session-model-persistence`. `/api/env/vars` strips `API_KEY` / `*_API_KEY`. The footer prints the model id; the remote PLANES are shown in the Header (`remotePlanesFromConfig` → `remote-env` / `remote-provider` / `remote-session`), and `providerMode` itself is only surfaced in `/help`. Explicit model flags (`--model` / `--style` / `--base-url` / `--api-key`) set `AppConfig.modelExplicit`, which **isolates** the session from the on-disk `models.json` — `initConfig` skips loading it (so the flags are authoritative and `/models` lists nothing) and the first-run config editor is skipped; remote provider/session hosts keep their server-owned list, and a flag naming a model that server does not advertise falls back to the served one (`selectModel`).

The server's **create** route keeps that authority in the other direction. A request that names a model with no **usable** connection — no `apiKey`, and either no `baseURL` or the provider default (`resolveModelConnection` always fills `https://api.openai.com/v1` for openai style) — is resolved against the server's own `models.json` entry or `.env` (`resolveServerModelConnection`), the same helper `model.set` uses. It used to trust the request's connection fields, so `--remote-session --model X` with no local key shipped that default URL with an empty key and overrode the server's provider (401 on the first request). A request that carries an `apiKey`, or a `baseURL` the user actually chose, is a direct-provider client and keeps its own credentials — that is the documented "`--model` pushes local LLM settings" case, now distinguished from "the client's env default".

**One model-catalog read per runtime.** `loadModels(...)` runs once per host plane (flags / `.env` / `.agents/config/models.json` / remote provider); the result is carried on the runtime as a **catalog** (`CodentAgentOptions.models` → `CodentAgent.readModels()`, type `ModelCatalogRead = { entries }`) and every consumer projects that one read — ACP's config options + legacy `models`, the app's `/models`, the CLI seed. The read deliberately carries **no active selection**: which entry/model a session runs on is the session's (`SessionData.model`, the session snapshot; ACP additionally records the selected entry index per session), and a runtime-level `active` would be a second answer that only agrees while one runtime has one session. The plane's resolved default travels with the session-creation defaults (`defaults.model` / `modelStyle` / `baseURL` / `apiKey`) plus a host-side seed for the entry index — never inside the read. Validate: `pnpm --filter @codent/core run validate:agent-runtime-instances`.

**Model + depth is one decision.** `/models` is the only command (`/models [entryIndex:modelId [effort|off]]`; no argument lists the entries) — `/effort` was removed from the catalog, so no host advertises it. The TUI renders it as a two-level option menu (model → depth) that **commits nothing until a leaf is accepted**, so `Esc` retreats one level and the session stays on the model it started on; the menu's depth list is built once per model row from `offerableReasoningEfforts` (positive metadata evidence: `reasoning` capability **and** a non-empty list), so a plain model's row is a leaf. A headless host advertises the same depth as ACP's `category: "thought_level"` select, written through `applyThoughtLevel`. Switching the model drops an explicit effort the new model does not advertise (`ManagedAgent.setModel`, strict rule); *validating* a hand-typed depth stays permissive (`supportedReasoningEfforts`, which falls back to the known set when metadata is missing). The `"<entryIndex>:<model>"` wire value is core's `encodeModelChoice`/`decodeModelChoice`. Validate: `validate:builtin-command-arguments`, `validate:acp:command-args`, `validate:acp:catalog`, and the app's `test/nested-command-menu.test.mjs`.

**Provider-catalog tie-break.** A bare model id resolves through `lookupModelFromModelsDev`, which scores every provider entry carrying that id (`scoreModelEntry`) and takes the best. Provider catalogs disagree about the same model: at an identical score one entry may advertise named effort levels while another only says `[{"type":"toggle"}]`. Ties used to fall through to payload key order, so the winner was arbitrary — harmless until depth offering became strict, at which point a toggle-only entry meant NO depth submenu for a model that supports thinking. `compareModelEntries` therefore breaks ties toward an entry that can describe depths, as a **boolean** (has named levels / has none), never by list size: ranking by count was measured rewriting a working menu (`deepseek/deepseek-v4.1-flash` went `["low","high"]` → all seven, claiming levels the upstream may reject), and two catalogs disagreeing is not evidence the larger set is right. It is a tie-break, not a filter — metadata richness still wins, so a fully-described paid listing is never displaced by a bare one that merely advertises levels. Measured: 230 model ids resolved to a level-less winner with a level-carrying sibling; 206 regained a menu, and **no model that already had one changed its level set**. Validate: `validate:models-dev-lookup`.

**The third tie-break is vendor identity, because price is the one field resellers disagree about.** A model id the maker does not list (or lists under another key) is matched across every vendor, and up to two dozen reseller entries tie on `scoreModelEntry` — 22 of 25 for `deepseek-v4.1-flash`. They agree about the model and disagree about cost: cache-read ranges `$0.0027`–`$0.15`/M for the *same* tokens, a 55× spread that priced one real session at 13 different vendors' rates and inflated a 99.6%-cache-hit session to $6.01 where DeepSeek's own tier is $0.47. So after score and level evidence, `makerRank` prefers the entry whose vendor matches the model's `family` brand (`deepseek-flash` → `deepseek`); when nothing matches, every candidate ranks the same and the pre-existing order stands — never a filter, because "unknown maker ⇒ no price" is a pricing-source decision rather than a ranking one. The `vendor/model` prefix needs no tier of its own: strategy 1 resolves that vendor before this comparator runs.

**Model capabilities** have one source of truth — `MODEL_CAPABILITIES` in `packages/core/src/models/types.ts`, from which the `ModelCapability` union and the extension `MODEL_CAPABILITY_FLAGS` are both derived. **Every member must be evidenceable** from metadata `deriveCapabilities` actually reads (`streaming` was granted to all entries with no field behind it, and `computer_use` had no source at all — both removed). `parseModelsDevModel` fills the list: `modalities.input` is authoritative per modality (`image`→`vision`, `audio`, `video`, `pdf`→`document`); `attachment` is a fallback used only when `modalities` is absent and grants `vision` alone (it cannot distinguish modalities, so it never implies `document`); `reasoning` / `tool_call` / `structured_output` map one-to-one; cache pricing implies `prompt_caching`. **Reasoning echo** is a separate `ModelInfo` concern, not a capability: `interleaved` (models.dev) sets `reasoningInterleaved` (the **adapter routing** signal — `capabilities.includes("reasoning")` alone is not enough) and `reasoningEchoField` (**only** the non-default `reasoning_details`; 15 of 7842 entries). The field is not consumed yet — TanStack's `extractReasoning` seam is `{ text: string }`, so structured/signed blocks cannot be carried. **`undefined` means "unknown" (permissive) and `[]` means "declared, none apply" (strict)** — `UsageTracker` holds `null` for the former, and a successful parse must return `[]`, never `undefined`, for a plain text model, so its modalities are stripped instead of sent to an endpoint that rejects them. Three hops preserve the distinction (`deriveCapabilities`, `mergeModelInfo`, `setCapabilities`). Validate: `pnpm --filter @codent/core run validate:model-capabilities`, `validate:capability-unknown-vs-none`, and `validate:reasoning-echo`.

### AgentAdapter — Host Abstraction

Each host (CLI, extension) provides an `AgentAdapter` implementation:

```typescript
interface AgentAdapter {
  initialize(config: AppConfig): Promise<InitResult>;
  createTransport(): ChatTransport<UIMessage>;
  destroy(): Promise<void>;
  exit(): void;
  readClipboardImage?(): Promise<ClipboardImageResult | null>;
}
```

`AgentAdapter` also carries the optional **editor handoff**: `openInEditor?(target)` (implemented by the CLI, absent on browser hosts, where the panel hides the key). A host that implements it must unmount the UI without ending the session, which is what `beginRuntimeSuspend()` / `consumeRuntimeSuspend()` (`@codent/app/utils/runtime-suspend.ts`) exist for: `useAgentChat`'s unmount path skips `bindAgentSession(null, null)` + `adapter.destroy()` while a suspend is in flight, and the mount that resumes re-binds the same session instead of calling `adapter.destroy()` + `adapter.initialize()` again. Without that seam an editor handoff would dispose the runtime and drop the conversation. Validate: `pnpm --filter @codent/app test` (`test/runtime-suspend.test.mjs`).

Shared initialization logic is in `createAgentSessionFromConfig()` (`@codent/app/adapter/session-bootstrap.ts`). Both `LocalAgentAdapter` (CLI) and `ExtensionAgentAdapter` delegate to this helper. `initConfig` must keep host fields such as `toolConfig` (websearch keys / preferred provider) and `remoteSession` so they reach `Host.create`. The adapter is constructed with the host-owned `env` (and provider) and builds the runtime via `CodentAgent.create`; the host wraps the tree in `<CoreEnvProvider value={env}>` so app components read the workspace env from context (`useCoreEnv`), never the ambient `getEnv()`. The CLI `LocalAgentAdapter` owns the runtime's host and, on `destroy`, disposes the runtime (which iterates `host.list()`) so it leaks nothing on exit.

### Bootstrap Sequences

**CLI (local):**
```
loadEnv → parseCliArgs
  → coreEnv = createNodeEnv; provider = createDirectModelProvider(...)
  → registerCoreEnv(coreEnv) / registerModelProvider(provider)      (ambient fallback)
  → initConfig → useWorkspaceInfo.init(coreEnv)
  → render(<CoreEnvProvider value={coreEnv}><AdapterProvider value={new LocalAgentAdapter({ env, provider })}>…)
  → adapter.initialize → CodentAgent.create({ env, provider }) → createAgentSessionFromConfig
```

**CLI (remote planes):**
```
loadEnv → parseCliArgs
  → [guard] --remote-session + (--remote-env | --remote-provider) → error + exit(1) (exclusive)
  → [--remote-env] coreEnv = createRemoteEnv; [--remote-session] coreEnv = createRemoteEnv(server URL) (panel = server fs)
  → else coreEnv = createNodeEnv
  → [--remote-provider] provider = createRemoteProvider; else provider = createDirectModelProvider
  → registerCoreEnv(coreEnv) / registerModelProvider(provider)      (ambient fallback)
  → initConfig → render(App) → LocalAgentAdapter.initialize
      → local: CodentAgent.create({ env, provider }) ; remote-session: CodentAgent.create({ env, host: createRemoteAgentSessionHost })
```

**Extension:**
```
ConnectionGuard(/health) → env = createRemoteEnv(url); provider = apiKey ? direct : createRemoteProvider(url)
  → registerCoreEnv(env) / registerModelProvider(provider)          (ambient fallback)
  → initConfig → render(<CoreEnvProvider value={env}><AdapterProvider value={new ExtensionAgentAdapter({ env, provider })}>…)
  → adapter.initialize → CodentAgent.create({ env, provider }) → createAgentSessionFromConfig
```

The same shape applies to the other hosts: `codent` (local release host), `acp` (local bootstrap), `playground` (WebContainer env), and `server` (one server-owned `CodentAgent` over its CoreEnv; the `/api/agent/*` plane drives its manager). IM reaches the agent through an external ACP client (cc-connect → `codent acp`); see `docs/acp-im.md`.

### Shared Managed Run

Root and child runs share `agent/run/managed-span.ts`, a helper (not a layer) that owns the
`runAgentOnce` call plus shared abort/error/empty-stream normalization. Root queueing/approvals and
child task projection remain with their actual owners. A non-`internal` child projects into the
parent task row when it carries the parent task id; `general` remains defined as an id but is not
exposed through `task`.

### @codent/core Public API

`packages/core/src/index.ts` exports a **curated** surface for hosts and adapters — not a barrel of every internal module:

| Category | Examples |
|----------|----------|
| CoreEnv | `registerCoreEnv`, `getEnv`, `CoreEnv` types |
| ModelProvider | `registerModelProvider`, `createDirectModelProvider`, `resolveModelConfigFromProvider` |
| Runtime | `CodentAgent` (+ `CodentAgentOptions`) — the instantiable runtime; `AgentSession` / `AgentSessionHost`; `readModels()` reports the model **catalog** the runtime was created with (entries only — the selected model belongs to the session). `agentManager` / `AgentManager` / `ManagedAgent` are the **deprecated** ambient-manager surface |
| UI / state | Session-safe types (`TodoItem`, `LogEntry`, …); `AgentLog`/`TodoManager`/`SessionStore` classes are package-private (AgentLog is the emission seam — the built-in log extension owns policy and writes `.agents/logs/<sessionId>/agent.log`) |
| Compaction | Session `compact` command; executors (`autoCompact`, …) stay on `dev.ts` |
| Bootstrap | `buildDefaultSystemPrompt`, `resolveModelConfig`, `resolveModelConfigFromProvider` |
| UI helpers | `previewEdit`, AgentSession `tool` channel (run_command stdout/stderr), tool output types |
| Adapters | `FileError`, `ExecutionError`, `generateId` |

Internal modules (tools, middleware, subagent runner, hook registry, session-sync / tool-phase helpers, etc.) stay package-private. Core validation scripts import from `dist/dev.mjs` (`src/dev.ts`), which is not part of the published package export map. See `openspec/changes/harden-core-organization/API-REMOVALS.md` for the latest public-entry removals.

### TanStack AI Integration

`@codent/core` uses **TanStack AI** (`@tanstack/ai`, provider adapters) for agent execution.

Key integration points:
- `packages/core/src/models/config/model-config.ts` — connection resolution (`openai` | `anthropic` style, baseURL, apiKey, models.dev metadata)
- `packages/core/src/models/adapter/adapter-factory.ts` — TanStack text adapters (`createOpenaiChatCompletions`, `createAnthropicChat`)
- `packages/core/src/managers/run-agent.ts` — `AgentRunner` + `chat()` stream, compaction middleware
- `packages/core/src/agent/compaction/` — Channel convert + summary-first wire projection (`getModelVisibleMessages`); engine messages are ephemeral
- `packages/core/src/agent/ui/ui-channel.ts` — Durable UIMessage chain (SoT); compaction appends SUMMARY here
- `packages/core/src/agent/mcp/` — MCP via `@tanstack/ai-mcp` (`McpManager` re-wraps tool execute so multimodal `content[]` is not dropped when `structuredContent` is present)
- `app/src/hooks/use-agent-chat.ts` — React hook via Session `dispatch` / subscribe (no ManagedAgent)

## Build, Lint, Test Commands

```bash
pnpm install          # Install dependencies

pnpm build            # Build all packages (core → app → rest)
pnpm build:core       # Build core package only
pnpm build:app        # Build app package only (deps external — see "Two app builds")
pnpm build:app:release # Build app with every third-party dep inlined (release paths only)
pnpm build:cli        # Build CLI package only
pnpm build:server     # Build server package only
pnpm build:extension  # Build extension only
pnpm build:codent      # Build the release host (fully bundled, self-contained)
                       # → core, then app:release, then node, then codent

pnpm dev              # Run all packages in watch mode (parallel)
pnpm dev:core         # Watch core package
pnpm dev:app          # Watch app package
pnpm dev:cli          # Watch CLI package
pnpm dev:server       # Watch server package
pnpm dev:extension    # Run extension dev server
pnpm start:cli        # Run CLI after build
pnpm start:server     # Run CoreEnv HTTP server
pnpm publish:codent   # Build + publish the release host (no sibling packages needed)

pnpm typecheck        # Type check all packages
pnpm lint             # Run ESLint (after a build — see below)
pnpm format           # Format with Prettier
```

Per-package type check: `cd packages/<pkg> && pnpm tsc --noEmit` (e.g. `core`, `app`, `cli`).

### Two `@codent/app` builds

`@codent/app` has **two** tsdown configs, and the only difference is dependency handling. Both share their entries and dependency lists in `packages/app/tsdown.shared.ts`, so the two cannot drift.

| Config | Script | Dependencies | Who consumes it |
|--------|--------|--------------|-----------------|
| `tsdown.config.ts` | `build` (default) | **external** | every host in this repo — playground, extension, cli, codent |
| `tsdown.config.release.ts` | `build:release` | **inlined** | the fully bundled release paths (`build:codent`, `pnpm publish:*`) |

The default is the cheap one and must stay the default: a dependency is built **once**, by whoever owns it, instead of being inlined into `dist` and then bundled *again* by each host that inlines `@codent/app`. Inlining at this layer also freezes one module form into the artifact before any host has a say — `reactivity-store` is the worked example. The release config resolves it on the Node platform target, so it lands as its CJS entry (`require("react")`), which a browser host cannot execute (the playground's `node:module` stub turns that `require` into a thrown `require() is not available in the browser`). A host that resolves the package itself picks the `module` (ESM) entry and the problem does not exist.

The release config exists because those third-party deps (`reactivity-store`, `chalk`, `diff`, `ink-stream-markdown`, `@git-diff-view/*`, `@m234/nerd-fonts`) are **`devDependencies`** here — they are implementation details of the render layer, not a public API. A host inside this workspace provides them (every one of them is a real dependency of the playground and the extension), but a **published** `@codent/app` would resolve nothing: tsdown only auto-externalises production dependencies, so the default build emits bare specifiers that npm never installs for the consumer (`ERR_MODULE_NOT_FOUND`). `build:release` inlines them, which is what makes `pnpm publish:packages` viable.

`build:codent` composes the release path explicitly (`core` → `app:release` → `node` → `codent`), while plain `pnpm build` keeps the default. (For `codent` itself the choice is cosmetic — its own `alwaysBundle: [/.*/]` would inline the externals anyway — but reusing the release path keeps the ordering honest and reuses the config that the publish path needs.) CI builds the default, then the release config, then runs `validate:self-contained` — so a broken release config is a PR failure rather than a tag-time discovery.

**Consequence for host configs:** because the app build emits the renderer under its **real** package name (`@my-react/react-terminal`, not the bare `ink`), a browser host must alias *both* spellings to the package's `/web` entry. Aliasing only `ink` silently pulls the Node entry of the terminal renderer, which imports `signal-exit` and reads `process.platform` at module scope (`process is not defined`). See the alias blocks in `packages/playground/vite.config.ts` and `packages/extension/wxt.config.ts`.

**Build first.** `pnpm lint` and `pnpm typecheck` only pass against a built checkout: the `validate:*` / test / render-smoke scripts import their own package's `dist` output (`../dist/dev.mjs`), and bare workspace specifiers (`@codent/core`) resolve through each package's `exports` map, which points at `dist`. In a fresh clone both commands report ~280 phantom `import/no-unresolved` / `TS2307` errors until `pnpm build` has run once. That is why CI builds before linting.

Tests: `@codent/app` owns the only `node:test` suite — `pnpm --filter @codent/app test` builds the package, then runs `node --test test/*.test.mjs` against its `dist` output. Core is covered by the `validate:*` scripts instead (see step 3 of the Task Completion Checklist).

`@codent/app` has a second, separate suite: `pnpm --filter @codent/app validate:render-smoke` bundles `scripts/render-smoke/` from `src` and mounts the real transcript in a fake terminal, asserting on rendered frames (the row budget, the fold window, cache invalidation). It is the only coverage that renders, and it is **local-only — deliberately not in CI**: the terminal renderer reads `CI` / `CONTINUOUS_INTEGRATION` through `is-in-ci` at module load and, when set, switches to a write mode without the erase/repaint sequences that `frameLines()` reconstructs frames from — so under GitHub Actions every frame reads as empty and a dozen unrelated assertions fail with `frameLines: 0`. The harness deletes both variables before the renderer loads (`neutralize-ci-env.mjs`, which must stay the first import), so the smoke now passes in any environment; it stays out of the workflows anyway because its value is as a deep local check, not a per-PR gate. It rotted once before — `f8a7c83` dropped the `react` / `ink` aliases it imported by bare name and nobody noticed for two commits, because no workflow ever invoked it. The rule that survives: a `validate:*` script nobody calls is a script that rots, and it rots into a failure that looks like a check failing rather than a harness that cannot run — so when touching the render layer, run the smoke locally even though CI will not.

CI: `.github/workflows/ci.yml` runs on every pull request and on pushes to `main` — `wxt prepare` → `pnpm build` → `pnpm lint` → `pnpm typecheck` → `pnpm --filter @codent/app test` → `build:app:release` → `codent validate:self-contained` → `codent validate:runtime-specifiers`. The release workflow (`.github/workflows/release.yml`, `v*` tag or manual dispatch) runs the same checks before `pnpm --filter codent-cli run publish:beta`.

### Two release-contract checks (`packages/codent/scripts/`)

`codent` inlines `@codent/app` / `core` / `node` into a single tarball, and that property is invisible at build time — tsdown leaves a bare specifier in the output and the build still succeeds. So it has two assertions, and they cover different failures:

| Script | Asserts |
|--------|---------|
| `validate-self-contained.mjs` | no `@codent/*` specifier survives into `dist`; `dependencies` is exactly the external allowlist; `optionalDependencies` is drawn from a separate native-addon allowlist (`sharp`, `isolated-vm`) and never overlaps `dependencies`; the 18 tree-sitter grammars are present in `dist/tree-sitter/` |
| `validate-runtime-specifiers.mjs` | every dynamic `import()` / `require()` in the bundle resolves to an inlined package or a declared dependency (**including `optionalDependencies`**) |

The second exists because "it resolves here" proves nothing about a consumer: this repo installs `devDependencies`, so an undeclared package is importable in CI and throws `ERR_MODULE_NOT_FOUND` for a user. The check is therefore against the declared install surface, not the local `node_modules`. Its allowlist (`INERT_PATTERNS`) names the six codegen templates that look like imports but are never evaluated (`ajv`, `ajv-formats`, `react-hot-loader`, `web-worker`, `@img/sharp-libvips-dev`, `@img/sharp-libvips`) — each with a reason, so a real call site cannot hide behind a blanket disable.

**Native addons:** `sharp` and `isolated-vm` are external *and* optional. Inlining a native addon is impossible (the binary is not JS), and inlining its loader is worse than omitting it — the loader resolves relative to itself, so an inlined copy looks for `prebuilds/` beside our `dist` and dies with `No native build was found`. Both host facts have to hold: the JS entry stays in the bundle (so `runtime-specifiers` sees a resolvable specifier) while the addon is resolved at call time from a real on-disk layout. `optionalDependencies` is what stops a platform without a prebuilt binding from failing the whole install — the feature degrades to `null` instead (`sharp` → oversized images rejected; `isolated-vm` → the code-mode extension registers nothing).

**Known blind spot in `runtime-specifiers`:** it can only see specifiers, so an addon resolved purely *by path* escapes it. `node-gyp-build` does `require(path.join(__dirname, …))`, which is exactly how `isolated-vm` is loaded — no bare `isolated-vm` specifier exists in the bundle to match. It also cannot see `require$N.resolve("pkg")`, because the pattern matches a *call* followed by `(`, and `resolve(` sits in between (`\.resolve` is a property access, so `\b\w*require(?:\$\d+)?` matches `require$1` and then finds `.`, not `(`). Both escapes are covered by other means, not by widening the pattern: the optional allowlist plus the install-and-run smoke test cover `isolated-vm`, and `tree-sitter-wasms`'s `resolve(` call is covered by the grammar assertion in `validate-self-contained`. `sharp`'s bindings *are* caught, because its loader uses a `require$2` template — that variant (rolldown's per-file `$n` rename) is why the scan pattern is `\b\w*require(?:\$\d+)?`, and it went unseen until it was added.

**Non-JS assets: copied in, not depended on.** A fourth relationship exists beyond inlined / external / optional — a package that is a **build-time input** whose files are copied into `dist`. `tree-sitter-wasms` is the case: 50 MB of grammars, 36 of them, and the host parses with 18 (22.8 MB), so a runtime dependency would ship 27.2 MB of dead weight to every consumer. There is nothing to inline either — `.wasm` files are not JavaScript. `scripts/copy-tree-sitter-grammars.mjs` therefore copies exactly the grammars named by core's `LANGUAGE_TO_GRAMMAR` into `dist/tree-sitter/` after tsdown runs (tsdown's `clean: true` means it *must* run after, or the copies are deleted), and `grammar.ts` resolves that directory first, falling back to the installed package for the workspace layout. The manifest is read from core rather than kept as a second list, so a language added to core cannot leave the tarball behind. This class of asset is invisible at build time — the bundle is valid and every call just returns `null` for a user — which is why `validate:self-contained` asserts the grammars are present, individually and non-empty (validated by deleting one, deleting the directory, and truncating one; each fails with the right message). Two shared helpers resolve the build inputs: `scripts/resolve-workspace-deps.mjs` reaches core's `dist/dev.mjs`, which is deliberately outside core's `exports` map (neither a `@codent/core/dev` subpath nor a `package.json` lookup resolves), and finds `tree-sitter-wasms` from `@codent/node`'s location, since pnpm does not hoist it to where `packages/codent` could walk up to it.

A `devDependencies` entry in a host package is **not** a publish blocker: npm packs from `dependencies` alone, so `workspace:*` siblings there are build-time inputs, not install requirements. `npm pack` also auto-includes `LICENSE` / `README.md` regardless of `files`, so those need no entry either.

## Code Style Guidelines

### Formatting (Prettier)
- Double quotes for strings (`"string"`)
- Semicolons required
- 2 space indentation, no tabs
- 120 character line width
- Trailing commas in ES5 contexts

### TypeScript
- Target: ES2022
- Strict mode enabled
- ESM modules (`"type": "module"`)
- Use `.js` extensions in imports for local files (ESM requirement)

### Import Order & Style
```typescript
import { tool } from "ai";                     // 1. External (no extension)
import { z } from "zod";

import { resolveModelConfig } from "./models/model-config.js";  // 2. Local (.js)

import type { AppConfig } from "./adapter/types.js";  // 3. Type-only (local first, then external, alphabetical)
import type { LanguageModel, ToolSet } from "ai";
```

### Naming Conventions

| Type | Convention | Example |
|------|------------|---------|
| Files (general) | kebab-case | `use-agent.ts`, `read-file-tool.ts` |
| Files (React) | PascalCase | `App.tsx`, `Header.tsx` |
| Functions | camelCase | `createTools`, `getFile` |
| Factory functions | `create*` prefix | `createAgent`, `createModel` |
| Hooks | `use*` prefix | `useAgent`, `useConfig` |
| Types/Interfaces | PascalCase | `AgentConfig`, `ToolCallInfo` |
| Zod schemas | camelCase + Schema | `agentConfigSchema` |
| Constants | SCREAMING_SNAKE_CASE | `DEFAULT_LOCAL_OPENAI_BASE_URL` |

### Core Naming Conventions (packages/core)

Rules that keep `packages/core` internally consistent. Deviations need a reason in the PR.

**Files**

- kebab-case, and the name must state the module's responsibility — avoid generic
  placeholders (`helpers.ts`, `output.ts`, `prompt.ts`, `tools.ts`) for non-trivial modules.
- Built-in extensions live at `<domain>/extension.ts` (e.g. `agent/skills/extension.ts`,
  `agent/lsp/extension.ts`). The extension *framework* itself lives in `agent/extension/`.
- Extension UI is **one generic render surface**: extensions publish raw text (ANSI) or a
  `text` / `row` / `column` / `box` layout tree via `ctx.ui.render(surface, key, payload)`, and the
  host renders it with a single generic renderer. Do **not** reintroduce predefined extension
  components (status APIs, widget vocabularies, confirm dialogs, color helpers) — that vocabulary
  was deliberately removed; payloads must stay JSON-serializable for remote hosts.

**Shared helpers**

- A cross-cutting helper has **one definition**. UTF-8 byte length / byte-bounded truncation,
  character truncation with an omission marker, human-readable byte sizes, display line splitting,
  data-URL parsing + MIME mapping, error normalization, abort classification, memory expiry, name
  slugification, and binary-media part membership each live once — under `src/utils/`, or in the
  owning domain for a domain-specific classifier (`agent/memory/memory-expiry.ts`,
  `agent/media/types.ts`).
- Import a shared helper by deep path; do not add an `index.ts` barrel under `utils/` (the
  directory is not consumed as a unit, so a barrel there would be dead weight).
- `toError` / `errorMessage` are on the public entry (`@codent/core`), and
  `validate:no-inline-error-normalize` scans **every package** for the two canonical inline
  spellings. The rule is only enforceable if hosts can import the definition — exporting it is
  what closes the "core-only guard, 26 host copies" gap.
- Re-deriving one inline fails a `validate:no-inline-*` guard, and a second `export function` body
  for a watched symbol fails `validate:module-organization`'s single-definition list. See
  `openspec/specs/core-shared-helpers/spec.md`.

**Exports**

- Built-in extension factories: exactly one canonical export `createXxxExtension`. No bare-name aliases, no default exports.
- Internal renames land directly — no old-path re-exports, deprecated aliases, or staged dual exports; call sites switch in the same change.

**Class members / accessors**

- No underscore-prefixed members (`_status` ✗ → `currentStatus` ✓). Getter backing fields use descriptive names.
- Read accessors: `getXxx()` / `setXxx()` methods. Two rules: (a) a class may not offer **two spellings for one read** — `get status(): AgentStatus { return this.currentStatus; }` alongside `getStatus()` is what `validate:accessor-convention` fails everywhere; (b) `ManagedAgent` (the composition root) must not use bare property getters for state at all — both are enforced by that validator's `METHOD_ONLY_CLASSES` / duplicate check. A single-spelling computed property over private data on any *other* class (`get configPath()`, `get size()`, `get scopeId()`) is allowed; the rule is about exposing *state* twice, not about avoiding getters.

**Barrels**

- Domain directories expose `index.ts` where the domain is consumed as a unit; import from
  the directory root when consuming 2+ symbols from it. That 2+ rule is a guideline, not a
  gate: the enforced rule is that a barrel which exists is consumed through its directory
  root (`validate:module-organization`). The top-level `src/agent/` namespace is
  intentionally barrel-free — cross-domain imports use direct module paths there.

**Import layering** (`packages/core/scripts/validate-layer-boundaries.mjs`)

- Every relative import is resolved to its top-level layer (`env`, `agent`, `agent-session`,
  `managers`, `models`, `provider`, `runtime`, `runtime-types`, `utils`) and checked against one edge
  table. An unlisted pair fails, and so does a new top-level directory — adding a layer is a decision.
- **The module graph must be acyclic for runtime values.** A directory boundary groups modules by
  subject, so the *layer* diagram can contain a declared, narrowed cycle (`models` ↔ `provider`, the
  `agent` ↔ `models` leaf helpers); what must never happen is a value cycle between **files**, where a
  module observes another half-initialized. `import type` / `export type` erase at compile time and may
  cycle freely (`runtime-types/hosts.ts` is the port hub).
- A declared edge that no import exercises fails (dead grant), and an edge declared `type-only` fails
  the moment a runtime value crosses it. Break a value cycle by moving the shared function down or
  injecting the dependency — not by widening the allowlist.

**File size**

- Keep files ≤ **400 lines** where a cohesive boundary exists (`.cursor/rules/040`). This is the
  design guideline, not the enforced gate: `eslint.config.cjs` raises `max-lines` to **800** for
  this repo, so a file between the two numbers passes lint without an exemption — the gap is a
  deliberate allowance for cohesive modules, not a licence to keep growing one. Above **400**
  a split is a judgement call (look for a cohesive seam); at or above the **800** ceiling it is
  mandatory to say why not: the `/* eslint-disable max-lines */` at the top of such a file must
  be paired with a written justification naming what the file composes and which parts were
  extracted instead — the current members are `agent/extension/runner.ts`,
  `managers/managed-agent.ts`, `packages/acp/src/agent.ts` and `packages/acp/src/projector.ts`, and
  their headers name what was split out — and `validate:file-size` fails an allowlisted file that
  drops back under the ceiling so the list cannot go stale. The guard scans **every** package's
  source with the same metric as ESLint (non-blank lines) — `src` when the package has one, the
  package root for WXT-style layouts (`packages/extension`), which a `continue` on a missing `src`
  used to skip entirely — so a new oversized host file is caught outside core too. An unexplained disable is a silent
  exemption, and this file's carried one long enough for the tracker to mark it done at 514
  lines and never revisit it at 1750.

**JSDoc attachment.** A doc block must sit on the declaration it describes. Two directly stacked
JSDoc blocks mean one was abandoned by a refactor, so the declaration below is described twice (or
its real owner is not described at all) — TypeScript and ESLint cannot see it.
`validate:jsdoc-attachment` fails that shape across **every package's source** (not just core: the
abandoned-doc shape is a refactor artifact, and hosts refactor at least as much); it is the gate for
the class of bug that put `getL1State`'s doc on `setDisplayName`.

**Built-in identity**

- A built-in's name is written in core exactly once: a tool in its `defineServerTool({ name })`
  (and the exported `BUILTIN_TOOL_NAMES` registry), a command in `BUILTIN_COMMAND_CATALOG`.
- Hosts (`@codent/app`, `@codent/acp`, …) MUST compare, route, and label a
  built-in through `BUILTIN_TOOL_NAMES` / the command catalog — never a private name table, `case`
  list, or `Set` of tool names. A host's tool classification (row treatment, editor tool kind)
  derives from core's `present` descriptors / catalog; only a host-owned view may be *selected* by a
  core identifier. Adding or renaming a built-in is then a core-only edit.
- An **extension command list** published to hosts is the live set
  (`AgentSessionExtensionsSummary.commands`, one entry per name at the highest dispatch rank),
  while `extensions[].commands` stays each extension's own claim for the management panel. A host
  that advertises by flattening the latter offers a shadowed name twice — one copy can never run.
  A host whose own built-ins win dispatch may additionally filter those names (ACP does), but it
  must not re-derive the ranking.
- A command's **argument grammar** is core too (`agent/commands/arguments.ts`): `parseModeCommand` /
  `parseModelsCommand` return an intent, and each host maps that intent to its `AgentSessionCommand`s
  plus its own message text. A host that re-parses the raw string is how ACP's `/mode execute` became
  `mode.toggle` while the catalog advertised `execute`. `/resume`'s id-or-name rule is
  `resolveSessionRef` (`agent-session/session-reference.ts`), and `ask_user` result assembly (including
  the multi-select + free-text merge) is `buildAskUserOutput` (`agent/tools/builtin/interaction/ask-user-output.ts`).
  Validate: `validate:builtin-command-arguments`, `validate:acp:command-args`, `validate:ask-user-output`.
- Guards: `validate:builtin-tool-names` (the registry matches the tools core builds),
  `validate:command-catalog` (app commands are catalog-derived), and `validate:host-tool-names`
  (app/acp keep no built-in name literals in tool-identity positions).

### Error Handling
```typescript
try {
  const result = await someOperation();
  return result;
} catch (error) {
  const err = error instanceof Error ? error : new Error(String(error));
  onError?.(err);
  throw err;
}
```

**Typed errors:** Use `FileError` / `ExecutionError` (from `@codent/core`) for structured errors across local/remote boundaries — they serialize/deserialize over HTTP.
```typescript
import { FileError, ExecutionError } from "@codent/core";
throw new FileError("not_found", "File not found", "/path/to/file");          // fs
throw new ExecutionError("timeout", "Command timed out after 30s");            // exec
```

### State Management (reactivity-store)
Uses Zustand-like API:
```typescript
export const useAgent = createState(() => ({ status: "idle", error: "" }), {
  withActions: (state) => ({
    setStatus: (status: string) => {
      state.status = status;  // Direct mutation allowed
    },
  }),
});

// Usage in components
const status = useAgent((s) => s.status);           // Reactive selector
const { setStatus } = useAgent.getActions();        // Non-reactive actions
```

### Tool Definition Pattern
> Canonical form: `defineServerTool({ name, description, inputSchema, outputSchema, present, execute })`
> (or `defineClientTool` for host-executed tools). `present` is how the tool is displayed —
> fold `category`, `keepRow` / `detailed` / `clientSide`, `summary` / `label` / `text` renderers
> and `labelKey` — declared at the definition site, pure functions of the stored output, and
> shipped to hosts as data (`part.display`). See `packages/core/src/agent/tools/presentation/types.ts`
> and the drift guard `validate:tool-presentation`.

```typescript
export const createReadFileTool = () => {
  return tool({
    title: "read-file-tool",
    description: "Read file contents",
    inputSchema: z.object({
      path: z.string().describe("File path to read"),
      offset: z.number().int().min(0).optional(),
    }),
    outputSchema: z.object({
      content: z.string(),
    }),
    execute: async ({ path }, { abortSignal }) => {
      const env = getEnv();
      const content = await env.fs.readFile(path);
      return { content };
    },
  });
};
```

### React Components
```typescript
export const MyComponent = () => {
  const config = useConfig((s) => s.config);

  return (
    <Box flexDirection="column">
      <Text>{config.model}</Text>
    </Box>
  );
};
```

### Documentation Style
Use JSDoc with examples for public APIs:
```typescript
/**
 * Create a new agent instance
 * @example const agent = await agentManager.createManagedAgent({ name: "main", model: "gpt-4o" });
 */
```

Use section separators in large files:
```typescript
// ============================================================================
// Types & Schemas
// ============================================================================
```

## Key Technologies

### Core & App
- **TanStack AI** (`@tanstack/ai`, `@tanstack/ai-client`, provider adapters) — LLM agent loop and streaming
- **@tanstack/ai-client** — used inside core chat controller / stream wiring; app talks Session
- **Zod** (v4.x) — Schema validation
- **pathe** — Cross-runtime POSIX path utilities
- **reactivity-store** — State management (Zustand-like API)
- **tsdown** — TypeScript build tool
- **shiki** / **ink-stream-markdown** — Syntax highlighting and markdown rendering
- **@git-diff-view** — Git diff visualization

### CLI
- **@my-react/react-terminal** — React for terminal UIs
- **ink** — Terminal rendering (aliased from @my-react/react-terminal)

### Node
- **@anthropic-ai/sandbox-runtime** — OS-level sandbox for command execution
- **mime-types** — MIME type detection
- **@ai-sdk/mcp** — MCP stdio transport

### Server
- **Hono** — HTTP framework
- **@hono/zod-validator** — Request validation
- **hono/client** (RPC) — Type-safe client generation

### Extension
- **WXT** — Browser extension framework
- **@heroui/react** — UI component library
- **tailwindcss** (v4.x) — CSS framework

## Agent Session API (host-facing)

Hosts should prefer `AgentSession` (`getSnapshot` / `dispatch` / `subscribe`) over reading `ManagedAgent` fields. Local: `createLocalAgentSession`. HTTP: `@codent/server/agent-session` / `@codent/server/client`'s `createRemoteAgentSessionHost` against `/api/agent/*`. Subagents reuse the same Session contract by id.

**Host-owned session plane:** hosts build the runtime (`CodentAgent` — local manager, or one wrapping a remote HTTP host for `--remote-session`) and inject it (as the app's `AgentRuntimePort`) into `createAgentSessionFromConfig`, which creates the root session through `runtime.createSession` (so the runtime defaults apply); the UI layer never imports core runtime singletons (enforced by app's `validate:core-imports`). `session.new` starts a fresh disk session and leaves the previous one intact and resumable; there is no in-place `clear` command (a new conversation is always a new session). Remote client features: SSE auto-reconnect with exponential backoff, server heartbeat ping + client watchdog, remount seeds (`/tool-buffers`, `/summary-streams`) so in-flight tool output and summary streams survive reconnects; the retained `state` channel carries the session identity (`name`, `sessionId`) plus model identity (`model` / `modelInfo` / `reasoningEffort`), so commands and model switches sync without a full-snapshot refetch. The snapshot reducer (`packages/server/src/remote-session-reducer.ts`) is **exhaustive by `never`**: every `AGENT_SESSION_CHANNELS` member has a case (or is explicitly declared push-only), so adding a channel without handling it fails to compile instead of silently leaving the remote snapshot stale — the failure mode that let `lastIteration` be missed over HTTP while the local path was correct. Validate: `validate:agent-session-channels` (enumerates the channel list, not just the channels someone tested).

All domain updates route through a single unified `AgentEventBus` (`agent/agent-event-bus`) — one type registry (`AgentEvents` + `AGENT_EVENT_META`), two dispatch modes: observer `emit` (sync, fire-and-forget, retained values) and interceptor `intercept` (async, ordered, cancel short-circuit; `tool:before:*` patterns). A throwing observer is contained like a throwing interceptor: the remaining subscribers still get the frame and the failure is reported through the same `onInterceptorError` sink (tagged `kind: "observer"`), so a broken projector/log sink is not a silently missing update. `AgentManager.of(agentId, parentId?)` mints per-agent scoped buses (subagent events up-flow to parent/root). `AgentSession` subscribes the scoped bus once and projects every observer event to its channel via `AGENT_EVENT_META[type].channel`, replaying retained values per subscriber. The former structured `log` channel was **removed** — log observability is provided exclusively by the persisted JSONL file sink (`.agents/logs/<sessionId>/agent.log`).

**TODO:** message channel currently delivers full `UIMessage[]` (incremental/patch later).

### ACP subagents (child sessions + task result)

`@codent/acp` maps core's `subagents` snapshot onto the protocol's experimental surface, gated on
`clientCapabilities.subagents` (object = supported; absent/`null` = no subagent frame at all):

| Piece | File | Responsibility |
|---|---|---|
| projection | `packages/acp/src/subagent-projection.ts` | `AgentSessionSubagentSummary` → `subagent_update`: user-visible filter (`isUserVisibleTaskRow`), status → `StateUpdate`, `_meta.taskPhase`, announce-vs-patch diff |
| child transcript | `packages/acp/src/child-projector.ts` | one `AcpProjector` per announced child, emitting under the **child** session id; prompt is `session_message` (parent→child), commands empty, compaction follows the client |
| wiring | `packages/acp/src/agent.ts` | announce FIRST, then attach child projectors; parent `closeBridge` stops children without destroying them; child ids are screened out of `load`/`resume`/`prompt`/`fork`, and `delete` is short-circuited before `host.deleteSession` (which would destroy the child) |

The parent's `task` row is the result of record: terminal content uses core's
`formatToolOutput(output, "task")`, the live summary stream updates the same row, and a chunk after the
final result is dropped. Internal workers (no `parentTaskToolCallId`) are never announced. Validate:
`pnpm --filter @codent/acp run validate:acp:subagents` (the projector/host halves
`validate-acp-subagents.mjs` + `validate-acp-subagents-host.mjs`; also in `validate:acp`). The mock
sessions/app harness lives in `scripts/acp-subagent-scenario.mjs`.

## CoreEnv Server (Remote Mode)

The `@codent/server` package exposes CoreEnv APIs over HTTP using Hono RPC for end-to-end type safety. Agent Session routes are a **separate plane** under `/api/agent/*` (not CoreEnv).

### Server Routes

| Route | Method | Description |
|-------|--------|-------------|
| `/health` | GET | Health check, returns rootPath and sandbox mode |
| `/api/env/info` | GET | Platform info: rootPath, platform, arch, homedir, sep |
| `/api/env/vars` | GET | Environment variables (sensitive vars filtered) |
| `/api/env/destroy` | POST | Lifecycle cleanup |
| `/api/fs/*` | POST | Filesystem operations (readFile / writeFile with optional base64 encoding for binary, etc.) |
| `/api/command/run` | POST | Run a shell command |
| `/api/command/exec` | POST | Execute a simple command |
| `/api/fetch/proxy` | POST | HTTP fetch proxy (handles binary via base64; not for LLM SSE) |
| `/api/provider/info` | GET | Remote model provider metadata (style, model, proxy basePath; no secrets) |
| `/api/provider/openai/*` | ALL | Streaming OpenAI-compatible proxy (injects server `API_KEY`; strips `Content-Encoding` after undici decode) |
| `/api/provider/anthropic/*` | ALL | Streaming Anthropic proxy (injects server `x-api-key`; same encoding strip) |
| `/api/mcp/init` | POST | Create a new MCP stdio process session |
| `/api/mcp/:id/message` | POST | Send a JSON-RPC message to an MCP session |
| `/api/mcp/:id` | DELETE | Clean up an MCP stdio process session |
| `/api/agent` | GET | Catalog list (mirrors `AgentSessionHost.list()`) |
| `/api/agent/models` | GET | Selectable model list for remote-session clients (`/models` command) |
| `/api/agent` | POST | Create/bind AgentSession (full create options incl. maxIterations/mcp/toolConfig/resume). Any `ZodError` — the request schema, `AgentConfigSchema`, the compaction schema — is a 400 via the app's one error boundary |
| `/api/agent/:id/snapshot` | GET | AgentSession snapshot (root or subagent id) |
| `/api/agent/:id/command` | POST | `dispatch(command)` |
| `/api/agent/:id/events` | GET | SSE session channels (+ 15s heartbeat ping frames) |
| `/api/agent/:id/tool-buffers` | GET | Command stdout/stderr snapshots per toolCallId, root + children in the active disk session (remount) |
| `/api/agent/:id/summary-streams` | GET | Live task/compact summary snapshots (remount/cache seed) |
| `/api/agent/:id` | DELETE | Close session |

### Client Usage

```typescript
import { registerCoreEnv, registerModelProvider, createDirectModelProvider } from "@codent/core";
import { createRemoteEnv, createRemoteProvider } from "@codent/server/client";

registerCoreEnv(await createRemoteEnv("http://localhost:3100"));
registerModelProvider(await createRemoteProvider("http://localhost:3100"));
// Or local keys with remote workspace:
// registerModelProvider(createDirectModelProvider({ model, style, baseURL, apiKey }));
```

### Known Limitations
- `runCommand` mid-run streaming is lost over HTTP — chunks are not pushed live; the remote client delivers full stdout/stderr once when `/api/command/run` returns (UI/tool still get the final output)
- Binary fetch responses are base64-encoded over the wire
- Provider proxy assumes a trusted network (no extra auth on `/api/provider/*` in v1)
- Provider proxy `/api/provider/*` fetch failures return OpenAI `{ error: { message, type, code } }` (not `{ error: true }`); the **server host** must be able to reach its `BASE_URL`
- LLM adapters still use global `fetch` against the proxy `baseURL` (not `CoreEnv.fetch`)

## Agent Event System

`AgentManager` owns the root unified `AgentEventBus` for lifecycle telemetry. Emit via `emitAgentTelemetry()` / `ManagedAgent.emitEvent()` (both route onto the agent's scoped bus, up-flowing to root); subscribe with `agentManager.on(type, listener)` or `bus.on("*")`.

| Event | When emitted |
|-------|----------------|
| `session:doc` / `session:skill` / `session:mcp` / `session:memory` | After agent registration during bootstrap |
| `session:start` | Bootstrap complete |
| `prompt:submit` | Run prepared |
| `prompt:before` | Extension `before_agent_start` / turn-context providers collected |
| `agent:thinking` | Model reasoning stream starts |
| `agent:tool-start` / `agent:tool-end` / `agent:tool-error` | Tool lifecycle (extensions middleware). A start ends in **one** of `tool-end` (ran) or `tool-error` (threw); a denied call never starts, and a **client tool** (`ask_user`) has neither — its result is a `tool-result` part on the channel, written by the host. Do not pair start/end 1:1 when reading a log |
| `agent:retry` | Recoverable LLM failure being retried (429/gateway backoff, capability strip, reactive compact, max_tokens continuation); payload carries `attempt`/`maxAttempts`/`strategy`/`error`/`delayMs`. Retry state also lives on the Session snapshot + `state` channel (`AgentRetryState`) and is cleared once the stream recovers or the run reaches a terminal status |
| `agent:iteration` | Agent-loop progress **within the current chat** (one tool-phase pump; a chat pump restarts it per phase, so it reads `1/max` on every phase). Payload `{ current, max }` (1-based; idle `0`; `max` = that chat's `maxIterations`). Deliberately a DIFFERENT scale from `turn:start.index` / `llm:*` `iteration` (run-scoped) — never pair the two. Projected onto the retained `iteration` channel + `AgentSessionSnapshot.iteration`; deliberately **not** logged. A finalized turn keeps its last reading on `lastIteration` (the live counter is cleared on the way out), which is what ACP classifies as `max_turn_requests`. A settled turn retires the run token in the pump's `finally`, so "a run is current" means a run is in flight — an idle host action cannot treat the finished turn as abortable. |
| `turn:start` / `turn:end` | One model turn opened / closed (`index` + budget; finish reason + tool-call count). Per turn, observable, never default-logged. `turn:summary` reports **one pump**: `phases` / `durationMs` / `toolCalls` / tokens / cost are that pump's own numbers (deltas against its start), never the session totals — a turn split by approvals summarizes each pump separately, and a pump that ran nothing reports zeros. `toolCalls` counts **settled** calls (`complete` / `error`: ran, failed or **cancelled**; a denied call stays `approval-responded` and is not counted), so the pump that executes an approved tool is the one credited — not the pump that requested it |
| `message:start` / `message:end` | An assistant message began streaming / was finalized (`firstOutput` on the run's first; finalized text + tool-call count). Observable, never default-logged |
| `agent:abort` / `agent:stream-error` | User abort / stream failure (`RUN_ERROR`, empty-stream guard, and other pump failures; main chat records error without crashing the host) |
| `agent:stop` | Run finished or aborted |
| `memory:prefetch` | Per-turn memory selection (triggered by the memory extension, emitted by `MemoryService` through the agent's telemetry sink) |
| `memory:extract` / `memory:consolidate` | Post-run memory extraction |
| `compaction:auto-*` / `compaction:reactive-*` | Auto / reactive context compaction |
| `session:save-error` | Session persistence failure |
| `session:restore` | Session resume succeeded (`sessionId`, `messageCount`, `tokenEstimate`, `mediaMissing` when >0); also re-emits the retained `state` channel |
| `subagent:*` | Subagent lifecycle |
| `plan:enter` / `plan:ready` / `plan:execute` / `plan:cancel-execution` / `plan:retro` / `plan:complete` / `plan:exit` | Plan mode phase transitions |

**Vision note:** On OpenAI-compatible Chat Completions, multimodal tool results are lifted to a synthetic user `image_url` message (`liftToolMediaForChatCompletions`) so base64 is not stringified into `role: "tool"`. Anthropic keeps native multimodal `tool_result` parts. Official DeepSeek Chat Completions may still reject `image_url` (text-only schema); capability sanitization strips unsupported `image` / `audio` / `video` / `document` parts on the wire and retries once — use a vision-capable provider for real media understanding. Session/UI history always keeps structured image parts (and `.agents/media` binary files); wire stripping must not change persisted message shape.

**Logging (built-in extension):** the emission **seam** is `AgentLog` (`agent/agent-log/agent-log.ts`) — level filtering, scope/`run` stamping, envelope construction, then a direct hand-off to the attached sink. It is deliberately **not** an extension and not disableable: ~76 core call sites plus `ctx.logger` write through it, and they must work during workspace construction, before extensions load, and while an extension is failing to activate. Log **policy** belongs to the built-in log extension (`agent/log/extension.ts` = `createLogExtension`, with `event-log-bridge.ts` for the rules, `event-log-rules.ts` for the table, `schemas.ts` for the entry schema, `jsonl-file-sink.ts` for the sink + rotation). The two domains are coupled **but acyclic**, which is the property to preserve: `agent/log/` reaches `agent-log/` for the `LogEntry` / `AgentLog` **types** (erased) and for the extension-exit-flush registry, while `agent-log/` reaches `agent/log/` for the JSONL sink and the entry schema — opposite directions, but never along a path that returns to its start, so neither domain can break the other by initialising early. The written rule is "no module-level import cycle between these two domains", not "no two-way edge": the value edges in both directions are real and each is load-bearing, and the schema lives in `agent/log/` because the sink is its only runtime consumer. `AgentManager` constructs and `start()`s it; its `bus.on("*")` subscription is the only wildcard consumer in core, and it maps telemetry events to entries — each stamped with the originating event type (`event`), committed to its run (`run`), and attributed by `scope` (`profile` + optional `taskCallId`). Override per event type with `EventLogPolicy`. Emit sites should not duplicate lifecycle logs covered by the table. Entries emitted before a sink is bound are retained (bounded, `MAX_PENDING_LOG_ENTRIES`) and drained into the first sink that attaches, so bootstrap diagnostics reach disk. `AGENT_LOG_LEVEL=debug|info|warn|error` is the one volume knob (default `debug`); `createLogExtension.attachSink` applies it to every log it binds — including the bootstrap **pending** buffer, which is re-filtered at drain time (entries accepted before the sink existed were otherwise written regardless of the level) — because the seam must stay env-free (it also runs before extensions load). The sink persists every entry to `.agents/logs/<sessionId>/agent.log` (size-rotated), validated against `logEntrySchema` at the write boundary. Subagents have no extension runner but do log, so core hands **each** `AgentLog` to the extension's sink (`attachSink`); the extension's `dispose()` releases them.

## Prompt Cache (prefix)
Frozen system text ends with `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` and stays byte-stable across turns.
Per-turn dynamic context is injected as synthetic `<ctx kind=...>` user messages by the turn-context middleware `onConfig` (after compaction) whenever a section's content hash changes (persisted in `uiMessages`, hidden in the transcript UI; per-kind supersede notices mark refreshed sections). **Admission is stateless and read back from the post-compaction wire**: on every call the middleware recovers the newest block of each kind from the wire it is about to send, compares hashes, and injects only what is absent or changed — so compaction cuts, `/resume`, session switches and process restarts need no remembered hash table, message counter or reset hook. Counter-shaped state (todo-nag rounds/episode, repeat-call count) travels in machine-readable `<ctx kind=... attr="…">` shell attributes, so it too is recovered from the message chain (`agent/turn-context/reminder/`, `managers/middleware/repeat-reminder-middleware.ts`).

Three injection shapes share that one catalog (`TURN_CONTEXT_KINDS`) and one shell:

1. **Hash-admitted sections** — the turn-context middleware (date / git / mode / extension sections / session id / retrieval / instructions) plus the `<background_jobs>` pointer (same rule, delivered by `background-middleware`): inject only when the content differs from the newest block of that kind in the wire. `selectChangedSections` is that rule, defined once and called by both.
2. **Condition + counter reminders** — the todo nag and the repeat-call nudge are their own middlewares (`todo-reminder`, `repeat-reminder`), sharing **one** kind, `reminder`, and declaring themselves with their own inner tag (`<todo-reminder>` / `<repeat-reminder>`). Each middleware owns its scan; `agent/turn-context/reminder/counter-reminder.ts` owns the shared part — nearest-block recovery within the slice the scan produced (`findCounterReminder`, matching **inner tag + scope attr**) and the attr-carrying builder (`buildCounterReminderSection`: scope attr + counter + `episode`).
   - **Todo scan**: right-to-left for the newest `todo` call (a prompt does not end the cycle — only an update does), `rounds` = model turns after it; re-admit only at a strictly later round and after the growing cooldown (3 / 8 / 18 / 33 by default; one turn later than the removed per-iteration counter, since `rounds` counts completed turns). **No `todo` call in the window** (plan-seeded list, or the call left the kept window) falls back to the current turn as the cycle, counted from the newest genuine user prompt — otherwise a list the agent was *handed* would never nag.
   - **Repeat scan**: right-to-left over the trailing identical-call run; a previous nudge counts only if it sits **inside** that run; due when the count **crosses** a configured threshold (a parallel batch can jump 2 → 4, so "equals a threshold" would skip 3 forever) and it is strictly greater than the last admitted count. The gentle text is the first admission of the chain, not the first threshold value.
   - **Cleanup** is uniform: a block from another cycle/chain never counts, so a new cycle starts at episode 1 with no reset call; a supersede notice names the reminder's **own tag**, never the shared kind, so one family can never tell the model to ignore the other.
   - `TodoManager` keeps only the policy (threshold/cooldown/growth).
3. **Background pushes** — `background-middleware`, two layers **in this order**: (a) the `background_notification` completion push — the core delivery, one per completed job, appended first, carrying status + output tail and a machine-readable `jobs="id,…"` attr; (b) the `<background_jobs>` pointer — the safety net, hash-admitted like a turn-context section, listing only jobs whose `run_command` call is still in the wire **and** that this wire does not already announce. A pointer build failure is logged (a silent one would lose the model's only route back to a job whose notification a cut removed). Background *tasks* land in this class.

   Both layers ride a model call, so a completion that lands while the session is **idle** is invisible until the user types. `ManagedAgent` therefore **wakes** it: the registry's change notification carries `finished` (the ids that just reached a terminal state — `create` / restore / evict / clear report an empty list, so `/resume` never starts a turn for a historical record), and an idle agent enqueues one pump (`AgentChatController.wakeForBackgroundCompletion`). The wake starts the turn; delivery stays the middleware's (`collectCompleted()` there is a peek, `markNotified` still happens after the injection). The wake turn is a **real turn** — `markNextPrepareAsNewTurn` gives it its own `runId` and turn boundaries (`turn:start` / `turn:summary` / `agent:stop`) even though the channel's last message is an assistant message — but it has no prompt, so `collectExtensionPromptHooks` / `prompt:submit` are skipped (`(structured)` is not a query). The wakeable statuses are an **allowlist** — `idle` / `completed` — not "anything that is not parked": a run the user aborted or that ended in `error` is left alone (they just stopped it, and a finishing job must not restart it). Also no wake while a pump is live or queued, during a manual `/compact`, in plan `ready` (review: the user is reading) or `planning` (nothing approved yet — a promptless turn could author a plan), or for a subagent. `executing` / `retro` stay wakeable: that plan was approved (and the mode already auto-approves its tools). A wake turn also **skips post-run memory extraction** (`RunCoordinator.promptlessTurn`): there is no prompt to remember. The mark survives a `waiting` finalization (a wake turn that parks on an approval, or `ask_user`, keeps it for the resume pump), so a wake turn where the user then answers a question still does not extract — the next prompted turn covers it. Validate: `validate:background-wake`.

Every `<ctx kind=…>` tag is the catalog value and every section body is rendered by `formatSectionTag` — one renderer, so the inner tag a builder writes is the same tag admission and recovery read back. `validate:turn-context-kinds` fails if any source file outside `turn-context-message.ts` spells a catalog kind as a quoted literal (compound values), writes a literal `<ctx kind=…>` tag (that is how `background_notification` had drifted out of the catalog), or renders a section tag literally in a builder; it also asserts both counter reminders resolve to the single `reminder` kind with distinct inner tags and scope attrs. `syntheticKindFromId` recognizes only ids the current shell writes (`ctx-<kind>-<8hex>[-<nonce>]`) — there is no legacy-id branch. Validate: `validate:turn-context`, `validate:turn-context-kinds`, `validate:todo-reminder`, `validate:repeat-reminder`, `validate:repeat-reminder-persistence`.
`<current_date>` uses **day** granularity (not hour/minute) so the payload stays stable within a calendar day.
`findCutPointByBudget` counts synthetic `<ctx kind=...>` messages in the token budget but never selects one as the cut boundary (`isValidCutBoundary` rejects them).
All synthetic injections (turn-context sections, reminders, memory, background-command completion notifications) share one helper (`agent/turn-context/synthetic-injection.ts`): stable `ctx-<kind>-<hash>` ids, channel + wire in sync, persisted to the session (no cross-turn prefix divergence), and `nextSyntheticNonces` for the per-kind episode. Their writes **coalesce**: one model call can inject several sections, and `SessionService` writes only the newest admitted UI snapshot per drain (state-only writes keep their own turn), so a burst costs one write — or two when later snapshots land while the first is already dehydrating — instead of one per injection. Validate: `validate:session-persist-coalescing`. The wire-only `max_tokens` **continuation prompt** is wrapped in the same shell (`<ctx kind=continuation_prompt>`): as a bare user message it is a turn boundary, which switched the repeat scan off for the rest of the run.
`prompt-cache-middleware` then:

- **Anthropic** — `cache_control: { type: "ephemeral" }` on frozen system, last tool definition, and latest user message (tool-loop friendly)
- **OpenAI-compatible** — `prompt_cache_key` from session id (≤64 chars)
- **All styles** — tools sorted by name for stable schemas

Helpers: `packages/core/src/models/cache/prompt-cache.ts`. Validate: `pnpm --filter @codent/core run validate:prompt-cache`.

### Context-window fill has ONE reading (`getContextFillTokens()`)

`input_tokens` means two different things depending on the upstream, and both are in this repo's own logs:

| Convention | Who | `input` vs cache | True prompt |
|---|---|---|---|
| **inclusive** | OpenAI, Gemini, most gateways | `cached_tokens` ⊆ `prompt_tokens` | `input` |
| **exclusive** | Anthropic native, DeepSeek native | `cache_read`/`cache_write` are **disjoint** | `input + cache` |

A gateway can also **switch conventions between requests with no notice** — observed here on 2026-10-08 18:50, mid-process, between two adjacent calls. So the reading is decided **per sample, not per config**: the cache counters cannot exceed a prompt that already contains them, so `cache > input` means disjoint. Deciding it per sample is what makes the formula self-healing; a hardcoded either/or breaks the other half of the fleet. The heuristic can only ever **under**-count (an exclusive upstream whose fresh tokens outweigh the cached ones reads as inclusive), never over-count — and over-counting is what would misfire compaction.

`UsageTracker.getContextFillTokens()` is the single source, consumed by `getTokenLimitPercent()` (footer context %), `shouldTriggerAutoCompact` (via `ManagedAgent`), `compaction-middleware`'s `actualTokens`, the persisted `SessionData.contextTokens`, the restore path (`setWindowUsage` keeps `window.totalTokens` consistent), and `ExtensionUiContext.usage.windowTokens`. **Never read `window.inputTokens` for "how full is the window".**

The bug this replaced: the percentage divided `window.inputTokens` by the limit, which is correct only under the inclusive convention. Adopting an exclusive upstream made a fully-cached prompt (176 fresh tokens over a 212,992-token cached prompt) render as **0.04%**, and because `shouldTriggerAutoCompact` read the same field, the trigger never fired. Replaying 422 logged `llm:response` rows through both formulas: the old one reported <1% on **238** of them; the fixed one on **none**.

⚠️ Do **not** "fix" this by using `cacheReadTokens` in place of `inputTokens` — that collapses to ~0% whenever the cache is cold, which is strictly worse. The two are **added**, never swapped. Validate: `pnpm --filter @codent/core run validate:context-fill-tokens`.

**The lifetime view has the same trap, and for a while had its own fix.** `/usage`'s `Cache hit:` divided cumulative `total.cacheReadTokens` by `total.inputTokens` — the cache-miss sum on an exclusive upstream — and printed **428.5%** on a real session (125.4k cache read over 29.3k input). The denominator is the *billed prompt*, and it **cannot be recovered from the aggregate**: `total.inputTokens` is already a miss-sum, so "take the max" under-reports (a session with 2.64M miss + 39.2M cached is a true 93.7% hit, not 100%). `UsageTracker` therefore accumulates `billedInputTotal` **per sample** through the same `promptTokensOf()` the window fill uses — one rule, exact under both conventions, written by `accumulateTotal` and cleared by `reset()`. `getCacheHitRatio()` is that ratio (`billedInputTotal` is the denominator, so it stays inside (0,1]). The value is **persisted** as `SessionData.billedInputTokens` and restored through `restoreTotals()`: re-deriving it from the aggregate applies the convention heuristic to *totals*, which only agrees while every sample used the same convention — one session can hold both (a gateway switched mid-run), and `/usage` then changed across a resume. A child's exact count also travels with its totals (`addTotalWithCost(..., billedInputTokens)`), for the same reason. Old sessions omit the field and fall back to the aggregate reading instead of failing. ⚠️ `accumulateTotal` is shared with subagent aggregation and restored totals, so an inflated per-sample prompt would skew cost-adjacent surfaces too. Validate: `validate:context-fill-tokens` (ratio round-trip), `validate:session-persist-integrity` (persist → adopt round-trip).

### Message-operation ownership (writers on the wire are pure)

`compaction` rebuilds the wire from the channel, and `WireProjectionCache` returns the **same array reference** on every hit within a run. The projected array is therefore shared, long-lived state: a writer that edits its input instead of returning a replacement corrupts every later call of the run, silently. Two shipped writers follow the replacement contract —
`applyToolCompact` (returns a new array; only changed entries are copied) and `injectSyntheticMessages` (returns `{ injected, messages }`, so a caller must use the new wire rather than a side effect on the old one). Two further rules:

- **Cache before parse.** `applyToolCompact` consults `ToolCompactCache` *before* `parseToolMessageOutput`. Decoding a tool payload runs on every model call and its result is discarded on a hit — that decode was most of the cost: 0.49 ms/call → 0.05 ms/call for 60 results × 25 KB, and 2.00 ms → ~0.05 ms at
100 KB payloads (what remains is the O(results) scan + Map lookups).
- **One projection.** `projectWireFromChannel` (`agent/compaction/wire-projection.ts`) is shared by the compaction middleware and `ManagedAgent.getMessagesForLLM` (manual `/compact`, reactive compact, memory extraction), over the agent's single `WireProjectionCache`. A second implementation is what would let a reader disagree with the window the model receives.

Validate: `pnpm --filter @codent/core run validate:message-ops-purity`.

**Durability rule — what is wire-only must never become durable.** The wire and the UI channel are not independent: `getModelVisibleMessages` builds fresh message objects but the content-part objects inside them are the **same references** as the channel's. One in-place edit to a part downstream of the projection is therefore written to disk, so a wire-only transform applied in place would destroy the user's attachment in the persisted session. Every transform on the wire is copy-on-write for this reason — `stripMultimodalFromChatMessages` filters into a new `parts` / `content` array and returns the original when nothing is dropped; `liftToolMediaForChatCompletions`, `applyAnthropicToolCacheBreakpoint` and `applyAnthropicLatestUserCacheBreakpoint` all rebuild rather than mutate.

The persisted session is written from `channel.getMessages()` (`AgentChatController.persistMessages` → `maybeSaveSessionUIMessages` → `SessionService.persistSession` → `dehydrateUIMessages` → `SessionStore`), never from the wire. The two rules meet on the synthetic `<ctx kind=...>` messages, which are the one thing a middleware injects that **must** be durable: `injectSyntheticMessages` appends to the channel *and* to the wire, and the stable content-hash id makes the injection idempotent across a restore (so a resumed session never re-injects, and the prefix cache stays stable).

Validate: `pnpm --filter @codent/core run validate:wire-override-reaches-adapter` (sections 8-10 persist through a real `SessionService` + `SessionStore` and assert on the log bytes and the reload: no strip placeholder on disk, no continuation prompt on disk, the image still there, the ctx present exactly once, and the same after a restore + re-run).

### A cancelled tool call has TWO possible outputs, and they are not the same shape

Telling a user-cancelled run from a failure is one question, answered in one place per layer: `isAbortError(err, signal)` decides whether a throw is the abort (`runtime-types/abort.ts` — signal first, then the DOM name, then `code === "aborted"` for the local and remote-reconstructed shapes, then the bare `message`, because three layers had three different heuristics before), `agent:tool-error`'s payload carries the same verdict as `cancelled` (the abort reaches TanStack as a throw, so this is the *only* event that can express it), and `isCancelledToolCall` renders both marker spellings — `cancelled` (a tool that caught its own abort) and `aborted` (the `task` tool, whose subagent cancels without throwing) — as one neutral ⚠. Every host reads that one predicate: the compact activity summary no longer counts a cancel as an error, and ACP maps it to the terminal non-success status (`failed`; its v1 `ToolCallStatus` has no `cancelled`) with `_meta.cancelled: true` — never `completed`, which is what the `task` marker used to produce.

What that predicate must **not** be used for is deciding what the row says. A cancelled call has two possible outputs, written by two writers at two moments, and they differ in kind:

| Writer | Output | Why it exists |
|--------|--------|----------------|
| `cancelInFlightToolCalls` / `cancelIncompleteToolCalls` | `{ success: false, error, cancelled: true }` | Framework fallback for a call interrupted before its execute resolved. **Not any tool's schema** — `run_command` has no `exitCode` in it. |
| the tool's own catch (`run_command`, `webfetch`, `websearch`) | a **full** output with `cancelled: true` | A real result: whatever the tool had produced before the stop. `run_command` synthesizes `exitCode: -1`. |

The first is short-circuited by `isSyntheticCancelOutput` at the top of `formatToolOutput` — before the per-tool dispatch, because every formatter would otherwise read fields that cannot be there (`run_command` rendered the literal `Exit code: undefined`; `todo` **threw** on `stats.total`; `edit_file` said "Edited undefined"). The second must still render, minus the exit code it made up. Merging the two — treating "carries a cancel marker" as "has nothing to show" — silently discards the partial output the user watched being produced. `isCancelledOutputMarker` answers "is this a cancel"; `isSyntheticCancelOutput` answers "is there nothing here but the cancel", and only the latter may skip rendering.

This is observable only when it is wrong, and for a moment: pressing Esc showed `Exit code: undefined`, and the next message rewrote the same part with the tool's own `-1`. Two writers, one part id, two verdicts. Assert both shapes — the render smoke mounts each (`cancelled run_command (…)` checks) and the app tests feed both to `formatToolOutput` directly.

### Project instructions (`<project_instructions>`)

The project instruction file is loaded once at agent creation and frozen into the system prompt as `<project_instructions>`. `CLAUDE.md` is checked first, then `AGENTS.md`; **the first one found is the only one loaded** — there is no implicit fallback, so a project that keeps `CLAUDE.md` as a pointer composes explicitly with `@` imports.

`@path/to/file.md` anywhere in an instruction file is inlined at load time (Claude Code's syntax, max depth 5):

- relative paths resolve against the file that contains the reference; a leading `/` means **project-root-relative** (`@/openspec/AGENTS.md`)
- references inside fenced blocks and inline code spans are left literal
- a token only counts when it ends in a file extension, so npm-style prose (`@codent/app`) is inert
- a missing target, an escape via `../`, or a cycle is **left as written and reported** (logged at bootstrap, listed in `<instruction_context>` on re-injection) rather than silently dropped. A cycle is detected per chain (`visited` set), so the same file referenced twice in different branches still expands in both.

Discovery and expansion live in `packages/core/src/agent/prompt/instruction-files.ts` — one module shared by `agent-doc-loader.ts` (system prompt) and `turn-context/instruction-context.ts` (change detection + re-injection). They must not drift: the change-detection digest covers the **expanded** text, so editing an `@`-imported file re-injects the instruction block like any other edit. Both the result and the expansion notices are part of that digest.

The expanded content is bounded by a **65536-byte** budget, counted in bytes (not characters — a CJK character is 3 bytes), cut on a line boundary and reported when truncation occurs. Validate: `pnpm --filter @codent/core run validate:instruction-imports` (plus `validate:instruction-context` and `validate:instruction-budget`).

## Plan Mode

Cursor-like lifecycle: explore → review → Build → forced retro → complete (exit).

| Phase (internal) | UI label | Tools | Behavior |
|------------------|----------|-------|----------|
| `planning` | planning | Mutate tools + MCP hidden; `task` allowed; `create_plan` / `update_plan` offered; `run_command` allowlisted | Explore (prefer `task`), clarify if needed, call `create_plan` (or `## Plan` fallback). **verification** required (non-empty outcome checklist). Judge `task` via status flags (`reachedLimit` / `incomplete` / `aborted` / `truncated`) before treating research as extendable. Auto-saves under `.agents/plans/`. |
| `ready` | review | Same read-only restrictions | User reviews; revise via chat + `update_plan` (verification still required). `/mode execute` = Build (no extra confirm). |
| `executing` | building | Full tools (`create_plan` / `update_plan` / `complete_plan` hidden); pending approvals auto-approved while seeded | Follow plan; run Verification with evidence before finishing. Session persists `planMode` + `todoPlanBound`. |
| `retro` | retro | Full tools + `complete_plan`; approvals auto-approved under the same `todosSeeded` guard as `executing` (verification is *run* here) | Forced retrospective; `complete_plan` requires `verificationResults` covering every checklist item (all passed). `/mode done` force-exits without that gate. |
| `off` | — | Plan authoring/completion tools hidden | Default |

**App:** `Shift+Tab` cycles modes (normal → auto → plan → normal → …); `/mode` is the slash-command entry point (contextual menu + subcommands `plan` / `auto` / `off` / `switch plan` / `switch auto` / `status` / `execute` / `done` / `cancel` / `save` / `load` / `list`; empty `/mode` cycles like `Shift+Tab`). When **review** (`ready`), press `p` (empty input) to toggle a bordered markdown plan preview in the banner (`Esc` closes). `/mode execute` Builds from review; `/mode cancel` pauses building → review; `/mode done` finishes retro (user force — no agent verification gate); `/mode status` reports phase; `/mode save` / `load` / `list` for named persistence (create/update already auto-save). Footer shows mode name (`Normal` / `Auto` / `planning` / `review · /mode execute` / `building n/m` / `retro`). `create_plan` / `update_plan` do not dump plan text into the tool transcript — review is via the banner preview.

**Core:** `ManagedAgent.planMode` (`PlanModeController`), tool filter in `run-agent`, `createPlanModeMiddleware`, prompts via turn context, `plan-verification` parse/gate helpers. See `packages/core/src/agent/plan/`. Validate: `pnpm --filter @codent/core run validate:plan-verification`.

**Auto mode:** `/mode auto` skips all tool approvals. Footer shows `Auto`. Mutually exclusive with plan mode (entering one clears the other). Cleared on `/new` / reset; persisted as `SessionData.autoMode` (legacy sessions may still have `autoApprove`). While auto is on, turn context includes an `<auto_mode>` block.

Turning it **on** answers every approval the run is currently **parked on** and resumes the pump: a pending approval is a question the mode has just answered, and leaving it pending means switching auto on looks like it did nothing. This is one rule in the local session dispatch (`mode.set` / `mode.toggle` → `settleApprovalsForMode` → `AgentChatController.approvePendingApprovals`), so the TUI, ACP (`session/set_mode`, the `mode` config option, `/mode`) and remote sessions all behave the same; the TUI's `/mode` command used to answer them itself, which is exactly why ACP and `mode.toggle` (Shift+Tab) left the run suspended. ACP additionally **cancels** the outstanding `session/request_permission` when the approval disappears from the pending snapshot — otherwise the client keeps a dialog for a tool that already ran, and a late `deny` would re-decide a completed call (`packages/acp/src/interactions.ts`). Validate: `validate:auto-mode-approvals`, `validate:acp:auto-approval`.

**Session / safety:** `/new` and `ManagedAgent.reset()` always `planMode.disable()`, turn off auto mode, and clear the session `approvals` table. Entering or leaving a plan phase goes through `ModeCoordinator` — including `/mode load` and the `complete_plan` tool — because it is the only writer that turns auto mode off (the two are mutually exclusive) and persists the phase-off transition. Resume restores `planMode` + `autoMode` with plan winning if both were somehow set, restores `approvals` (or backfills from UIMessage parts when the field is missing), adopts the persisted `reasoningEffort` / `model` + `modelStyle` (skipped under `providerMode: "remote"`, where the provider server owns the model) and mirrors the session's display name. Chat `onConfig` rebuilds TanStack `resumeToolState.approvals` from that table so approved/denied tools do not re-prompt. Plan building auto-approve still requires `todosSeeded` (and applies to `retro` as well as `executing`) — separate from `/mode auto`.

**Manual `/compact` is a first-class busy state.** It runs with **no pump** (`pumpDepth === 0`), so every pump-keyed check missed it: input started a second turn over a half-written checkpoint, and Esc returned early (the summarizer could not be cancelled). Now `shouldDeferMidRunQueue` treats `compacting` as busy (the message queues and is released by `resumeAfterCompaction()` when the compaction ends), and `stop()` cancels the compaction first — status `aborted`, the same verdict as the auto path, with **no** `agent:abort` / `agent:stop` because no turn existed. Esc also drops the queued input, as it does for a run. `/compact` stays rejected while a run is live (`isRunActive`), and `isRunActive()` counts a running compaction — the same pump-blindness made `forceSubmit` (Option/Ctrl+Enter, the one path that never consults the defer queue) open a turn beside the summarizer, so it degrades to a queued follow-up while a compaction owns the agent.

**One owner for all three kinds: `CompactionController`** (`managers/controllers/compaction-controller.ts`). A **lease** is the ownership identity and carries the status it replaced, the kind's start/complete/error events, and (manual only) the summarizer's abort signal; `begin` claims it, producers check `isCurrent(lease)` before applying anything, and exactly one of `finish` / `release` / `cancel` / `abortForTeardown` ends it. Closure is **producer-scoped and structural**: each producer releases its own lease in a `finally` (auto: the compaction middleware; manual: `ManagedAgent.compact`; reactive: `handleManagedReactiveCompact`), and because `release` is lease-checked and idempotent it is a no-op after `finish` or after a newer lease superseded it. There is deliberately **no** lease-blind status reset (the removed `settle()`): forcing `compacting → running` from the status alone could overwrite a compaction that legitimately claimed ownership during a retry. A superseded lease can neither apply a checkpoint nor restore a status — that is what used to leave the agent stuck in `compacting` when a counter was bumped without an owner to restore it. Manual `/compact` publishes `compaction:manual-{start,complete,error}` (never the `auto` names), so the timeline says "Compacting context (manual)…" / "Manual compact: …" and can be filtered by event. Validate: `validate:manual-compact-interlock` (+ the routing matrix in `validate:pump-continuation`, the lease/status matrix in `validate:reactive-compact`, and the wording in `validate:event-log-bridge`).

## Subagent System

The project supports **subagents** — context-isolated agents spawned to handle delegated tasks.

**Run profiles:** InteractiveChat (`AgentChatController` pump) and Worker (`runSubagent`) share `agent/run/managed-span.ts`, which reuses `runAgentOnce` / `consumeAgentStream` in `agent/run/run-agent-skeleton.ts`. Workers use outcome path `"detached"`; chat finalizes with `"chat"` after the full pump. Hosts still observe via `AgentSession` only.

### Subagent Characteristics

| Feature | Behavior |
|---------|----------|
| Context | Fresh (starts with empty messages) |
| Tools | Read-only: `read_file`, `glob`, `grep`, `list_file`, `tree`, `websearch`, `webfetch`, `run_command` (restricted: read-only, project-internal commands only — writes, background commands and external paths are denied by `subagentSafe`), plus marker `begin_summary` (no write tools) |
| Return | Summary only to parent LLM context; UI keeps a read-only UIMessage preview when the child is projected to the parent task row |
| Iteration Limit | 50 steps max (TanStack `maxIterations`; cutoff leaves `finishReason: tool_calls`) |
| Status flags | `toModelOutput` exposes `reachedLimit` / `incomplete` / `aborted` (plus `stopReason` when aborted); explore runs require `begin_summary` for a complete result. `truncated` stays on the output for other callers but is NOT handed to the parent: the `task` tool runs with `SUBAGENT_NO_TRUNCATE`, so it is always false there. A long summary is a head+tail PREVIEW ending with `Full output saved to: <path>` — the model is told to read that file. A terminal **failure** (provider error, context overflow) reports through the same flags — `incomplete: true` with the fault prefixed onto the summary — instead of throwing, so a dead `task` never reaches the parent as a bare tool error, and it takes the same progress-summary fallback (`isProgressSummaryEligible` accepts `failed` as a terminal cause) |
| Summary Limit | `task`: none (`SUBAGENT_NO_TRUNCATE`). Summaries over the tool-output cache threshold become a head+tail preview in the model context with the full text at `.agents/cache/tool-output/<id>.txt`. Other `runSubagent` callers default to `SUBAGENT_DEFAULT_MAX_OUTPUT_LENGTH` (5000 chars). |

| UI Preview | A non-`internal` child with a parent task id: parent panel + task-tool streaming via the subagent’s `AgentUIChannel` |
| No parent bridge | `internal` workers (and any child without a parent task id): still have an internal `AgentUIChannel` (message SoT); skip parent task-tool streaming |

### Subagent UI Preview

`runSubagent` always attaches an `AgentUIChannel` via `ensureUIChannel`.
A non-`internal` child with a parent task id enables the task panel (`Ctrl+T`) and parent task-tool routing
(summary stream keyed by the task tool-call id); an `internal` child or one without a task id keeps
the channel internal only.
Task-tool subagents use `autoDestroy: false` so the preview stays available; after the stream ends,
detached outcome finalization marks them `completed`/`aborted`. Esc while a task is active aborts the
subagent first: `runSubagent` sets `aborted: true` and appends `[Task cancelled by user.]` into the
task `summary` (parent model + UI), even when the stream ends without throwing.
so `getActiveSubagents()` (and the Ctrl+T list) only shows truly active tasks.
Task spawn ids are always auto-generated via `generateId("subagent", { exists })` — the model
does not supply an `id` input.
The default task tool row shows the current subagent exploration tool during analysis.
After the subagent calls `begin_summary`, the UI switches to summary phase and streams final text
via `AgentStreamHub` (`reset` / `append` / `end` on key `task:${toolCallId}`) into `useSummaryStream` /
`SummaryStreamView` — not UIMessage diffs or the command stream sink (those remain for `run_command`).
On restart-style stream recovery (429 / capability sanitize), `AgentUIChannel.resetRetryUiState()`
resets only the attempt-scoped UI state (the streamed summary banner text + phase unlock), for **both**
profiles. It must never touch the message history: the retry's wire is re-projected from the channel
(`compaction.onConfig`), so dropping rows there restarts the exploration instead of resuming it — the
subagent-only version of this reset is what made a `task` re-explore after a network drop.
Terminal non-abort failures still call `failRun()`, but only to trim the **panel**: the run reaches
the shared finalization (so the parent gets `incomplete: true` + the fault in the summary) instead of
rethrowing out of `runSubagent` — a dead `task` used to surface as a bare tool error with no flags.
Max-tokens continuation does not reset.
Compact summarization uses the same hub with stable key `compact:${parentAgentId}` (one in-flight compact per agent).
Only the last text-only step is returned to the parent as the task `summary`; `toModelOutput` also includes completion status (`reachedLimit` / `incomplete` / `aborted` / `truncated`) so the parent can judge whether findings are trustworthy to extend. The iteration pair (`iterations` = model turns, `maxIterations` = the budget it ran under) is **host-only**: it is persisted on the task output so a restored row can still show `used/budget`, but it is in neither `toModelOutput` nor the description — `reachedLimit` already is the budget verdict, and a bare count says nothing without a ceiling.

### Per-task phase machine & parallel pre-fork

Each `task` tool call owns a one-way phase state machine (`TaskRunState` in `subagent/task-run-state.ts`, held by the per-parent registry in `subagent/subagent-runs.ts` — see the module map):
`running` (subagent exploring — its running/thinking/responding statuses fold into this single phase)
→ `summary` (the subagent called `begin_summary`, OR the iteration-limit progress-summary fallback started
its report). Phases are authoritative — never inferred from messages. Registered per parent via `WeakMap`,
keyed by `parentTaskToolCallId`; `readTaskRunPhase` defaults to `running` for unknown tasks.

Parallelism: `@tanstack/ai` ≥ 0.64 runs one turn's server tools **in parallel** (default
`toolExecution`, opt out with `"sequential"`), so codent's `subagent/task-prefork.ts` is no longer a
serial-execution workaround — it is the **concurrency throttle** plus an eager start. Once all tool
args finish streaming (`TOOL_CALL_END`), each `task` call starts its subagent immediately; scheduling
is a rolling FIFO window capped at `ManagedAgentConfig.maxConcurrentTasks` (default 4), and extra runs
queue until a slot frees (not serially, not all at once). The task loop's own `execute` just joins the
already-running promise. A queued run does not start — or emit its `agent:tool-start` — until admitted,
so a waiting task's row never times; the extensions middleware defers its eager start for a `task` the
coordinator owns. Cap resolution: `resolveMaxConcurrentTasks` (finite integer ≥ 1, else the default).

When a subagent hits its iteration limit before `begin_summary`, the **progress-summary fallback**
(`subagent/progress-summary.ts`) spawns a side-LLM summarizer (parent-spawned, no tools) that turns the
partial exploration into a report streamed through the same `AgentStreamHub`, so the task UI always
shows a readable outcome instead of a bare cutoff. Subagent LLM retries (429/gateway backoff, capability
strip) are surfaced in the task UI via `AgentRetryState` on the session `state` channel, mirroring the
main-chat footer.

```typescript
{
  tool: "task",
  input: {
    prompt: "Find what testing framework this project uses",
    description: "find-test-framework"
  }
}
```

### Architecture

```
packages/core/src/agent/
├── run/
│   ├── run-agent-skeleton.ts  # runAgentOnce / consumeAgentStream / ensureUIChannel
│   └── managed-span.ts        # shared stream + abort/error/empty normalization
├── subagent/
│   ├── run-subagent.ts        # Worker profile: runSubagent(), getSubagent(), destroySubagent()
│   ├── run-stats.ts           # Iteration/limit stats from UI messages + stream
│   ├── subagent-tools.ts      # Read-only tool set for subagents
│   ├── subagent-output.ts     # Cancel notice + summary truncation
│   ├── explore-prompt.ts      # Explore system prompt
│   ├── begin-summary-tool.ts  # begin_summary marker tool
│   ├── progress-summary.ts    # Iteration-limit progress-summary fallback (side-LLM)
│   ├── task-prefork.ts        # Eager parallel pre-fork (rolling window, MAX_ACTIVE_TASK_PREFORKS=4)
│   ├── task-result.ts          # task result projection (stats/notice/progress/usage)
│   ├── task-run-state.ts      # Per-task phase machine (running → summary | limit)
│   ├── subagent-runs.ts       # Per-parent task registry: phases + pre-fork seats, cleared on `/new` / `/resume`
│   ├── task-tool.ts           # createTaskTool() for parent agents
│   └── index.ts
├── tools/              # Tool subsystem
│   ├── catalog/         # tool names, base-tool assembly, ToolsRecord/tool-set
│   ├── runtime/         # define/contract, per-agent registry, context, streaming
│   ├── builtin/         # fs/ shell/ web/ session/ interaction/ implementations
│   ├── shared/          # cross-tool helpers, schemas, result/cache utilities
│   └── presentation/    # descriptors, row rules, display + format/ renderers
```

## Extension Runtime Access (what an extension can reach)

Beyond registration (`registerTool` / `registerCommand` / `registerInterceptor` / `registerContextProvider` / `registerMessageTransformer`), `ExtensionContext` exposes **live run facts** and **model access**. Every handler also receives the context as a trailing argument (`(event, ctx)`, `(input, options, ctx)`, `(args, ctx)`, section producers `(ctx)`), so a handler does not have to capture it; either way the values are read at call time, never snapshotted:

| Surface | Contract |
|---|---|
| `ctx.sessionId` / `isIdle()` / `mode` / `model` | Live session facts; `mode` is `AgentMode` (`normal` / `auto` / `plan`) — a plan *phase* is not a mode |
| `ctx.env` | The extension's **own** config map (string values from its `ExtensionConfig.config`). Not a process-environment snapshot — use `ctx.coreEnv.getEnv()` (async) for the workspace environment. |
| `ctx.signal` | The active run's `AbortSignal` (undefined when idle) — extension work cancels with the turn |
| `ctx.getMessages()` | Defensive copy of the model-visible conversation (compaction + synthetic `<ctx>` blocks); mutation cannot reach the wire |
| `ctx.getContextUsage()` | The footer's fill reading (`getContextFillTokens()` against the compaction budget), not a second estimate |
| `ctx.getSystemPrompt()` | Effective system prompt for the run |
| `ctx.llm.complete({ messages \| prompt, system?, schema?, model?, maxOutputTokens?, signal? })` | One-shot completion (text or schema-validated), outside the agent loop. Uses the **session's own connection**; `model` must be an entry that connection offers (unknown/cross-connection → typed `ExtensionLlmError`, no request). Usage is attributed to the session **automatically** (no caller-side tracker, no opt-out); `maxOutputTokens` is a ceiling (the host cap wins), a per-run call budget fails closed and is reported once as `agent:extension-error`, and an unbilled failure returns its slot. The built-in memory extension's per-turn selection (delegated to `MemoryService`) is the first consumer |

Accessor spelling on `ExtensionContext` is deliberate: value facts that cost nothing are getters (`sessionId`, `mode`, `model`, `signal`), and anything that does work or copies is a method (`isIdle()`, `getMessages()`, `getContextUsage()`, `getSystemPrompt()`). `validate:accessor-convention` only scans classes, so this rule is prose.

Context providers may publish **several named sections** (`sections: [{ name, content, disabledContent }]`), each injected as its own `<ctx kind="ext:<extensionId>:<name>">` (the base section is `<ctx kind="ext:<extensionId>">`) and admitted by its own content hash — a changing section never re-injects a stable one. The `ext:` namespace keeps extension kinds out of the core catalog's names, and ids/section names must be slugs (`[A-Za-z][A-Za-z0-9._-]*`) because the kind is recovered from message text. A throwing producer is contained to its section; a duplicate name keeps the last and warns once.

Turn/message boundaries are observable. A subagent runs the same middleware and its events up-flow into the parent scope; every event dispatched by a child carries the child's `agentId` and the parent's `parentId` in the envelope (the payloads carry no task id), so a consumer counts turns for its own agent by comparing `event.agentId` with `ctx.agentId`. The parent link is derived from the **bus scope chain**, not from each call site, so the domain objects that emit directly (`usage` / `todo` / `ui` / `stream-hub` / `plan`) carry it too — they used to produce child events with only `agentId`. `sessionId` is the owning session (a subagent has none of its own, so it reports the parent's) and is **omitted when unknown**; the old fallback stamped the agent id, which is a different identifier space. `turn:start` opens a model turn (`index` = the **run-scoped** turn, the same number `llm:request` / `llm:response` carry; `max` = the CURRENT `chat()`'s `maxIterations` budget, not `index`'s denominator), `turn:end` closes it (`index` / `finishReason` / `toolCalls`), and `message:start` / `message:end` bracket assistant messages (`firstOutput` on the run's first). `agent:iteration` stays the retained progress projection but is a **DIFFERENT scale** (per `chat()`, restarting at 1 on every tool-phase pump) — do not pair it with `turn:start.index`. None of them is default-logged. Validate: `pnpm --filter @codent/core run validate:extension-handler-context`, `validate:extension-model-access`, `validate:extension-turn-events`, `validate:extension-context-sections`, `validate:agent-event-envelope`.

Interception boundaries worth knowing: `return false` / `skipDefault` only stops later interceptors — `event.skip = true` is the tool gate; `task` children start before `tool:before:task` (a skip discards/aborts the child, it does not prevent it); client tools (`ask_user`) never reach the server-side hook. `event.modifiedArgs` is **refused** for an approval-gated tool and for `task`: the engine resolves the approval (and command-safety analysis) from the original input before the before-call hook, and a pre-forked child already started on it — so the original args run (fail closed) and the refusal is logged rather than applied. Built-in extensions declare `BUILTIN_EXTENSION_ORDER` (`-100`) so a user extension wins a same-name tool and gets the last word in an interceptor chain, despite the built-ins loading last.

**A registration is a lease, and the context is the token.** One context per instance incarnation is registered on the runner; disabling or destroying deletes it, and re-enabling hands `activate` a **new** context. Every `ctx.register*` (tool, command, output decorator, interceptor, context provider, message transformer, flush, exit flush, observer, UI slot) checks `contexts.get(id) === ctx` first, so a callback the extension retained — a timer, a promise continuation, a cached `ctx` — is refused instead of reviving a disabled extension (the registrations list had already been cleared, so nothing could have cleaned it up). The refusal is logged once per revoke. A toggle during `activate` now fails honestly (`still activating`) instead of reading the state activation starts from, and an activation revoked mid-flight (`destroyAll`) neither marks the instance active nor lands artifacts. Registering from the live context still works (the lease is re-issued, not locked). The lease also covers the two side-effecting surfaces that are **not** registrations: after a revoke `ctx.llm.complete` rejects with `ExtensionLlmError("revoked")` (a retained timer must not spend the user's tokens or the session's per-run budget), and `ctx.events.emit` becomes a no-op with `hasInterceptors()` false — an emit drives OTHER extensions' interceptors, so a revoked extension could otherwise make someone else's `tool:before:*` handler run (observer dispatch and retained state are never reachable from the facade, which only calls `intercept`). The surface itself lives in `extension/context-factory.ts` (the `ctx` literal + every lease check), the per-name ownership in `extension/registration-stacks.ts`, and the per-turn sections / providers / disabled notices in `extension/turn-context.ts`; `runner.ts` keeps only the lifecycle state machine. Validate: `validate:extension-lifecycle-lease`.

Roadmap (not built yet): **write** capabilities (`ctx.abort`, `ctx.compact`, session writes, `ctx.executeTool`) → interactive UI requests / provider+MCP registration / reload / trust gate → streaming completions.

## Extension Point: Message Transformers

`ExtensionContext` offers registration channels — `registerTool` / `registerToolOutputDecorator` / `registerCommand` / `registerInterceptor` / `registerContextProvider` / `registerMessageTransformer` / `registerFlush` / `registerExitFlush` (plus the bus-backed `ctx.events.observe`). `registerMessageTransformer(fn)` is the only one that edits **the message chain the model sees**. Use it for media-to-text (e.g. describe an image through an out-of-process multimodal endpoint before handing it to a text-only model), redaction, trimming to a budget, or wire-only context injection. Hook event types (`ToolBeforeEvent`, `SessionStartEvent`, …) are exported from `@codent/core`, so a TypeScript extension types its handler instead of re-declaring the shape.

```ts
ctx.registerMessageTransformer((c) => {
  if (c.modelHasVision || !c.unsupportedPartTypes.has("image")) return; // model can see it
  return c.messages.map((m) => replaceImagePartsWithText(m));
});
```

| Property | Behaviour |
|----------|-----------|
| Registration | `ctx.registerMessageTransformer(fn)` returns a disposer. **At most one per extension** — re-registering replaces, and a stale disposer is inert. Cleared when the extension is disabled or destroyed. |
| Position | A dedicated `message-transform` middleware running **immediately after `compaction`**. `compaction` is channel-anchored (it rebuilds the wire from the UI channel and ignores `config.messages`), so anything placed before it applies to the first call and is silently discarded afterwards. The capability strip and the `max_tokens` continuation prompt are the two shipped examples of that trap — both were dead until the `wire-recovery` middleware (which runs after the transform) took over applying them from per-run state. |
| Invoked | Once per model call — `init` and every later iteration — because every restart-style retry rebuilds the `chat()` engine and re-runs init `onConfig`. |
| Sees | The projected wire, including synthetic `<ctx kind=...>` messages (turn context / background notifications), which live on **both** the channel and the wire. Edits from middleware that rewrite only `config.messages` *before* the projection are not visible. |
| Returns | A replacement `ModelMessage[]`; `void` or a non-array leaves the previous value. **Wire-only** — output is never written to the UI channel, the session store, or any durable state, and never reused as a later run's input. |
| Ownership | You get a fresh outer array, fresh message objects **and** fresh content containers (the `content` array, each part object, and one nested object such as an image `source`), so in-place edits — `part.text = …`, `part.source.data = …`, pushing a part — stay on your copy and cannot reach the wire-projection cache or the persisted channel. Primitive values (base64) are shared because they are immutable. |
| Capabilities | `ctx.capabilities` carries the raw declared set, or `null` when **unknown** — `null` and an empty set are different on purpose (`null` = nothing declared, all `modelHas*` booleans `true`; `∅` = declared, none apply, all booleans `false`). `ctx.unsupportedPartTypes` is this run's EFFECTIVE multimodal strip set — the probe's, or the wider one a rejection armed for the run (the flags below stay the probe's: they describe what the model declares, the set describes what this run will drop). Every capability also gets a flat boolean named `modelHas<Capability>` in PascalCase (`modelHasVision`, `modelHasToolCalling`, …), one per entry of `MODEL_CAPABILITIES`. All come from the same probe that gates pre-send stripping (the drop set also reflects a run-level widening), so an extension never re-derives model ability from host config. The list lives once in `models/types.ts`: `MODEL_CAPABILITIES` is the runtime array, `ModelCapability` is derived from it, and `MODEL_CAPABILITY_FLAGS` (exhaustively keyed by that union) names each boolean — so adding a capability is a compile error until it is named, not a silently missing flag. Every member must be evidenceable from provider metadata; unproducible members (`streaming`, `computer_use`) were removed. |
| Failure | A throw logs a warning + emits `agent:extension-error` with `phase: "message-transform"`; the last valid message set is kept and the run continues. Multiple transformers chain in extension load order. |
| Scope | Subagents do **not** inherit the parent's transformers. In a `REMOTE_SESSION` host the transformer runs **server-side** — put an external endpoint's API key in the server environment. Disk-loading hosts only; browser-only hosts (WebContainer playground) cannot load extensions. |

It is deliberately **not** an `AgentEventBus` interceptor: interceptor mode is a shared mutable payload with cancel short-circuit, whereas a transform returns a replacement array. `AgentEventBus` gains no third dispatch mode, and no `message-transform` name appears in the interceptor pattern list.

Validate: `pnpm --filter @codent/core run validate:extension-message-transform` (registration/ownership/wire-only/zero-overhead/placement), `validate:extension-tool-restore` (a disabled extension gives back the tool it shadowed — including the built-in it overwrote and that tool's `toModelOutput` handler — in every disable order, and the same extension id loaded onto two agents stays two independent claims — the two registries are process-global, so `ManagedAgent` namespaces the owner id by agent), `validate:wire-override-reaches-adapter` (drives a real `AgentRunner` + `chat()` and asserts the capability strip and continuation prompt reach the adapter), and `validate:middleware-order` (the adjacency is asserted against the pipeline `buildAgentRunner` actually assembles — phase sorting cannot order same-phase middlewares, so the array position decides it).

## Built-in LSP Extension

CLI local mode enables the built-in LSP extension when `ManagedAgentConfig.lsp !== false` (`createLspExtension()` in `agent-factory.ts`). Requires `@codent/node` (`CoreEnv.createLspConnection`); remote/extension hosts degrade gracefully.

| Tool | Purpose |
|------|---------|
| `lsp_diagnostics` / `lsp_hover` / `lsp_definition` / `lsp_references` / `lsp_symbols` / `lsp_completions` | Standard LSP queries (always registered) |
| `lsp_rename` / `lsp_code_actions` | LSP queries skipped by default (`DEFAULT_DISABLED_LSP_TOOLS`) to save per-turn context — re-enable via `lsp: { enableAll: true }` or omit them from `disabledTools` |
| `ast_search` / `code_rewrite` / `code_overview` | Structural tree-sitter tools skipped by default — re-enable via `lsp: { enableAll: true }`. `ast_search`/`code_rewrite` are structure search/rewrite (no LSP equivalent); `code_overview` overlaps `lsp_symbols`. `code_rewrite` writes with `dry_run: false`, so it declares `needsApproval: true` — a static flag, which means a preview asks too (it is off by default; the alternative was a bulk multi-file write with no prompt at all). Plan mode additionally withholds it as an `edits` tool. |

**Config:** workspace `.lsp.json` (`autoStart`, `servers`, `lombokJar`, `autoInjectDiagnostics`). Commands: `/lsp`, `/lsp-restart`, `/lsp-config`.

#### Per-tool toggle — `ManagedAgentConfig.lsp`

`lsp` accepts `boolean` (existing) or an object: `{ disabledTools?: string[], enableAll?: boolean }`.
- Default: low-usage tools are skipped (`DEFAULT_DISABLED_LSP_TOOLS`: `lsp_rename`, `lsp_code_actions`, `ast_search`, `code_rewrite`, `code_overview`).
- `enableAll: true` re-enables every tool.
- `disabledTools` replaces the default set (no merge). Example: `lsp: { disabledTools: [] }` registers everything; `lsp: { disabledTools: ["lsp_hover"] }` disables hover only.

#### `.lsp.json` — LSP server configuration

Workspace-root `.lsp.json` customizes which language servers run and how. All fields are optional.

```jsonc
{
  "autoStart": ["typescript", "python"],     // languages starting immediately on session open
  "servers": {                                 // keyed by language ID (see EXT_TO_LANGUAGE in lsp/language-map.ts)
    "python": { "command": "basedpyright-langserver", "args": ["--stdio"] },
    "php":   { "command": "phpactor", "args": ["language-server"] }
  },
  "lombokJar": "auto",                         // "auto" = env LOMBOK_JAR + auto-detect
  "autoInjectDiagnostics": true                 // inject diagnostics into write/edit results: true | false | [langIDs]
}
```

**Server entry fields** (`LspServerConfigRecord`): `command` (required), `args` (string[], default `[]`), `env` (extra env vars), `initializationOptions` (LSP `initialize` handshake options), `settings` (returned for `workspace/configuration` requests, keyed by section).

**Built-in defaults** (`DEFAULT_SERVERS` in `lsp-manager.ts`): typescript/javascript/react via `typescript-language-server`, rust via `rust-analyzer`, python via `pyright-langserver`, go via `gopls`, java via `jdtls` (+Lombok), plus clangd (c/cpp), bash-language-server, vscode-{json,css,html}-languageserver, omnisharp (csharp), lua-language-server, phpactor, solargraph (ruby), elixir-ls, sourcekit-lsp (swift). On Node hosts the LSP extension **probes each server binary before spawning** (`CoreEnv.commandExists`) and skips missing ones with a clear hint — so listing extra defaults is harmless when the tool isn't installed. Resolution prefers the project-local `node_modules/.bin/<command>` (a devDependency server works without a global install) and falls back to PATH; the probe and the spawn share the same resolver (`node/src/lsp/resolve-command.ts`).

**`/lsp` status legend:** 🟢 running · ⚪ configured but idle · 🔴 configured but command not found · 🔵 language mapped in `EXT_TO_LANGUAGE` but no server configured (add one to `.lsp.json` `servers` to enable).

**Parity notes (vs pi-lsp-extension):** Java jdtls gets Lombok via `findLombokJar()` (`LOMBOK_JAR`, explicit path, or `env/Lombok-*` auto-detect). `lsp_symbols` and `lsp_definition` fall back to `WorkspaceIndex` / `findDefinition`. `lsp_completions` supports synthetic-dot member completion with `FileSync` version coordination. Auto-injected write/edit diagnostics (`tool:after:*` interceptors parse JSON-string args and set `modifiedResult` for the extensions middleware) wait for the `publishDiagnostics` notification that follows the write instead of polling for errors — a clean file publishes an empty list, so a successful edit returns as soon as analysis finishes rather than always burning the settle timeout. A write whose server is still starting waits at most `FIRST_SYNC_WAIT_MS`; the missed sync is replayed by `FileSync.flushPendingSync` when the server reports ready, so the file is deferred to the server, never dropped. LSP tool results use plain-text `toModelOutput` (`output.text`).

Validate: `pnpm --filter @codent/core run validate:lsp-parity`, `validate:lsp-interceptor`, `validate:lsp-server-probe`, `validate:lsp-tool-toggle`, `validate:lsp-transport`, `validate:lsp-lifecycle`, `validate:lsp-midstartup-shutdown`, `validate:lsp-extension`, `validate:lsp-real-server` (needs a real `typescript-language-server`, skips otherwise), `validate:tree-sitter`; `pnpm --filter @codent/node run validate:lsp-command-exists`. The `validate-lsp-*.mjs` scripts and their mock servers live in `packages/core/scripts/`.

## Built-in Code Mode Extension

Sandboxed TypeScript execution via TanStack [`ai-code-mode`](https://tanstack.com/ai) — lets the model write and run TypeScript inside a secure isolated V8 context instead of only issuing read-only tool calls.

Enabled when `ManagedAgentConfig.codeMode !== false` (`createCodeModeExtension()` in `agent-factory.ts`). The extension **feature-detects** the optional CoreEnv capability `createIsolateDriver()`: if the host provides one, code mode is wired up; otherwise it warns and registers nothing (graceful degrade, no native deps in `@codent/core`). The Node host implements it via `@tanstack/ai-isolate-node` (backed by `isolated-vm`); browser/WebContainer hosts omit it and code mode stays off.

| Tool | Purpose |
|------|---------|
| `execute_typescript` | Run model-written TypeScript in a secure V8 isolate, with a curated subset of agent tools exposed as `external_*` functions inside the sandbox |
| `discover_tools` | Companion tool registered only when at least one external tool is marked `lazy` — lets the model discover lazy tools on demand |

**Tool subset (kept deliberately small):** only a curated set is exposed to the sandbox as `external_*` bindings — read-only fs tools eager (`read_file`/`grep`/`glob`/`list_file`/`tree`), plus `websearch` lazy. `run_command` is also requested as a lazy binding, but it declares `needsApproval` and is **skipped by default**: a sandbox `external_*` call runs the raw tool execute and cannot participate in the host approval/interceptor chain. Set `codeMode.allowApprovalTools: true` only when that boundary is intentionally accepted. Interactive / stateful tools (`ask_user`, `task`, `todo`, plan tools) are excluded — including `get_command_output` / `kill_command`, so a background job started inside the sandbox is read through its log file via `read_file` (see the `run_command` section) and is polled/killed by the outer agent. Lazy tools stay out of the system prompt's full type stubs and are listed in a discoverable catalog instead (`discover_tools`), keeping the per-turn prompt small (progressive disclosure). The curated bindings are snapshotted from the base toolset before user extensions load, so an extension that later shadows `read_file`/`run_command` cannot change what the sandbox executes.

**Per-turn system prompt:** the extension injects code-mode guidance through `registerContextProvider` (its own `<ctx kind="ext:codent-code-mode">` section) documenting the sandbox API + `external_*` bindings. There is no system-prompt append channel — `before_agent_start` is observe-only.

**Config:** `ManagedAgentConfig.codeMode` accepts `boolean` (default `true`) or `{ timeout?, memoryLimit?, lazyToolsConfig?, allowApprovalTools? }`. The isolate backend must be a CoreEnv optional capability: `createIsolateDriver?(): Promise<IsolateDriver | null> | IsolateDriver | null` (`IsolateDriver` from `@tanstack/ai-code-mode`, type-only — zero native deps in core). Module map: `packages/core/src/agent/code-mode/` (`extension.ts`, `index.ts`); Node host: `packages/node/src/environment/isolate-driver.ts` (lazy-loads `ai-isolate-node`, returns `null` on failure).

Validate: `pnpm --filter @codent/core run validate:code-mode-extension` and `pnpm --filter @codent/node run validate:code-mode-assembly`.

## Skill System

Skills provide on-demand domain knowledge via progressive disclosure — only the skill
**index** (name + description) is always visible; full instructions load on demand.

| Layer | Mechanism | Tokens |
|-------|-----------|--------|
| Index | `<skills>` injected into per-turn `<extension_context>` by `codent-skills` | ~100/skill |
| Discovery | `list_skills` tool | ~100/skill |
| Content | `load_skill` tool for full SKILL.md | ~2000+/skill |

Skills are defined in `SKILL.md` files with YAML frontmatter (name + description required).
The built-in **`codent-skills` extension** (`config.skills`, default on) registers the
`list_skills`/`load_skill` tools and injects the available-skills index into each turn's
`<extension_context>` — it no longer lives in the frozen system prompt.

**Config:** `ManagedAgentConfig.skills` accepts `boolean` (default `true`) or
`{ toolsDisabled?, indexDisabled? }`. `skillDirs` adds scan directories (defaults to
`AGENT_SKILL_DIRS`, `~/.agents/skills`, `.agents/skills`) — e.g. add `.cursor/skills` or
`.opencode/skills` to reuse skills written for other harnesses. Module map:
`packages/core/src/agent/skills/` (`extension.ts`, `skill-loader.ts`, `skill-registry.ts`, `index.ts`).
Validate: `pnpm --filter @codent/core run validate:skills-extension`.

## Context Compaction System

Three-layer context compaction (plus reactive compaction) for infinite agent sessions:

| Layer | Name | Trigger | Action |
|-------|------|---------|--------|
| Layer 1 | `tool_compact` | Every LLM call | `toModelOutput` transforms (cached per toolCallId) |
| Layer 2 | `reasoning_stripping` | Every LLM call (DeepSeek models) | Strip reasoning content from history to optimize prefix cache |
| Layer 3 | `auto_compact` | Token threshold exceeded | LLM summarization |
| Reactive | `reactive_compact` | Context-overflow API error (provider `code` first, prose fallback) | Emergency compaction, then retry |

**Configuration:** `compaction` option on `createManagedAgent`:
```typescript
compaction: {
  tokenThreshold: 100000,   // legacy absolute trigger (fallback when model window unknown)
  keepRecentTokens: 40_000, // token budget for the kept window (the only keep policy)
  // keepRecentTokens: 24000,  // explicit kept-window token budget (optional)
  // reserveTokens: 16384,     // headroom for summary + next turn (kept-window derivation)
}
```

**Keep policy — token budget only:** The kept window is decided by `resolveKeepPolicy()` (`keep-policy.ts`), which always returns a token budget (`kind: "tokens"`): explicit `keepRecentTokens` > derived from the model context window (a bounded fraction, `KEEP_RECENT_WINDOW_MIN`..`KEEP_RECENT_WINDOW_CAP`) > derived from `DEFAULT_SUMMARIZATION_CONTEXT_WINDOW` when the window is unknown. The turn-counting policy (`keepRecentFlows`) and its `findCutPoint()` were removed — there is no legacy fallback, so every session compacts on the same rule. Compact-time and wire-projection-time always share the same resolved policy.

**Auto-compact trigger:** The trigger base is the **working budget** — `tokenThreshold`, the same number the UI percentage uses. The agent factory auto-fills it as `min(contextWindow, MAX_THRESHOLD=400k)` when unset, so a huge models.dev window (e.g. 1M) never defers compaction past the displayed budget; the threshold is clamped to the real window so an oversized config cannot defer past what the model accepts (`shouldTriggerAutoCompact`, `resolveAutoCompactTrigger`). Trigger point = `min(tokenThreshold, contextWindow) * compactAtPercent / 100` — with the defaults (`COMPACTION_CONFIG_DEFAULTS.compactAtPercent = 80`) that is `400k × 80% = 320k` for every model whose window is ≥ 400k, and the footer's `X% of <budget>` reports the fill against that budget, **not** against the model's raw window (a 1M-window model shows `… of 400.00k`). The budget label uses `formatCompactNumber`, whose decimals are **fixed per unit** (`400.00k`, `2.7M`) rather than trimmed: the footer counter is animated, so a width that moved with trailing zeros would reflow the segment on every tick.

**Auto-compact cut-point strategy:** `findCutPointByBudget()` walks backward accumulating estimated tokens until the budget is reached and cuts at the nearest pairing-safe boundary (user/assistant only — never on a tool result, so call/result pairs stay intact). If the cut lands inside a turn (**split turn**), the discarded turn prefix is summarized separately under `<turn_prefix>` and merged into the SUMMARY; the suffix stays intact. It skips in-chain summaries and synthetic `<ctx kind=...>` messages. Everything before the cut is summarized; the kept portion remains in the main agent context.

**Summarizer input:** The summarization subagent receives labeled segments — `<to_compress>` (pre-cut history), `<turn_prefix>` (split-turn prefix, dedicated prompt), and `<still_in_context>` (kept turns) — plus optional `<previous-summary>` for incremental updates. Prompt rules tell the model to summarize the compressed segment thoroughly and use the kept segment only to align Goal/Next (no detailed restatement).

**Post-compact (same request):** Append `[CONVERSATION SUMMARY]` onto the UI channel (chronological SoT). Compaction middleware then projects summary-first wire from the **live channel** and never writes the projection back. Auto-compact does not run again until a new durable message lands after that SUMMARY (window reset would otherwise re-trigger via `estimateTokens`). Recovery (context-overflow / retries) re-reads `managed.ui.getMessages()` live so mid-run appends are visible.

**No transcript archive.** Compaction only *appends* the SUMMARY to the channel; it never removes the pre-cut messages, and the session is persisted from that channel — so `.agents/sessions/<id>.session.jsonl` retains the whole conversation and the summary is purely additive. The former `.agents/transcripts/<sessionId>/compact-<n>.md` archive was a derived, lower-fidelity duplicate of messages still in the log and has been **removed** (writer, summary `## Compact archives` list, and prompts). `stripCompactArchiveSections` remains only to drop the section from summaries persisted before the removal. Recall of compacted-away detail goes through the `session_search` / `session_read` tools over the session log.

**How the model is told to search past conversation** lives in exactly one place: the `session_retrieval` turn-context section (`agent/turn-context/session-retrieval.ts`), emitted when the workspace has history. The gate is evaluated once per agent, and the body holds no counts, so the section stays byte-stable and does not churn the prompt cache.

> Module map: `packages/core/src/agent/compaction/` — `tool-compact/` (Layer 1 transforms), `auto-compact.ts` (Layer 3), `keep-policy.ts` (`resolveKeepPolicy`), `cut-point.ts` (`findCutPointByBudget` / `extractExistingSummary`), `reactive-compact.ts`, `apply-compaction-result.ts`, `compaction-summary.ts`, `message-chain-projection.ts` (`getModelVisibleMessages`), `compaction-prompt.ts`, `serialize-conversation.ts`, `token-estimator.ts`, `index.ts`.

**Reasoning stripping (Layer 2)** is disabled in `compaction-middleware.ts` because DeepSeek thinking mode requires `reasoning_content` echo-back. DeepSeek endpoints use `ReasoningChatCompletionsTextAdapter`, which maps stream `reasoning_content` into `thinking` and writes it back on subsequent requests.

**Reactive compaction** runs via `runStreamWithRecovery` (`managers/run-stream-recovery.ts`) — on a **context-overflow** error (`isPromptTooLongError` in `agent/compaction/reactive-compact.ts` classifies it **by the provider's stable `code` first** — `context_overflow` / `context_length_exceeded` / `model_context_window_exceeded` / `prompt_too_long` — and falls back to prose only when no usable code is present; `CONTEXT_OVERFLOW_CODES` is the set), `ManagedAgent.handleReactiveCompact()` appends a SUMMARY onto the live UI channel and retries (skipped for subagents). The retained tail is selected by token budget at a pairing-safe boundary (`selectReactiveTail`), degrading to the latest valid boundary when everything fits the budget — progress is always guaranteed. `getMessages` is a live channel read so the retry does not reuse a pre-run snapshot. The same shell also retries **transient** provider errors (429 / rate-limit / 502–504 / network) with exponential backoff for both main agent and subagents (honors Retry-After when available).

## Workspace `.agents/` layout

Runtime data under the project root is grouped under a single gitignored `.agents/` directory (alongside config such as skills / MCP / extensions):

| Path | Purpose |
|------|---------|
| `.agents/sessions/` | Session message log (`*.session.jsonl`, one line per message + state; timestamps live on the message) |
| `.agents/logs/<sessionId>/` | AgentLog JSONL event timeline (`agent.log`, size-rotated; written by the built-in log extension) |
| `.agents/usage/` | Global usage history (`usage-<year>.jsonl`, per-LLM-call records) |
| `.agents/config/models.json` | Model provider entries + `global.toolConfig` (websearch keys/provider). The TUI **and** `codent acp` merge that block UNDER their env-derived value (`BRAVE_API_KEY` / `EXA_API_KEY` / `PARALLEL_API_KEY` / `TAVILY_API_KEY` / `WEBSEARCH_PROVIDER`, via `websearchToolConfigFromEnv`). Runtime knobs (`maxIterations` / `mcpConfigPath` / `systemPrompt`) are flags/env, never this file |
| `.agents/memory/` | Cross-session memory markdown + `MEMORY.md` |
| `.agents/cache/tool-output/` | Large tool-output spill files (`*.txt`) — GC'd two ways: reference-based on compaction **and** a 7-day age sweep (`sweepStaleToolOutput`, lazy on first cache write of a process). The age sweep is the only thing that collects files from sessions that never compacted, and files no session ever referenced |
| `.agents/cache/command-jobs/` | Background shell jobs: durable per-job logs (`.log`, 24 h sweep) + per-job records (`.json`, 7 days, scoped to the session that started the job). On resume, a `running` record is marked interrupted and an un-notified completion is re-delivered; a graceful quit keeps terminal un-notified records; the record keeps the status/tail after its log is swept |
| `.agents/cache/models-dev.json` | models.dev metadata disk cache |
| `.agents/plans/` | Saved plan markdown |
| `.agents/skills/` | Project skills |
| `.agents/extension/` | Project extensions |
| `.agents/mcp.json` | Project MCP config |

## Sandbox Environment Configuration

Configure via `--sandbox <local|native>` (CLI and ACP), `SANDBOX_ENV`, or programmatically.
Precedence: explicit flag > env > default.

| Value | Description |
|-------|-------------|
| `local` | (default) Real bash + OS sandbox via `@anthropic-ai/sandbox-runtime` |
| `native` | Real bash and Node.js fs, no OS sandbox |

Programmatic equivalent: `createNodeEnv({ rootPath, mode: "os" | "native" })`. Env var: `SANDBOX_ENV=local` in `.env` (see README). The CLI TUI, both ACP entry points (`codent acp`, `codent-acp`) and the server entry accept the flag (`SANDBOX_ENV` stays the service-friendly route).

## Tool Output Truncation

### grep / glob Tool — what a search may look at

Both tools resolve **one** `SearchPolicy` (`agent/tools/builtin/fs/search/search-policy.ts`) and hand
it to every engine, so `rg`, `git grep` and `grep` cannot disagree about what the workspace is:

- **The repository's own ignore rules decide** (`.gitignore` + `.git/info/exclude` + global
  excludes). That is what every other coding agent does, and it is the only list that cannot fall
  behind: a hand-kept set of directory names is why a repo-wide `grep` here used to walk `.agents/`
  (524 MB of session logs — **12.6 s** for a search `git grep` answers in **57 ms**, with 17% of
  the returned rows being session-log paths).
- **The runtime data directory is excluded by derivation, not by name**: `AGENT_DATA_DIR` (`.agents`)
  is the floor for a non-git workspace, alongside the build/dependency defaults. A workspace with no
  git still never greps its own transcripts.
- **Explicit intent wins.** A `path` inside an excluded/ignored tree reopens it
  (`git check-ignore` decides), so `grep({ path: ".agents/sessions" })` still works. Ignoring is a
  default, not a cage — the tool description says so, because otherwise a model can only rediscover
  the escape by trial and error.

Engine ladder: `rg` (`--no-config`, `.gitignore` honoured, `--no-ignore` only for an explicit
target) → **`git grep --untracked`** when `rg` is absent (same ignore semantics, untracked files
included, ~50 ms) → `grep -r` with `--exclude-dir` from the policy. `glob` is the same ladder with
`fd` → `git ls-files --cached --others --exclude-standard` → `find`. The legacy no-`execFile` host
path keeps the policy's directory list (no VCS rung).

- Max 500 chars per matching line content
- Max 50KB total content across all matches
- Validate: `validate:search-ignore-policy` (real temp repo: ignored tree skipped, untracked file
  found, explicit path reopens, `glob` agrees, `--no-config` always / `--no-ignore` never by
  default, `git grep` answers without ripgrep), plus `validate:search-fallback`,
  `validate:search-path-containment`, `validate:search-abort`.

### read_file Tool

| Type | Extensions | Behavior |
|------|------------|----------|
| Text | `.ts`, `.js`, `.py`, `.md`, etc. | Line-numbered content, offset/limit pagination |
| Directory | (path to directory) | List of entries |
| Image | `.png`, `.jpg`, `.gif`, `.webp` (not SVG) | Vision part for the model; budget uses vision-token estimate (dimensions / size), not base64-as-text |
| PDF | `.pdf` | Extracted text in the tool text part (Completions-safe) + `document` part for Anthropic-style providers |
| Binary | `.mp3`, `.zip`, `.exe`, etc. | Error (cannot read) |

**Text limits:** 2000 lines default, max 100KB, max 2000 chars/line.

**Chat Completions note:** Multimodal tool images are lifted to a synthetic user `image_url` message (`liftToolMediaForChatCompletions`). PDF binaries are not liftable on Completions — rely on extracted text.

### run_command Tool
- Max 50KB for stdout and stderr each
- Keeps the **end** of output (most relevant for errors)

**Background jobs (`run_in_background`) and their log.** Output is retained in memory (head-trimmed: 256K/stream running, 64K/stream finished, 50 finished jobs kept) **and** tee'd to a durable log at `.agents/cache/command-jobs/<jobId>.log`, whose workspace-relative path is returned as `cachedOutputPath` by `run_command` (background) and `get_command_output`. A sibling `<jobId>.json` record persists the status, exit code, pid (when known), output tail and `notified` flag, scoped to the disk session that **started** the job (snapshotted per job, so `/new`/`/resume` switching the live id cannot re-file it): on a process restart the registry restores completed jobs (so `get_command_output`/`kill_command` still answer and an un-notified completion is delivered once), marks a still-`running` record as interrupted (trusting a terminal footer in the log when the crash landed after finish), and leaves another session's records alone. A graceful teardown (`destroyAll`) keeps terminal **un-notified** records/logs for the next resume and deletes the rest; a running job's process is **not** reaped on restart (no supervisor), and its pid is informational. Records are kept 7 days; logs keep the 24 h sweep, so a notification can still carry the status/tail after its full log is gone. A **`<background_jobs>` pointer** (`listForTurnContext`: job id, command, status/exit code, log path; no output) is the safety net for the one-shot notification: compaction summarizes a prefix away, so the notification that delivered a result is usually still visible *until* a later cut drops it. The pointer lists only jobs whose `run_command` tool call is still in the model-visible wire **and** that the wire does not already announce (the notification carries `jobs="id,…"`, so this is a set check, not prose parsing) — running jobs have no notification, so they are listed too. It is admitted by content like every other kind (a cut that dropped it re-admits it, a surviving copy keeps it) and re-lists a job once its announcement is summarized away. Running jobs come first; the list is capped at five. The model can also poll any job through `get_command_output`, so the pointer stays metadata-only. Ownership: `managers/services/agent-command-service.ts` owns the per-agent registry, its durable restore and that section; `background-middleware` owns delivering it (hash-admitted against the wire) together with the one-shot completion push. **An idle session is woken** rather than left waiting for the user's next message: a terminal transition reports `finished`, `ManagedAgent` peeks the completion queue and starts one turn, and the middleware injects+marks inside it (see the turn-context background-push bullet).
- one file per job, chunks appended in arrival order, stderr lines marked `[stderr] `;
- header (`# <command>` + start time) on creation, terminal footer `[exit <code> · <status> · finished <iso>]` — **no footer means still running**;
- **unbounded by design**: the log is never sized against a cap and never truncated — background output is always written. Disk growth is bounded by the 24 h stale sweep plus deletion with the job record, not by cutting the file, so `read_file` line offsets stay valid for as long as the file exists;
- deleted with the job record (registry eviction / the agent-owned registry's `destroyAll()`); logs older than 24 h are swept once per process; a host whose fs lacks `appendFile` degrades to `cachedOutputPath: null`;
- it must **not** live under `.agents/cache/tool-output/`, which `cleanupOrphanedToolCache` GCs against message references (it would delete a running job's log).

This is also how a code-mode sandbox reads background output: `read_file` is exposed there, `get_command_output` is not.

### Streaming UI (`@codent/app`)
- **Transcript static region (per-row caching):** every completed row in `MessageList` is its own
  `<StaticRender>` leaf, keyed on a **per-row** signature (`getMessages` returns `staticSignatures`,
  one entry per row, built from `computeMessageRenderSignature`). So one row's state advancing
  re-caches only that row — do **not** reintroduce a transcript-wide signature (the old
  `toolCallsSignature` / `computeToolCallsRenderSignature` fold) into any cache dependency, and do
  not wrap the whole row list in one `<StaticRender>`: either one makes every row depend on every
  other row, which is the jank this replaced.
  - Rows are **per part**, so a row id is `<messageId>-<partIndex>` (e.g. `call-7-0-1`), and the
    store's `itemSigs` is positional against `useStatic.list` — always written together via the
    single `setStaticList(items, signatures)` action.
  - The row array must be rebuilt whenever **any** row signature moves (the elements carry their
    own `deps`); freezing the array on a row-*set* key pins changed rows to stale renders.
- **Transcript truncation is a LINE budget:** `MAX_STATIC_LINES` (in `MessageList`) caps the
  completed region by accumulated rendered height, not message count. Heights come from each row's
  `onRender` → `measureElement` (`useStaticHeights`, keyed by row id, pruned to the rendered set);
  rows never measured get `PROVISIONAL_ROW_LINES`, which must stay stable so a selection never
  oscillates as measurements land, and conservative so a cold mount never truncates harder than the
  message-count cap it replaced. The hidden-marker total is **one subtraction**, in messages:
  `staticSourceTotal - countSourceMessages(visibleRows)` (`getMessages` reports the static-side
  total; a compact activity row expands to its `sourceMessageIds`). A message counts as hidden only
  when no visible row represents it, so a cut inside a message's parts does not over-report. Note
  the worker's screen model keeps ~1000 lines and evicts history only when a **single frame**
  exceeds it — raising that limit is not the fix for long sessions.
  - **The welcome panel sits OUTSIDE this budget** (`Content` renders it as its own `<StaticRender>`
    keyed on `headerSet`). It is the user's orientation and the only element pinned to the top of
    the transcript, so the budget must never be able to drop it. Do not prepend it to the row list.
  - **Prune measured heights by the DERIVED row set, never by the visible subset.**
    `selectVisibleRows` decides visibility *from* those heights, so pruning by the visible subset
    makes the two chase each other and the kept window oscillates as messages arrive.
  - **`width`/`theme`/`diffMode` belong in the element-array rebuild key, not the per-row deps.**
    Rebuilding the array is the only thing that gives rows new deps, so the key is where those
    values take effect; putting them in both is redundant and makes one toggle cost two rebuilds.
  - **`onRender` fires once on a pre-layout pass at `width 0`** with a width-derived bogus height
    (`2 * columns - 2`); caching then yields a 0-line region and the post-cache pass reports
    `height 0`, which the recorder rejects — so the bogus value would stick. Gate the first
    publication on a known width. Measuring from inside a row cannot substitute: a cached row's
    inner Yoga subtree is detached, so inner refs measure `NaN`.
  - **A row's cache deps must include every store it subscribes to**, not just its props: `mode`,
    `theme` and `useDiffRenderer` are all read *inside* the row subtree (`MessageDiffView`
    subscribes to the diff renderer), so each has to reach a cache input. Grep the row subtree for
    stores before adding a cache unit.
- **Truncation marker** (`... N older messages hidden`) caches with the rows it describes and is a
  single element (`key="truncation-marker"`), counted in MESSAGES while the budget is counted in LINES.
- **`run_command`:** Core emits every chunk through the per-agent `AgentStreamHub` onto the session `tool` channel
  (`chunk` / `clear` by `toolCallId`); throttling is applied in the app layer.
  `useStreamingOutput(toolCallId, { throttleMs })` / `StreamingOutputView` (default `0` = every chunk).
  `ToolCallPartView` defaults `run_command` to 100ms; pass `streamingThrottleMs` to override.
- **Task / compact summary:** Core `AgentStreamHub` multicasts `reset` / `append` / `end` on the session
  `summary` channel. Task keys are `task:${toolCallId}`; compact keys are stable `compact:${agentId}`
  (single-flight per agent). App `useSummaryStream` / `useCompactSummaryText` keep a fixed line window
  (`pendingLine` + overflow indicator). Do not route summary text through `StreamingOutputView`.
- **Compact transcript (`/appearance compact`):** the density mode has two layers that must agree:
  - *Projection* (`packages/app/src/utils/project-transcript.ts`) folds contiguous **completed**
    tool calls into one synthesized activity-summary row (`display-activity:<turn>:<seq>`). Only the
    static (non-streaming) portion is projected; the live message renders as-is. The row carries the
    source message ids it stands for (`sourceMessageIds`), because the truncation marker counts
    **source messages**: a fold is display, not hidden history, and counting the row as one reported
    a phantom "... N older messages hidden" line (the line budget dropping a fold must likewise
    report every message behind it).
  - *Render* (`packages/app/src/messages/ToolOutputView.tsx`, `ToolInputView.tsx`) hides bulky
    blocks; input lines clamp to 72 chars, result blocks to a single 200-char line.
  - A tool **keeps its row and its one-line result** when `keepsCompactRow(name)` is true
    (core: `agent/tools/presentation/row-rules.ts`, re-exported by app `utils/tool-display.ts`):
    structured built-ins (`present.keepRow`: `ask_user`, `todo`, `complete_plan`), host-supplied
    results (`present.clientSide`) or any tool with a `present.text` renderer (extension tools —
    that string is a one-line contract). Everything else folds; errored rows always fold as an
    `error` count because the render layer hides them.
  - Folded tools group by the tool's `present.category` (fold bucket). Tools with no bucket are named
    in the summary (`ext_echo ×2`) rather than collapsing into an opaque `N other`; `present.label(input)`
    adds a short label. Tools (extensions included) declare all of this through one field —
    `defineServerTool({ present })` / `registerTool({ present })` — read back via
    `getToolPresentation` on the session (or the built-in fallback); see `packages/core/src/agent/tools/presentation/types.ts`.
    Every descriptor function must be a pure function of the stored output (or parsed input).

## CLI Keyboard Shortcuts

| Key | When Running | When Idle | When Approval Pending |
|-----|--------------|-----------|----------------------|
| `Esc` | Aborts current agent run (clears queued messages) — or a running `/compact` | - | Cancel deny-reason input |
| `Ctrl+C` | Exits the app | Exits the app | Exits the app |
| `Ctrl+U` | Clear input | Clear input | - |
| `Ctrl+A` | Select all | Select all | - |
| `Ctrl+V` | Paste image | Paste image | - |
| `Ctrl+E` | - | Toggle workspace browser | - |
| `Ctrl+T` | - | Task / subagent panel | - |
| `Ctrl+Y` | - | Extensions panel | - |
| `Shift+Tab` | - | Cycle mode (normal → auto → plan) | - |
| `y` | - | - | Approve (when input empty) |
| `n` | - | - | Enter deny-reason mode |
| `↑/↓` | - | Navigate history / autocomplete | Navigate autocomplete |
| `Enter` | Queue follow-up (delivered when the agent would stop) | Submit input | Submit deny reason |
| `Option`/`Ctrl+Enter` (macOS) or `Shift+Enter` | Force-submit (abort current run, start new turn) | Insert newline (`Shift+Enter`) | - |
| `/...` | - | Slash commands | Slash commands |

Note: In the TUI, modifier chords use **Ctrl** (not Cmd/⌘). On macOS, prefer `Option+Enter` or `Ctrl+Enter` for force-submit / newline — plain `Shift+Enter` often cannot be distinguished from Enter. Shortcut labels are centralized in `packages/app/src/utils/keyboard-labels.ts`.

**Workspace browser (`Ctrl+E`) keys:** `↑/↓` move the tree cursor (and scroll the list), `Tab` switches preview/diff, `←/→` move focus between tree and preview, `Enter` opens, `e` opens the selected file in `$VISUAL`/`$EDITOR` (TUI suspends; the session keeps running), `[`/`]` jump between changed files, `Ctrl+P` fuzzy-find, `r` refresh, `Esc`/`Ctrl+E` close. The browser is the one screen that owns the terminal's alternate buffer (with xterm alternate-scroll, mode 1007, so the wheel drives the focused pane).

## File Structure

```
packages/
├── core/src/                          # @codent/core — runtime-agnostic core
│   ├── env/                          # CoreEnv interface + registry (index.ts, types.ts, lsp.ts, teardown.ts)
│   ├── agent/
│   │   ├── agent-event-bus/           # One event registry + scoped buses (observer emit / interceptor intercept); session projects every observer event
│   │   ├── agent-log/                 # AgentLog — the emission seam only: level filter, run stamp, envelope
│   │   ├── log/                       # Log policy: createLogExtension, entry schema, JSONL sink + rotation, "*" consumer
│   │   ├── approval/                  # Auto-mode controller + tool-approval table
│   │   ├── code-mode/                 # Built-in code-mode extension (sandboxed TypeScript behind CoreEnv.createIsolateDriver)
│   │   ├── commands/                  # Core-side builtin command catalog (`BUILTIN_COMMAND_CATALOG`)
│   │   ├── compaction/                # Append SUMMARY + summary-first wire projection
│   │   ├── extension/                 # Extension API (loader, runner, EventBus interception, dispatch order)
│   │   ├── jobs/                      # Background command jobs extension (durable per-job logs)
│   │   ├── lsp/                       # Built-in LSP extension, tools, commands and file-sync
│   │   ├── tree-sitter/               # Runtime-agnostic tree-sitter parsers, search/index/rewrite engines
│   │   ├── mcp/                       # MCP integration
│   │   ├── media/                     # Multimodal media store (media:// refs) + repair helpers
│   │   ├── memory/                    # Memory management + built-in Memory extension
│   │   ├── plan/                      # Plan domain + plan tool factories
│   │   ├── persistence/               # Disk session persistence (SessionStore)
│   │   ├── prompt/                    # System prompt builder, agent-doc loader, instruction files
│   │   ├── queue/                     # Mid-run deferred messages (defer queue vs pending approval)
│   │   ├── run/                       # runAgentOnce / consumeAgentStream (run skeleton)
│   │   ├── runner/                    # AgentRunner + run context
│   │   ├── skills/                    # Skill loading + built-in Skills extension
│   │   ├── stream/                    # Stream helpers (errors, assistant-text extract)
│   │   ├── subagent/                  # Subagent spawning + task tool (+ prefork / phase state)
│   │   ├── stream-hub/                # AgentStreamHub (command / task / compact)
│   │   ├── todo/                      # Todo tracking + todo tool
│   │   ├── tools/                     # Tool subsystem: catalog / runtime / builtin / shared / presentation
│   │   ├── turn-context/              # Per-turn dynamic context (<ctx kind=...> payload)
│   │   ├── ui/                        # AgentUIChannel (chat / subagent preview) + channel-write
│   │   └── usage/                     # Global usage history + per-call pricing records
│   ├── agent-session/                 # Host-facing AgentSession / Host API
│   ├── managers/                      # AgentManager, ManagedAgent, RunCoordinator, services/, middleware
│   │   ├── run-coordinator.ts          # Run lifecycle flags/timing (prepare/run/finalize)
│   │   ├── services/                   # Session / memory / compaction / extension-registry / usage-history services
│   │   └── telemetry/                  # Usage tracking + telemetry emit helpers (bus lives in agent/agent-event-bus)
│   ├── models/                        # Model config (model-config.ts), adapters, cache
│   ├── provider/                      # LLM plane: ModelProvider + registry + models.dev metadata
│   ├── runtime/                       # Instantiable runtime: AgentRuntime + CodentAgent facade
│   ├── runtime-types/                 # Shared status / event / usage types (no manager deps)
│   ├── utils/                         # Cross-cutting single-definition helpers (bytes, text-truncation, errors, display-lines)
│   ├── index.ts                       # Curated public API exports (hosts / adapters)
│   └── dev*.ts                        # Internal-only re-exports for `pnpm validate:*` scripts
│
├── app/src/                           # @codent/app — shared UI layer
│   ├── adapter/
│   │   ├── types.ts                   # AgentAdapter, AppConfig, InitResult interfaces
│   │   └── session-bootstrap.ts       # Shared createAgentSessionFromConfig() helper
│   ├── app/                           # Main app components (App.tsx, Agent.tsx)
│   ├── commands/                      # Slash commands (/help, /settings, /mode, /models, /usage, /compact, /new, /rename, /resume, /quit)
│   ├── components/                    # React components (UserInput, EditDiff, Help, etc.)
│   ├── context/                       # React contexts (AdapterProvider, CoreEnvProvider)
│   ├── hooks/                         # Shared hooks (useAgentChat, useConfig, useAgent, etc.)
│   │   └── keybindings/               # Per-mode keybinding controllers (global/normal/approval/select/freeform/context)
│   ├── layout/                        # Layout components (Header, Footer, Content)
│   ├── messages/                      # Message rendering (ToolCallPartView, TextPartView, etc.)
│   ├── types/                         # Attachment types
│   ├── utils/                         # Format utilities, clipboard, file attachment
│   └── index.ts                       # Public API exports
│
├── cli/src/                           # @codent/cli — terminal host (thin shell)
│   ├── index.tsx                      # Entry point: arg parsing, CoreEnv registration, render
│   ├── args.ts                        # CLI argument parser (sync, no CoreEnv dependency)
│   ├── model-env.ts                   # MODEL_* env → ModelInfo (host-owned, not core)
│   └── local-adapter.ts              # LocalAgentAdapter (delegates to createAgentSessionFromConfig)
│
├── node/src/                          # @codent/node — Node.js CoreEnv implementation
│   ├── index.ts                       # createNodeEnv() factory
│   └── environment/
│       ├── local.ts                   # LocalEnvironmentConfig, mode resolution
│       ├── native-fs.ts              # Workspace-scoped filesystem (path traversal protection)
│       ├── native-run.ts             # Command execution with streaming
│       ├── os-sandbox.ts             # OS sandbox via @anthropic-ai/sandbox-runtime
│       └── shell.ts                   # Shell/PTY management
│
├── server/src/                        # @codent/server — CoreEnv HTTP server + client
│   ├── index.ts                       # Hono server entry point
│   ├── client.ts                      # createRemoteEnv() — RPC client factory (+ createRemoteAgentSessionHost re-export)
│   ├── remote-provider.ts             # createRemoteProvider()
│   ├── remote-session-host.ts         # createRemoteAgentSessionHost() (AgentSessionHost over HTTP)
│   ├── remote-session-client.ts       # RemoteSessionClient (SSE auto-reconnect, remount seeds)
│   └── routes/
│       ├── env.ts                     # /api/env/* (info, vars, destroy)
│       ├── fs.ts                      # /api/fs/* (readFile, stat, writeFile, etc.)
│       ├── command.ts                 # /api/command/* (run, exec)
│       ├── fetch.ts                   # /api/fetch/proxy (HTTP proxy with binary support)
│       ├── mcp.ts                     # /api/mcp/* (stdio process init, message, delete)
│       ├── provider.ts                # /api/provider/* (OpenAI/Anthropic streaming proxy)
│       └── agent-session.ts           # /api/agent/* (catalog, snapshot, command, events, remount seeds)
│
├── extension/                         # @codent/extension — Chrome extension host
│   ├── adapters/
│   │   └── extension-adapter.ts      # ExtensionAgentAdapter
│   ├── entrypoints/
│   │   ├── sidepanel/                # Main UI (AgentBootstrap → App)
│   │   ├── popup/                    # Settings popup (model, provider, API key)
│   │   └── background.ts            # Service worker
│   ├── components/
│   │   ├── ConnectionGuard.tsx       # Server health check, reconnect logic
│   │   └── ErrorBoundary.tsx
│   └── hooks/
│       └── useServerConfig.ts        # Persistent config via chrome.storage
│
└── mcp-server/src/                    # @codent/mcp-server — MCP tool server
    └── index.ts

playground/                            # @codent/playground — WebContainer host (Vite)
```

## Runtime Combinations

| Combination | CoreEnv | Provider | Status |
|------------|---------|----------|--------|
| Local + CLI | `createNodeEnv` | `createDirectModelProvider` | Fully working |
| Remote workspace + remote keys | `createRemoteEnv` | `createRemoteProvider` | Working; command streaming limited |
| Remote workspace + local keys | `createRemoteEnv` | `createDirectModelProvider` | Working (`--remote-env` without `--remote-provider`) |
| Local workspace + remote keys | `createNodeEnv` | `createRemoteProvider` | Working (`--remote-provider` without `--remote-env`) |
| Remote CoreEnv + Extension | `createRemoteEnv` | remote (no local apiKey) or direct | Working; no command streaming, no stdio MCP |
| Playground | WebContainer CoreEnv | direct or remote | Working; web tools need fetch proxy; no stdio MCP |
| Local CoreEnv + Extension | N/A | N/A | Not supported (extension requires a server) |

## Task Completion Checklist

Validate **once at the end of the task** (not after every small edit). Prefer scoped checks:

1. **Format / lint changed files** (avoid full-repo churn on every tweak):
   ```bash
   pnpm exec prettier --write <changed-files...>
   pnpm exec eslint <changed-files...>
   ```
   Use `pnpm format` / `pnpm lint` only when many files changed or Prettier/ESLint config itself changed. Both require a build from a fresh checkout — see [Build, Lint, Test Commands](#build-lint-test-commands).

2. **Build affected packages only** (see also `.cursor/rules/010-affected-package-builds.mdc`):
   ```bash
   pnpm build:core          # example: core-only change
   # or: pnpm build:app / build:cli / …
   ```
   Run full `pnpm build` only for shared contracts, lockfile/workspace config, or unclear multi-package impact.

3. **Package validate scripts** when you touched a utility that has one (e.g. `pnpm --filter @codent/core run validate:media-store`).

4. **Fix errors before marking the task complete.** Do not loop lint→format→build after each intermediate edit.

## Important Notes

1. **ESM Only** — All packages use ESM. Use `.js` extensions in imports.
2. **Workspace Dependencies** — Use `workspace:*` for cross-package deps.
3. **Build Order** — Core → App → rest (`pnpm build` handles this).
4. **Type Exports** — Use `export type` for type-only exports.
5. **CoreEnv is the single source of truth** — `rootPath` comes only from `getEnv().rootPath`, never from config objects. Tools access all platform APIs via `getEnv()`.
6. **Tests** — The only `node:test` suite lives in `@codent/app` (`pnpm --filter @codent/app test`, which imports its own `dist`); everything else is validated by `validate:*` scripts and `pnpm typecheck`. CI runs lint + typecheck + build + the app suite on every PR.
7. **Adapter pattern** — Both hosts (CLI, extension) implement `AgentAdapter` and delegate shared init logic to `createAgentSessionFromConfig()` in `@codent/app`.
8. **Tools are owned by one per-agent service** — `defineServerTool` / `defineClientTool` are pure definitions that attach `present` / `toModelOutput` metadata to the live tool object. `AgentToolRegistry` owns the per-agent tool stacks, owner/rank and live record; `AgentToolService` is the only orchestration path for registration, removal, catalog, decorators, and model-output resolution. `ManagedAgent` owns the service; tool-compact, UI presentation, plan mode and session catalogs resolve through it. LSP decorators are agent-scoped and released with the extension; MCP tools carry their resolver on the registered def. No process-global presentation or `toModelOutput` registry remains in the agent path. A remote session keeps its descriptors on its own `RemoteSessionClient` and exposes them through `AgentSession.getToolPresentation`; only the static built-in table is a fallback.
9. **Commands and streams have separate per-agent owners** — `AgentCommandService` owns the command-job registry, durable job restore, background start/poll/kill and the `<background_jobs>` section; tools receive it through `AgentCommandPort`. `AgentStreamHub` owns live stdout/stderr and task/compact summary buffers; tools receive the narrow `AgentStreamSink`. Session switch is one ordered transaction in `SessionLifecycleService`: abort producers, clear buffers, reset session state (the sync tracker and command jobs — a switch **kills** that session's running background jobs and drops their records/logs, keeping only terminal un-notified ones for the next resume), then rotate/restore the transcript. Do not route either concern back through a global registry or a combined god service.
