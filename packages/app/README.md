# @codent/app

Shared UI layer (CLI + extension). Agent control is **Session-only**: hooks, layout, and slash commands use `AgentSession` / `AgentSessionHost`, not `ManagedAgent` / `agentManager`.

`useAgent` stores `session` / `host` with `markRaw`. reactivity-store selectors otherwise wrap those live handles as readonly proxies, and `subscribe` / `dispatch` silently no-op (Vue blocks `Set.add` on the proxy). Call `getActiveSession()`, `getActiveHost()`, or `resolveAgentSession()` (they `toRaw`) before using methods; in components `toRaw(useAgent((s) => s.session))` is equivalent.

**Multiple live sessions.** `useAgent` also keeps a live-session registry: `sessions` (`Record<agentId, AgentSession>`), `activeSessionId`, and the actions `registerSession`, `activateSession`, `removeSession`. `session` always reflects the currently **active** handle, so existing selectors (`useAgent((s) => s.session)`) and `getActiveSession()` keep working when switching. `createSessionOnHost()` (`adapter/create-agent.ts`) boots an additional live session from the active config and registers/activates it; `getSessionById()` looks up a registered handle by id. `use-agent-chat` re-subscribes to the active handle on switch (re-filling messages/status/todos/queues from the snapshot) without destroying the old session.

## `@codent/core` import allowlist

### Allowed (session-safe / presentation / CoreEnv)

| Category | Examples |
|----------|----------|
| Session API | `AgentSession`, `AgentSessionHost`, snapshots, commands, channel types |
| Serializable types | `AgentStatus`, `AgentMode`, `TodoItem`, `TokenUsage`, `LogEntry`, `PlanModeState`, `SessionMeta`, tool output types, `ExtensionInfo`, `AgentEvent` (typed envelope) |
| Status helpers | `isActiveStatus` |
| Presentation registry | `getToolPresentation` / `registerToolPresentation` / `describeToolPresentations` (tools declare a single `present` descriptor in core; the UI reads it) |
| CoreEnv plane | `CoreEnv` type, `FileEntry`, … — the env itself reaches the app through `CoreEnvProvider` / `useCoreEnv` (host-supplied) and is passed explicitly into the workspace utils; never ambient `getEnv()` |
| Model types | `DEFAULT_BASE_URLS`, `DEFAULT_LOCAL_OPENAI_BASE_URL`, `ModelStyle` / `ModelInfo` / `ModelCapability` / `ModelPricing` / `ReasoningConfig` |
| Summary stream protocol | `summaryStreamKey`, `compactSummaryStreamId`, display-window helpers, `SummaryStreamEvent` types |
| Edit preview (CoreEnv) | `previewEdit` (workspace read; no ManagedAgent) |

### Allowed only in Local adapter bootstrap

| Symbol | File |
|--------|------|
| `resolveModelConfigFromProvider`, `buildDefaultSystemPrompt` | `adapter/create-agent.ts` |
| `buildDefaultSystemPrompt` | `hooks/use-config.ts` (default prompt fill) |

Remote session Host bootstrap (`createRemoteAgentSessionHost`) replaces the Local exception when `--remote-session` is used.

### Forbidden in app UI / commands / hooks (except bootstrap files above)

- `ManagedAgent`, `agentManager`, `createManagedAgent`, `AgentManager`
- Ambient CoreEnv registry: `getEnv`, `hasCoreEnv`, `registerCoreEnv`, `clearCoreEnv` (take the env from `useCoreEnv` / pass it into the workspace utils)
- Live `TodoManager` / `AgentLog` class instances (use Session snapshot / `lifecycle`; AgentLog is a persisted JSONL sink — no in-memory ring)
- `SessionStore` (use `session.dispatch({ type: "session.list" })` / Host catalog)
- Compaction executors: `autoCompact`, `applyCompactionResult`, `estimateTokens` (not on public core entry; run via `dispatch({ type: "compact" })`)
- Side-LLM / managed runners: `runSideTextQuery`, `resolveTextAdapterForManaged`
- Runtime extension loaders: `ExtensionRunner`, `ExtensionLoader` (observe via Session `extensions` snapshot)

The presentation helpers (activity summaries, input/output formatting, tool-part state, row rules) live in **core** (`src/agent/tools/presentation/`) and the app re-exports them — hosts must not keep their own tool-name tables, which drifted and cannot be seen by a host that renders off-process (remote session / extension hosts).

## Two build configurations

This package ships **two** tsdown configs. They differ in exactly one dimension — dependency handling — and share their entries and dependency lists in `tsdown.shared.ts` so they cannot drift.

| Config | Script | Dependencies | Consumers |
|--------|--------|--------------|-----------|
| `tsdown.config.ts` | `pnpm build` (default) | external | every host in this repo (playground, extension, cli, codent) |
| `tsdown.config.release.ts` | `pnpm build:release` | inlined | the fully bundled release paths (`build:codent`, `pnpm publish:*`) |

### Why the default leaves dependencies external

Two reasons, and the second is the one that bites:

1. **Avoid duplicate builds.** Whatever is inlined here gets bundled *again* by each host that inlines `@codent/app`. Leaving a dependency external means it is built once, by whoever owns it.
2. **Let the host pick the module form.** Inlining freezes one form into the artifact before any host has a say. `reactivity-store` is the worked example: the release config resolves it on the Node platform target, so it lands as its **CJS** entry, whose `require("react")` becomes a `createRequire` call — and the playground's `node:module` stub turns that into a thrown `require() is not available in the browser`. A host resolving the package itself picks the `module` (ESM) entry and the problem does not exist.

### Renderer is external under its real name

The `rewriteRendererSpecifiers` plugin rewrites bare `react` / `ink` to `@my-react/react` / `@my-react/react-terminal` at resolve time, so the published graph never contains the bare names (npm does not dedupe an alias against the real package name, which produced two hook dispatchers and a blank TUI).

A consequence hosts must handle: the emitted specifier is `@my-react/react-terminal`, **not** `ink`. A browser host therefore has to alias *both* spellings to the package's `/web` entry — aliasing only `ink` silently resolves the Node entry, which imports `signal-exit` and reads `process.platform` at module scope (`process is not defined`). See `packages/playground/vite.config.ts` and `packages/extension/wxt.config.ts`.

## Validate

```bash
pnpm --filter @codent/app run validate:core-imports
pnpm --filter @codent/app run validate:presentation-helpers
pnpm --filter @codent/app run validate:session-only-smoke
pnpm --filter @codent/app test
```

### Manual Local CLI checklist (3.7)

With `pnpm start:cli` in a real workspace:

1. Chat: send a message, confirm streaming reply
2. `/mode plan` → plan mode footer; write/save plan; `/mode execute` if ready
3. `/compact` after enough context
4. Spawn a `task` subagent → `Ctrl+T` panel lists child + preview
5. Start with resume picker (`--resume` / picker mode) → list via Session, resume one session
