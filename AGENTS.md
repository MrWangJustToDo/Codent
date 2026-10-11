<!-- OPENSPEC:START -->
# OpenSpec Instructions

These instructions are for AI assistants working in this project.

Always open `@/openspec/AGENTS.md` when the request:
- Mentions planning or proposals (words like proposal, spec, change, plan)
- Introduces new capabilities, breaking changes, architecture shifts, or big performance/security work
- Sounds ambiguous and you need the authoritative spec before coding

Use `@/openspec/AGENTS.md` to learn:
- How to create and apply change proposals
- Spec format and conventions
- Project structure and guidelines

Keep this managed block so 'openspec update' can refresh the instructions.

<!-- OPENSPEC:END -->

# AGENTS.md - AI Agent Guidelines

This file provides guidelines for AI coding agents working in this repository.

## Project Overview

A pnpm monorepo with eleven packages organized in a layered architecture.

**Core runtime deep-dive:** [packages/core/ARCHITECTURE.md](packages/core/ARCHITECTURE.md) — startup, initialization, session/memory/compaction/approval flows.

| Package | Role |
|---------|------|
| `@codent/core` | Runtime-agnostic core: agent loop, tools, LLM model factory, CoreEnv interface |
| `@codent/app` | Shared UI layer: React components, hooks, commands, AgentAdapter interface. **Session-only** for agent control — keeps a live-session registry (`sessions`/`activeSessionId` + `registerSession`/`activateSession`) so multiple live agents can coexist and be switched. See [`packages/app/README.md`](packages/app/README.md) import allowlist |
| `@codent/cli` | Terminal host — thin shell that registers CoreEnv and renders `@codent/app` |
| `@codent/node` | Node.js CoreEnv implementation: native filesystem, shell, OS sandbox |
| `@codent/server` | CoreEnv HTTP server (Hono RPC) + remote client factory |
| `@codent/extension` | Chrome extension host using WXT framework |
| `@codent/playground` | In-browser WebContainer host (Vite) |
| `@codent/mcp-server` | MCP server for external tool integration |
| `@codent/im-bridge` | Generic IM bridge (Telegram adapter) — a headless AgentSession client like the remote CLI; no CoreEnv/ModelProvider of its own in remote mode, in-process local mode otherwise |
| `@codent/acp` | Agent-side Agent Client Protocol host. Serves an `AgentSessionHost` over ACP (stdio) via `@agentclientprotocol/sdk`, so editors (Zed/JetBrains) and ACP→IM bridges drive the agent without host-specific code. `codent acp` / `codent-acp` entry; also used in-process (`createAcpAgent`). See `packages/acp/README.md`. |
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
  exec(cmd, opts?): Promise<CoreEnvExecResult>;
  fetch(input, init?): Promise<Response>;
  destroy?(): Promise<void>;       // Lifecycle cleanup
  // Optional: byteLength, base64Encode/Decode, getMimeType, createMCPStdioTransport,
  //           createLspConnection, createIsolateDriver (code-mode TS sandbox backend)
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

**Implementations:**
- `createNodeEnv()` from `@codent/node` — local Node.js APIs, optional OS sandbox
- `createRemoteEnv(url)` from `@codent/server/client` — HTTP RPC to a remote CoreEnv server

### ModelProvider — LLM plane (orthogonal to CoreEnv)

LLM credentials are **not** part of CoreEnv. Hosts register a `ModelProvider` separately so local/remote workspace and local/remote keys combine freely.

```typescript
import {
  registerModelProvider,
  createDirectModelProvider,
  resolveModelConfigFromProvider,
} from "@codent/core";
import { createRemoteProvider } from "@codent/server/client";

registerModelProvider(createDirectModelProvider({ model, style, baseURL, apiKey }));
// or
registerModelProvider(await createRemoteProvider("http://localhost:3100"));
```

| Flag / Env | Plane | Client boundary |
|------------|--------|-----------------|
| `--remote-env` / `REMOTE_ENV` | CoreEnv workspace | combines freely with `--remote-provider` |
| `--remote-provider` / `REMOTE_PROVIDER` | Remote model provider | combines freely with `--remote-env` |
| `--remote-session` / `REMOTE_SESSION` | Remote Agent Session | **exclusive** — cannot combine with the other two on one client; use `--model <id>` to push local LLM settings to the server |

The exclusivity is a **client** rule: a server (`pnpm start:server`) may itself register `REMOTE_ENV` (remote workspace; `REMOTE_PROVIDER` forwarding planned) so a `--remote-session` server chains further remote planes.

`createAgentFromConfig` uses `resolveModelConfigFromProvider()`. All hosts share one model-config pipeline (`models-config.ts`): a local `.agents/config/models.json` (file), a remote provider (`/api/provider/info`), or a remote-session server (`/api/agent/models`) — `/models` switches the active entry/model. Remote mode forces `baseURL`/`apiKey` from the provider (re-forced after models.dev so upstream URLs cannot bypass). Remote mode forces the **model** too, so a remote entry's effective model is the one its provider serves (`/api/provider/info.model`, i.e. the server's `MODEL` env): `loadModels` reports it as `active.model` and guarantees it is in the entry's selectable list, because the recorded selection (a file's `active.model`, or the server's own models.json `active`) is never what a request carries. The serving side keeps the same invariant — `/api/provider/info` advertises the served model first and as `active`, `/api/agent/models` always offers the server's `.env` model. Validate: `pnpm --filter @codent/core run validate:provider-model-list`. `/api/env/vars` strips `API_KEY` / `*_API_KEY`. Footer shows `model · remote` when `providerMode === "remote"`.

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

Shared initialization logic is in `createAgentFromConfig()` (`@codent/app/adapter/create-agent.ts`). Both `LocalAgentAdapter` (CLI) and `ExtensionAgentAdapter` delegate to this helper. `initConfig` must keep host fields such as `toolConfig` (Brave / websearch) and `remoteSession` so they reach `Host.create`. The CLI `LocalAgentAdapter` tracks live sessions through the host and, on `destroy`, iterates `host.list()` to tear down **every** live agent owned by the host (the bootstrap session plus any created via `createSessionOnHost`) so no agent leaks on exit.

### Bootstrap Sequences

**CLI (local):**
```
loadEnv → parseCliArgs → registerCoreEnv(createNodeEnv) → registerModelProvider(direct) → initConfig → render(App)
```

**CLI (remote planes):**
```
loadEnv → parseCliArgs
  → [guard] --remote-session + (--remote-env | --remote-provider) → error + exit(1) (exclusive)
  → [--remote-env] createRemoteEnv → registerCoreEnv
  → [--remote-session] createRemoteEnv(server URL) → registerCoreEnv  (workspace panel = server fs)
  → else createNodeEnv → registerCoreEnv
  → [--remote-provider] createRemoteProvider → registerModelProvider
  → [--remote-session w/o explicit model] defer model resolution to server
  → else createDirectModelProvider → registerModelProvider
  → initConfig → render(App)
```

**Extension:**
```
ConnectionGuard(/health) → createRemoteEnv(url) → registerCoreEnv
  → apiKey ? direct : createRemoteProvider(url) → registerModelProvider
  → initConfig → render(App)
```

### @codent/core Public API

`packages/core/src/index.ts` exports a **curated** surface for hosts and adapters — not a barrel of every internal module:

| Category | Examples |
|----------|----------|
| CoreEnv | `registerCoreEnv`, `getEnv`, `CoreEnv` types |
| ModelProvider | `registerModelProvider`, `createDirectModelProvider`, `resolveModelConfigFromProvider` |
| Runtime | `agentManager`, `AgentManager`, `ManagedAgent`, `AgentSession` / `AgentSessionHost` |
| UI / state | Session-safe types (`TodoItem`, `LogEntry`, …); `AgentLog`/`TodoManager`/`SessionStore` classes are package-private (AgentLog is the emission seam — the built-in log extension owns policy and writes `.agents/logs/<sessionId>/agent.log`) |
| Compaction | Session `compact` command; executors (`autoCompact`, …) stay on `dev.ts` |
| Bootstrap | `buildDefaultSystemPrompt`, `resolveModelConfig`, `resolveModelConfigFromProvider` |
| UI helpers | `previewEdit`, AgentSession `tool` channel (run_command stdout/stderr), tool output types |
| Adapters | `FileError`, `ExecutionError`, `generateId` |

Internal modules (tools, middleware, subagent runner, hook registry, session-sync / tool-phase helpers, etc.) stay package-private. Core validation scripts import from `dist/dev.mjs` (`src/dev.ts`), which is not part of the published package export map. See `openspec/changes/harden-core-organization/API-REMOVALS.md` for the latest public-entry removals.

### TanStack AI Integration

`@codent/core` uses **TanStack AI** (`@tanstack/ai`, provider adapters) for agent execution.

Key integration points:
- `core/src/models/model-config.ts` — connection resolution (`openai` | `anthropic` style, baseURL, apiKey, models.dev metadata)
- `core/src/models/adapter-factory.ts` — TanStack text adapters (`createOpenaiChatCompletions`, `createAnthropicChat`)
- `core/src/managers/run-agent.ts` — `AgentRunner` + `chat()` stream, compaction middleware
- `core/src/agent/compaction/` — Channel convert + summary-first wire projection (`getModelVisibleMessages`); engine messages are ephemeral
- `core/src/agent/ui/ui-channel.ts` — Durable UIMessage chain (SoT); compaction appends SUMMARY here
- `core/src/agent/mcp/` — MCP via `@tanstack/ai-mcp` (`McpManager` re-wraps tool execute so multimodal `content[]` is not dropped when `structuredContent` is present)
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
pnpm build:im-bridge  # Build im-bridge package only
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
pnpm start:im-bridge  # Run the IM bridge (Telegram)
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

**Exports**

- Built-in extension factories: exactly one canonical export `createXxxExtension`. No bare-name aliases, no default exports.
- Internal renames land directly — no old-path re-exports, deprecated aliases, or staged dual exports; call sites switch in the same change.

**Class members / accessors**

- No underscore-prefixed members (`_status` ✗ → `currentStatus` ✓). Getter backing fields use descriptive names.
- Read accessors: `getXxx()` / `setXxx()` methods. A bare property getter for state access is not used — `get status(): AgentStatus { return this.currentStatus; }` is gone, and `validate:accessor-convention` fails any class that reintroduces one alongside its `getStatus()`. A class may not offer two spellings for one read. (Plain computed properties over private data, e.g. `get size(): number` on a cache, are a different thing and are not what this rule targets — the rule is about exposing *state* two ways.)

**Barrels**

- Domain directories expose `index.ts`; import from the directory root when consuming 2+
  symbols from it. The top-level `src/agent/` namespace is intentionally barrel-free —
  cross-domain imports use direct module paths there.

**File size**

- Keep files ≤ **400 lines** where a cohesive boundary exists (`.cursor/rules/040`). This is the
  design guideline, not the enforced gate: `eslint.config.cjs` raises `max-lines` to **800** for
  this repo, so a file between the two numbers passes lint without an exemption — the gap is a
  deliberate allowance for cohesive modules, not a licence to keep growing one. Files that
  legitimately exceed **400** document the trade-off instead of being cut arbitrarily: the
  `/* eslint-disable max-lines */` at the top of such a file must be paired with a written
  justification naming what the file composes and which parts were extracted instead
  (`run-coordinator.ts`, `managed-agent-runner-wiring.ts`, `managed-agent-compact.ts`). An
  unexplained disable is a silent exemption, and this file's carried one long enough for the
  tracker to mark it done at 514 lines and never revisit it at 1750. A file that needs the 800
  ceiling at all should say so in its header, because at that size a reader is owed the reason.

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

**Host-owned session plane:** hosts construct the `AgentSessionHost` (local manager, or remote HTTP when `--remote-session`) and inject it into `createAgentFromConfig`; the UI layer never imports core runtime singletons (enforced by app's `validate:core-imports`). Remote client features: SSE auto-reconnect with exponential backoff, server heartbeat ping + client watchdog, remount seeds (`/tool-buffers`, `/summary-streams`) so in-flight tool output and summary streams survive reconnects; the retained `state` channel carries the session identity (`name`, `sessionId`) plus model identity (`model` / `modelInfo` / `reasoningEffort`), so commands and model switches sync without a full-snapshot refetch.

All domain updates route through a single unified `AgentEventBus` (`agent/agent-event-bus`) — one type registry (`AgentEvents` + `AGENT_EVENT_META`), two dispatch modes: observer `emit` (sync, fire-and-forget, retained values) and interceptor `intercept` (async, ordered, cancel short-circuit; `tool:before:*` patterns). `AgentManager.of(agentId, parentId?)` mints per-agent scoped buses (subagent events up-flow to parent/root). `AgentSession` subscribes the scoped bus once and projects every observer event to its channel via `AGENT_EVENT_META[type].channel`, replaying retained values per subscriber. The former structured `log` channel was **removed** — log observability is provided exclusively by the persisted JSONL file sink (`.agents/logs/<sessionId>/agent.log`).

**TODO:** message channel currently delivers full `UIMessage[]` (incremental/patch later).

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
| `/api/agent` | POST | Create/bind AgentSession (full create options incl. maxIterations/mcp/toolConfig/resume) |
| `/api/agent/:id/snapshot` | GET | AgentSession snapshot (root or subagent id) |
| `/api/agent/:id/command` | POST | `dispatch(command)` |
| `/api/agent/:id/events` | GET | SSE session channels (+ 15s heartbeat ping frames) |
| `/api/agent/:id/tool-buffers` | GET | Buffered tool stdout/stderr per toolCallId (remount) |
| `/api/agent/:id/summary-streams` | GET | Live SummaryStreamHub snapshots (remount/cache seed) |
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
| `agent:tool-start` / `agent:tool-end` / `agent:tool-error` | Tool lifecycle (extensions middleware) |
| `agent:retry` | Recoverable LLM failure being retried (429/gateway backoff, capability strip, reactive compact, max_tokens continuation); payload carries `attempt`/`maxAttempts`/`strategy`/`error`/`delayMs`. Retry state also lives on the Session snapshot + `state` channel (`AgentRetryState`) and is cleared once the stream recovers or the run reaches a terminal status |
| `agent:iteration` | Agent-loop progress within a run (one iteration = one model turn). Payload `{ current, max }` (1-based; idle `0`; `max` = `maxIterations` budget). Projected onto the retained `iteration` channel + `AgentSessionSnapshot.iteration`; deliberately **not** logged |
| `agent:abort` / `agent:stream-error` | User abort / stream failure (`RUN_ERROR`, empty-stream guard, and other pump failures; main chat records error without crashing the host) |
| `agent:stop` | Run finished or aborted |
| `memory:prefetch` | Relevant memory injection before run |
| `memory:extract` / `memory:consolidate` | Post-run memory extraction |
| `compaction:auto-*` / `compaction:reactive-*` | Auto / reactive context compaction |
| `session:save-error` | Session persistence failure |
| `session:restore` | Session resume succeeded (`sessionId`, `messageCount`, `tokenEstimate`, `mediaMissing` when >0); also re-emits the retained `state` channel |
| `subagent:*` | Subagent lifecycle |
| `plan:enter` / `plan:ready` / `plan:execute` / `plan:cancel-execution` / `plan:retro` / `plan:complete` / `plan:exit` | Plan mode phase transitions |

**Vision note:** On OpenAI-compatible Chat Completions, multimodal tool results are lifted to a synthetic user `image_url` message (`liftToolMediaForChatCompletions`) so base64 is not stringified into `role: "tool"`. Anthropic keeps native multimodal `tool_result` parts. Official DeepSeek Chat Completions may still reject `image_url` (text-only schema); capability sanitization strips unsupported `image` / `audio` / `video` / `document` parts on the wire and retries once — use a vision-capable provider for real media understanding. Session/UI history always keeps structured image parts (and `.agents/media` binary files); wire stripping must not change persisted message shape.

**Logging (built-in extension):** the emission **seam** is `AgentLog` (`agent/agent-log/agent-log.ts`) — level filtering, `run` stamping, envelope construction, then a direct hand-off to the attached sink. It is deliberately **not** an extension and not disableable: ~76 core call sites plus `ctx.logger` write through it, and they must work during workspace construction, before extensions load, and while an extension is failing to activate. Log **policy** belongs to the built-in log extension (`agent/log/extension.ts` = `createLogExtension`, with `event-log-bridge.ts` for the rules, `event-log-rules.ts` for the table, `schemas.ts` for the entry schema, `jsonl-file-sink.ts` for the sink + rotation). The two domains are coupled **but acyclic**, which is the property to preserve: `agent/log/` reaches `agent-log/` for the `LogEntry` / `AgentLog` **types** (erased) and for the extension-exit-flush registry, while `agent-log/` reaches `agent/log/` for the JSONL sink and the entry schema — opposite directions, but never along a path that returns to its start, so neither domain can break the other by initialising early. The written rule is "no module-level import cycle between these two domains", not "no two-way edge": the value edges in both directions are real and each is load-bearing, and the schema lives in `agent/log/` because the sink is its only runtime consumer. `AgentManager` constructs and `start()`s it; its `bus.on("*")` subscription is the only wildcard consumer in core, and it maps telemetry events to entries — each stamped with the originating event type (`event`) and scoped to the in-flight run (`run`). Override per event type with `EventLogPolicy`. Emit sites should not duplicate lifecycle logs covered by the table. Entries emitted before a sink is bound are retained (bounded, `MAX_PENDING_LOG_ENTRIES`) and drained into the first sink that attaches, so bootstrap diagnostics reach disk. The sink persists every entry to `.agents/logs/<sessionId>/agent.log` (size-rotated), validated against `logEntrySchema` at the write boundary. Subagents have no extension runner but do log, so core hands **each** `AgentLog` to the extension's sink (`attachSink`); the extension's `dispose()` releases them.

## Prompt Cache (prefix)
Frozen system text ends with `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` and stays byte-stable across turns.
Per-turn dynamic context is injected as synthetic `<ctx kind=...>` user messages by the turn-context middleware `onConfig` (after compaction) whenever a section's content hash changes (persisted in `uiMessages`, hidden in the transcript UI; per-kind supersede notices mark refreshed sections).
`<current_date>` uses **day** granularity (not hour/minute) so the payload stays stable within a calendar day.
`findCutPointByBudget` skips synthetic `<ctx kind=...>` messages when walking the token-budget boundary.
All synthetic injections (turn-context sections, memory, background-command completion notifications) share one helper (`agent/turn-context/synthetic-injection.ts`): stable `ctx-<kind>-<hash>` ids, channel + wire in sync, persisted to the session (no cross-turn prefix divergence). Background notifications use `append` position and `<ctx kind=background_notification>`; any future injection must reuse this helper and shell.
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

**The lifetime view has the same trap, and for a while had its own fix.** `/usage`'s `Cache hit:` divided cumulative `total.cacheReadTokens` by `total.inputTokens` — the cache-miss sum on an exclusive upstream — and printed **428.5%** on a real session (125.4k cache read over 29.3k input). The denominator is the *billed prompt*, and it **cannot be recovered from the aggregate**: `total.inputTokens` is already a miss-sum, so "take the max" under-reports (a session with 2.64M miss + 39.2M cached is a true 93.7% hit, not 100%). `UsageTracker` therefore accumulates `billedInputTotal` **per sample** through the same `promptTokensOf()` the window fill uses — one rule, exact under both conventions, written by `accumulateTotal` and cleared by `reset()`. `getCacheHitRatio()` is that ratio (`billedInputTotal` is the denominator, so it stays inside (0,1]). ⚠️ `accumulateTotal` is shared with subagent aggregation and restored totals, so an inflated per-sample prompt would skew cost-adjacent surfaces too.

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

Telling a user-cancelled run from a failure is one question, answered in one place per layer: `isAbortError(err, signal)` decides whether a throw is the abort (`runtime-types/abort.ts` — signal first, then the DOM name, then `code === "aborted"` for the local and remote-reconstructed shapes, then the bare `message`, because three layers had three different heuristics before), `agent:tool-error`'s payload carries the same verdict as `cancelled` (the abort reaches TanStack as a throw, so this is the *only* event that can express it), and `isCancelledToolCall` renders both marker spellings — `cancelled` (a tool that caught its own abort) and `aborted` (the `task` tool, whose subagent cancels without throwing) — as one neutral ⚠.

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

**Auto mode:** `/mode auto` skips all tool approvals. Footer shows `Auto`. Mutually exclusive with plan mode (entering one clears the other). Cleared on `/clear` / reset; persisted as `SessionData.autoMode` (legacy sessions may still have `autoApprove`). While auto is on, turn context includes an `<auto_mode>` block.

**Session / safety:** `/clear` and `ManagedAgent.reset()` always `planMode.disable()`, turn off auto mode, and clear the session `approvals` table. Resume restores `planMode` + `autoMode` with plan winning if both were somehow set, restores `approvals` (or backfills from UIMessage parts when the field is missing), adopts the persisted `reasoningEffort` / `model` + `modelStyle` (skipped under `providerMode: "remote"`, where the provider server owns the model) and mirrors the session's display name. Chat `onConfig` rebuilds TanStack `resumeToolState.approvals` from that table so approved/denied tools do not re-prompt. Plan building auto-approve still requires `todosSeeded` (and applies to `retro` as well as `executing`) — separate from `/mode auto`.

## Subagent System

The project supports **subagents** — context-isolated agents spawned to handle delegated tasks.

**Run profiles:** InteractiveChat (`AgentChatController` pump) and Worker (`runSubagent`) share `runAgentOnce` / `consumeAgentStream` in `agent/run/run-agent-skeleton.ts`. Workers use outcome path `"detached"`; chat finalizes with `"chat"` after the full pump. Hosts still observe via `AgentSession` only.

### Subagent Characteristics

| Feature | Behavior |
|---------|----------|
| Context | Fresh (starts with empty messages) |
| Tools | Read-only: `read_file`, `glob`, `grep`, `list_file`, `tree`, `websearch`, `webfetch`, plus marker `begin_summary` (no `run_command` / write tools) |
| Return | Summary only to parent LLM context; UI keeps a read-only UIMessage preview when `bridgeUI` is enabled |
| Iteration Limit | 50 steps max (TanStack `maxIterations`; cutoff leaves `finishReason: tool_calls`) |
| Status flags | `toModelOutput` exposes `reachedLimit` / `incomplete` / `aborted` / `truncated`; explore runs require `begin_summary` for a complete result |
| Summary Limit | 5000 characters max |

| UI Preview | `bridgeUI: true` (default when `parentTaskToolCallId` is set): parent panel + task-tool streaming via the subagent’s `AgentUIChannel` |
| No parent bridge | `bridgeUI: false` (default otherwise): still has an internal `AgentUIChannel` (message SoT); skips parent task-tool streaming / preview bridging — used by compaction |

### Subagent UI Preview

`runSubagent` always attaches an `AgentUIChannel` via `ensureUIChannel`.
`bridgeUI: true` enables the task panel (`Ctrl+T`) and parent task-tool routing
(summary stream keyed by the task tool-call id); `bridgeUI: false` keeps the channel internal only.
Task-tool subagents use `autoDestroy: false` so the preview stays available; after the stream ends,
detached outcome finalization marks them `completed`/`aborted`. Esc while a task is active aborts the
subagent first: `runSubagent` sets `aborted: true` and appends `[Task cancelled by user.]` into the
task `summary` (parent model + UI), even when the stream ends without throwing.
so `getActiveSubagents()` (and the Ctrl+T list) only shows truly active tasks.
Task spawn ids are always auto-generated via `generateId("subagent", { exists })` — the model
does not supply an `id` input.
The default task tool row shows the current subagent exploration tool during analysis.
After the subagent calls `begin_summary`, the UI switches to summary phase and streams final text
via `SummaryStreamHub` (`reset` / `append` / `end` on key `task:${toolCallId}`) into `useSummaryStream` /
`SummaryStreamView` — not UIMessage diffs or `emitStreamingChunk` (those remain for `run_command`).
On restart-style stream recovery (429 / capability sanitize), `AgentUIChannel.resetForStreamRetry()`
keeps the user prompt and clears tools/summary so the task panel does not keep stale state;
terminal non-abort failures still call `failRun()`. Max-tokens continuation does not reset.
Compact summarization uses the same hub with stable key `compact:${parentAgentId}` (one in-flight compact per agent).
Only the last text-only step is returned to the parent as the task `summary`; `toModelOutput` also includes completion status (`reachedLimit` / `incomplete` / `aborted` / `truncated`) so the parent can judge whether findings are trustworthy to extend. The iteration pair (`iterations` = model turns, `maxIterations` = the budget it ran under) is **host-only**: it is persisted on the task output so a restored row can still show `used/budget`, but it is in neither `toModelOutput` nor the description — `reachedLimit` already is the budget verdict, and a bare count says nothing without a ceiling.

### Per-task phase machine & parallel pre-fork

Each `task` tool call owns a one-way phase state machine (`TaskRunState` in `subagent/task-run-state.ts`):
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
partial exploration into a report streamed through the same `SummaryStreamHub`, so the task UI always
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
│   └── run-agent-skeleton.ts  # runAgentOnce / consumeAgentStream / ensureUIChannel
├── subagent/
│   ├── run-subagent.ts        # Worker profile: runSubagent(), getSubagent(), destroySubagent()
│   ├── run-stats.ts           # Iteration/limit stats from UI messages + stream
│   ├── subagent-tools.ts      # Read-only tool set for subagents
│   ├── subagent-output.ts     # Cancel notice + summary truncation
│   ├── explore-prompt.ts      # Explore system prompt
│   ├── begin-summary-tool.ts  # begin_summary marker tool
│   ├── progress-summary.ts    # Iteration-limit progress-summary fallback (side-LLM)
│   ├── task-prefork.ts        # Eager parallel pre-fork (rolling window, MAX_ACTIVE_TASK_PREFORKS=4)
│   ├── task-run-state.ts      # Per-task phase machine (running → summary)
│   ├── task-tool.ts           # createTaskTool() for parent agents
│   └── index.ts
├── tools/              # Universal tools (fs/shell/web) + runtime glue
```

## Extension Point: Message Transformers

`ExtensionContext` offers four registration channels today — `registerTool` / `registerCommand` / `registerInterceptor` / `registerContextProvider`. Its fifth, `registerMessageTransformer(fn)`, is the only one that edits **the message chain the model sees**. Use it for media-to-text (e.g. describe an image through an out-of-process multimodal endpoint before handing it to a text-only model), redaction, trimming to a budget, or wire-only context injection.

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
| Ownership | You get a fresh outer array **and** fresh message objects, so in-place edits cannot reach the array `WireProjectionCache` retains (which the engine also keeps for the rest of the run). Content-part objects inside a message are still shared — return a new message to change a part. |
| Capabilities | `ctx.capabilities` carries the raw declared set, or `null` when **unknown** — `null` and an empty set are different on purpose (`null` = nothing declared, all `modelHas*` booleans `true`; `∅` = declared, none apply, all booleans `false`). `ctx.unsupportedPartTypes` is the derived multimodal strip set. Every capability also gets a flat boolean named `modelHas<Capability>` in PascalCase (`modelHasVision`, `modelHasToolCalling`, …), one per entry of `MODEL_CAPABILITIES`. All come from the same probe that gates pre-send stripping, so an extension never re-derives model ability from host config. The list lives once in `models/types.ts`: `MODEL_CAPABILITIES` is the runtime array, `ModelCapability` is derived from it, and `MODEL_CAPABILITY_FLAGS` (exhaustively keyed by that union) names each boolean — so adding a capability is a compile error until it is named, not a silently missing flag. Every member must be evidenceable from provider metadata; unproducible members (`streaming`, `computer_use`) were removed. |
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
| `ast_search` / `code_rewrite` / `code_overview` | Structural tree-sitter tools skipped by default — re-enable via `lsp: { enableAll: true }`. `ast_search`/`code_rewrite` are structure search/rewrite (no LSP equivalent); `code_overview` overlaps `lsp_symbols` |

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

**Tool subset (kept deliberately small):** only a curated set is exposed to the sandbox as `external_*` bindings — read-only fs tools eager (`read_file`/`grep`/`glob`/`list_file`/`tree`), shell (`run_command`) + `websearch` lazy. Interactive / stateful tools (`ask_user`, `task`, `todo`, plan tools) are excluded — including `get_command_output` / `kill_command`, so a background job started inside the sandbox is read through its log file via `read_file` (see the `run_command` section) and is polled/killed by the outer agent. Lazy tools stay out of the system prompt's full type stubs and are listed in a discoverable catalog instead (`discover_tools`), keeping the per-turn prompt small (progressive disclosure).

**Per-turn system prompt:** the extension injects code-mode guidance through a `before_agent_start` interceptor (`event.appendSystemPrompt`) documenting the sandbox API + `external_*` bindings.

**Config:** `ManagedAgentConfig.codeMode` accepts `boolean` (default `true`) or `{ timeout?, memoryLimit?, lazyToolsConfig? }`. The isolate backend must be a CoreEnv optional capability: `createIsolateDriver?(): Promise<IsolateDriver | null> | IsolateDriver | null` (`IsolateDriver` from `@tanstack/ai-code-mode`, type-only — zero native deps in core). Module map: `packages/core/src/agent/code-mode/` (`extension.ts`, `index.ts`); Node host: `packages/node/src/environment/isolate-driver.ts` (lazy-loads `ai-isolate-node`, returns `null` on failure).

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
| Reactive | `reactive_compact` | `prompt_too_long` API error | Emergency compaction, then retry |

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

**Auto-compact trigger:** The trigger base is the **working budget** — `tokenThreshold`, the same number the UI percentage uses. The agent factory auto-fills it as `min(contextWindow, MAX_THRESHOLD=200k)` when unset, so a huge models.dev window (e.g. 1M) never defers compaction past the displayed budget; the threshold is clamped to the real window so an oversized config cannot defer past what the model accepts (`shouldTriggerAutoCompact`, `resolveAutoCompactTrigger`). Trigger point = `min(tokenThreshold, contextWindow) * compactAtPercent / 100`.

**Auto-compact cut-point strategy:** `findCutPointByBudget()` walks backward accumulating estimated tokens until the budget is reached and cuts at the nearest pairing-safe boundary (user/assistant only — never on a tool result, so call/result pairs stay intact). If the cut lands inside a turn (**split turn**), the discarded turn prefix is summarized separately under `<turn_prefix>` and merged into the SUMMARY; the suffix stays intact. It skips in-chain summaries and synthetic `<ctx kind=...>` messages. Everything before the cut is summarized; the kept portion remains in the main agent context.

**Summarizer input:** The summarization subagent receives labeled segments — `<to_compress>` (pre-cut history), `<turn_prefix>` (split-turn prefix, dedicated prompt), and `<still_in_context>` (kept turns) — plus optional `<previous-summary>` for incremental updates. Prompt rules tell the model to summarize the compressed segment thoroughly and use the kept segment only to align Goal/Next (no detailed restatement).

**Post-compact (same request):** Append `[CONVERSATION SUMMARY]` onto the UI channel (chronological SoT). Compaction middleware then projects summary-first wire from the **live channel** and never writes the projection back. Auto-compact does not run again until a new durable message lands after that SUMMARY (window reset would otherwise re-trigger via `estimateTokens`). Recovery (`prompt_too_long` / retries) re-reads `managed.ui.getMessages()` live so mid-run appends are visible.

**No transcript archive.** Compaction only *appends* the SUMMARY to the channel; it never removes the pre-cut messages, and the session is persisted from that channel — so `.agents/sessions/<id>.session.jsonl` retains the whole conversation and the summary is purely additive. The former `.agents/transcripts/<sessionId>/compact-<n>.md` archive was a derived, lower-fidelity duplicate of messages still in the log and has been **removed** (writer, summary `## Compact archives` list, and prompts). `stripCompactArchiveSections` remains only to drop the section from summaries persisted before the removal. Recall of compacted-away detail goes through the `session_search` / `session_read` tools over the session log.

**How the model is told to search past conversation** lives in exactly one place: the `session_retrieval` turn-context section (`agent/turn-context/session-retrieval.ts`), emitted when the workspace has history. The gate is evaluated once per agent, and the body holds no counts, so the section stays byte-stable and does not churn the prompt cache.

> Module map: `packages/core/src/agent/compaction/` — `tool-compact/` (Layer 1 transforms), `auto-compact.ts` (Layer 3), `keep-policy.ts` (`resolveKeepPolicy`), `cut-point.ts` (`findCutPointByBudget` / `extractExistingSummary`), `reactive-compact.ts`, `apply-compaction-result.ts`, `compaction-summary.ts`, `message-chain-projection.ts` (`getModelVisibleMessages`), `compaction-prompt.ts`, `serialize-conversation.ts`, `token-estimator.ts`, `index.ts`.

**Reasoning stripping (Layer 2)** is disabled in `compaction-middleware.ts` because DeepSeek thinking mode requires `reasoning_content` echo-back. DeepSeek endpoints use `ReasoningChatCompletionsTextAdapter`, which maps stream `reasoning_content` into `thinking` and writes it back on subsequent requests.

**Reactive compaction** runs via `runStreamWithRecovery` (`managers/run-stream-recovery.ts`) — on `prompt_too_long` errors, `ManagedAgent.handleReactiveCompact()` appends a SUMMARY onto the live UI channel and retries (skipped for subagents). The retained tail is selected by token budget at a pairing-safe boundary (`selectReactiveTail`), degrading to the latest valid boundary when everything fits the budget — progress is always guaranteed. `getMessages` is a live channel read so the retry does not reuse a pre-run snapshot. The same shell also retries **transient** provider errors (429 / rate-limit / 502–504 / network) with exponential backoff for both main agent and subagents (honors Retry-After when available).

## Workspace `.agents/` layout

Runtime data under the project root is grouped under a single gitignored `.agents/` directory (alongside config such as skills / MCP / extensions):

| Path | Purpose |
|------|---------|
| `.agents/sessions/` | Session message log (`*.session.jsonl`, one line per message + state; timestamps live on the message) |
| `.agents/logs/<sessionId>/` | AgentLog JSONL event timeline (`agent.log`, size-rotated; written by the built-in log extension) |
| `.agents/usage/` | Global usage history (`usage-<year>.jsonl`, per-LLM-call records) |
| `.agents/config/models.json` | Unified model config (global settings + provider entries) |
| `.agents/memory/` | Cross-session memory markdown + `MEMORY.md` |
| `.agents/cache/tool-output/` | Large tool-output spill files (`*.txt`) — GC'd two ways: reference-based on compaction **and** a 7-day age sweep (`sweepStaleToolOutput`, lazy on first cache write of a process). The age sweep is the only thing that collects files from sessions that never compacted, and files no session ever referenced |
| `.agents/cache/command-jobs/` | Durable per-job background shell logs (`.log`); 24 h age sweep + deletion with the job record |
| `.agents/cache/models-dev.json` | models.dev metadata disk cache |
| `.agents/plans/` | Saved plan markdown |
| `.agents/skills/` | Project skills |
| `.agents/extension/` | Project extensions |
| `.agents/mcp.json` | Project MCP config |

## Sandbox Environment Configuration

Configure via `SANDBOX_ENV` environment variable or programmatically.

| Value | Description |
|-------|-------------|
| `local` | (default) Real bash + OS sandbox via `@anthropic-ai/sandbox-runtime` |
| `native` | Real bash and Node.js fs, no OS sandbox |

Programmatic equivalent: `createNodeEnv({ rootPath, mode: "os" | "native" })`. Env var: `SANDBOX_ENV=local` in `.env` (see README).

## Tool Output Truncation

### grep Tool
- Max 500 chars per matching line content
- Max 50KB total content across all matches

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

**Background jobs (`run_in_background`) and their log.** Output is retained in memory (head-trimmed: 256K/stream running, 64K/stream finished, 50 finished jobs kept) **and** tee'd to a durable log at `.agents/cache/command-jobs/<jobId>.log`, whose workspace-relative path is returned as `cachedOutputPath` by `run_command` (background) and `get_command_output`:
- one file per job, chunks appended in arrival order, stderr lines marked `[stderr] `;
- header (`# <command>` + start time) on creation, terminal footer `[exit <code> · <status> · finished <iso>]` — **no footer means still running**;
- **unbounded by design**: the log is never sized against a cap and never truncated — background output is always written. Disk growth is bounded by the 24 h stale sweep plus deletion with the job record, not by cutting the file, so `read_file` line offsets stay valid for as long as the file exists;
- deleted with the job record (registry eviction / `destroyAllCommandJobs`); logs older than 24 h are swept once per process; a host whose fs lacks `appendFile` degrades to `cachedOutputPath: null`;
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
  message-count cap it replaced. Historic message counts and dropped-row totals are derived from
  `selectVisibleRows`; note the worker's screen model keeps ~1000 lines and evicts history only when
  a **single frame** exceeds it — raising that limit is not the fix for long sessions.
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
- **`run_command`:** Core emits every chunk via `emitStreamingChunk` onto the session `tool` channel
  (`chunk` / `clear` by `toolCallId`); throttling is applied in the app layer.
  `useStreamingOutput(toolCallId, { throttleMs })` / `StreamingOutputView` (default `0` = every chunk).
  `ToolCallPartView` defaults `run_command` to 100ms; pass `streamingThrottleMs` to override.
- **Task / compact summary:** Core `SummaryStreamHub` multicasts `reset` / `append` / `end` on the session
  `summary` channel. Task keys are `task:${toolCallId}`; compact keys are stable `compact:${agentId}`
  (single-flight per agent). App `useSummaryStream` / `useActiveCompactSummaryStream` keep a fixed line window
  (`pendingLine` + overflow indicator). Do not route summary text through `StreamingOutputView`.
- **Compact transcript (`/appearance compact`):** the density mode has two layers that must agree:
  - *Projection* (`packages/app/src/utils/project-transcript.ts`) folds contiguous **completed**
    tool calls into one synthesized activity-summary row (`display-activity:<turn>:<seq>`). Only the
    static (non-streaming) portion is projected; the live message renders as-is.
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
    `getToolPresentation` / `registerToolPresentation`; see `packages/core/src/agent/tools/presentation/types.ts`.
    Every descriptor function must be a pure function of the stored output (or parsed input).

## CLI Keyboard Shortcuts

| Key | When Running | When Idle | When Approval Pending |
|-----|--------------|-----------|----------------------|
| `Esc` | Aborts current agent run (clears queued messages) | - | Cancel deny-reason input |
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

## File Structure

```
packages/
├── core/src/                          # @codent/core — runtime-agnostic core
│   ├── env/                          # CoreEnv interface + registry (index.ts, types.ts, lsp.ts, teardown.ts)
│   ├── agent/
│   │   ├── agent-log/                 # AgentLog — the emission seam only: level filter, run stamp, envelope
│   │   ├── log/                       # Log policy: createLogExtension, entry schema, JSONL sink + rotation, "*" consumer
│   │   ├── approval/                  # Auto-mode controller + tool-approval table
│   │   ├── compaction/                # Append SUMMARY + summary-first wire projection
│   │   ├── extension/                 # Extension API (loader, runner, EventBus interception, dispatch order)
│   │   ├── lsp/                       # Built-in LSP extension (extension.ts) + LSP/tree-sitter tools
│   │   ├── mcp/                       # MCP integration
│   │   ├── media/                     # Multimodal media store (media:// refs) + repair helpers
│   │   ├── memory/                    # Memory management + built-in Memory extension
│   │   ├── plan/                      # Plan domain + plan tool factories
│   │   ├── persistence/               # Disk session persistence (SessionStore)
│   │   ├── run-helpers/               # Chat/run helpers (tool-phase, empty-stream, pending queue)
│   │   ├── run/                       # runAgentOnce / consumeAgentStream (run skeleton)
│   │   ├── runner/                    # AgentRunner + run context
│   │   ├── skills/                    # Skill loading + built-in Skills extension
│   │   ├── stream/                    # Stream helpers (errors, assistant-text extract)
│   │   ├── subagent/                  # Subagent spawning + task tool (+ prefork / phase state)
│   │   ├── summary-stream/            # SummaryStreamHub (task / compact summary streams)
│   │   ├── todo/                      # Todo tracking + todo tool
│   │   ├── tools/                     # Universal AI tools (fs, shell, web) + runtime/util
│   │   ├── turn-context/              # Per-turn dynamic context (<ctx kind=...> payload)
│   │   ├── ui/                        # AgentUIChannel (chat / subagent preview) + channel-write
│   │   └── prompt/                    # System prompt builder, agent-doc loader, instruction files
│   ├── agent-session/                 # Host-facing AgentSession / Host API
│   ├── managers/                      # AgentManager, ManagedAgent, RunCoordinator, services/, middleware
│   │   ├── run-coordinator.ts          # Run lifecycle flags/timing (prepare/run/finalize)
│   │   ├── services/                   # Session / memory / compaction / extension-registry / usage-history services
│   │   └── telemetry/                  # Usage tracking + telemetry emit helpers (bus lives in agent/agent-event-bus)
│   ├── models/                        # Model config (model-config.ts), adapters, cache
│   ├── provider/                      # LLM plane: ModelProvider + registry + models.dev metadata
│   ├── runtime-types/                 # Shared status / event / usage types (no manager deps)
│   ├── utils/                         # Cross-cutting helpers (Emitter, generateId)
│   ├── index.ts                       # Curated public API exports (hosts / adapters)
│   └── dev*.ts                        # Internal-only re-exports for `pnpm validate:*` scripts
│
├── app/src/                           # @codent/app — shared UI layer
│   ├── adapter/
│   │   ├── types.ts                   # AgentAdapter, AppConfig, InitResult interfaces
│   │   └── create-agent.ts            # Shared createAgentFromConfig() helper
│   ├── app/                           # Main app components (App.tsx, Agent.tsx)
│   ├── commands/                      # Slash commands (/help, /appearance, /mode, /models, /usage, /compact, /clear, /rename, /resume, /effort, /quit)
│   ├── components/                    # React components (UserInput, EditDiff, Help, etc.)
│   ├── context/                       # React contexts (AdapterProvider)
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
│   └── local-adapter.ts              # LocalAgentAdapter (delegates to createAgentFromConfig)
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
7. **Adapter pattern** — Both hosts (CLI, extension) implement `AgentAdapter` and delegate shared init logic to `createAgentFromConfig()` in `@codent/app`.
