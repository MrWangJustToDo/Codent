# @codent/app

Shared UI layer (CLI + extension). Agent control is **Session-only**: hooks, layout, and slash commands use `AgentSession` / `AgentSessionHost`, not `ManagedAgent` / `agentManager`.

`useAgent` stores `session` / `host` with `markRaw`. reactivity-store selectors otherwise wrap those live handles as readonly proxies, and `subscribe` / `dispatch` silently no-op (Vue blocks `Set.add` on the proxy). Call `getActiveSession()`, `getActiveHost()`, or `resolveAgentSession()` (they `toRaw`) before using methods; in components `toRaw(useAgent((s) => s.session))` is equivalent.

**One session per runtime.** `useAgent` holds a single active `session` (plus its `host`). The convention is one live root session per runtime — a second session means a second runtime, not a second entry in this store. Other ids (subagents) are reached through `host.connect(agentId)` via `resolveAgentSession`, not a registry.

## `@codent/core` import allowlist

### Allowed (session-safe / presentation / CoreEnv)

| Category | Examples |
|----------|----------|
| Session API | `AgentSession`, `AgentSessionHost`, snapshots, commands, channel types |
| Serializable types | `AgentStatus`, `AgentMode`, `TodoItem`, `TokenUsage`, `LogEntry`, `PlanModeState`, `SessionMeta`, tool output types, `ExtensionInfo`, `AgentEvent` (typed envelope) |
| Status helpers | `isActiveStatus` |
| Presentation registry | `getToolPresentation` / `registerToolPresentation` / `describeToolPresentations` (tools declare a single `present` descriptor in core; the UI reads it) |
| CoreEnv plane | `CoreEnv` type, `FileEntry`, … — the env itself reaches the app through `CoreEnvProvider` / `useCoreEnv` (host-supplied) and is passed explicitly into the workspace utils; never ambient `getEnv()` |
| Model types | `DEFAULT_BASE_URLS`, `DEFAULT_LOCAL_OPENAI_BASE_URL`, `ModelStyle` / `ModelInfo` / `ModelCapability` / `ModelPricing` / `ReasoningConfig`; iteration limits `DEFAULT_AGENT_MAX_ITERATIONS` / `MAX_AGENT_ITERATIONS` (single source for the CLI/app default and help text) |
| Summary stream protocol | `agentStreamKey`, display-window helpers, `AgentStreamEvent` types |
| Edit preview (CoreEnv) | `previewEdit` (workspace read; no ManagedAgent) |

### Allowed only in Local adapter bootstrap

| Symbol | File |
|--------|------|
| `resolveModelConfigFromProvider`, `buildDefaultSystemPrompt` | `adapter/session-bootstrap.ts` |
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

### Platform reads must survive a browser host

The same components render in the playground and the extension, where a Node global that looks obvious simply is not there — the playground defines **no `process`**, and no host has a TTY. So a platform read is either taken from CoreEnv (`getPlatform()`, never `process.platform`) or comes with the guard this package uses everywhere else:

```ts
if (typeof process === "undefined" || !process.stdout?.isTTY) return;
```

`enableWheelAsArrows()` is the worked example: an unguarded `process.stdout.isTTY` threw a `ReferenceError` out of the workspace panel's mount effect, so the web app never rendered. `test/alternate-screen.test.mjs` pins both shapes by standing in a `process` (absent / no stdout / TTY / non-TTY) around the real helper — Node's own `process` always exists, so a copy of the condition would prove nothing.

## Themes

Two palettes — `theme/colors-gemini.ts` (default) and `theme/colors-claude.ts` — export the same `COLORS` / `BG` / `GRADIENT` symbols. `/settings theme` (or `useTheme`'s `setTheme` / `toggle`) calls `applyColorPalette`, which `Object.assign`s the values **onto** the shared objects exported by `theme/colors.ts`, then rebuilds the markdown theme. Call sites keep importing `{ COLORS, BG }` from `theme/colors.js`, never a palette file directly.

That in-place mutation is the whole seam, so **palette values must be read at render time**:

```tsx
// ✓ resolved per render — a theme switch repaints it
const statusColor = (status: TodoStatus) =>
  status === "completed" ? COLORS.success : status === "in_progress" ? COLORS.primary : COLORS.muted;

// ✗ captures the palette that was active at import — /settings theme can never repaint it
const STATUS_COLORS = { pending: COLORS.muted, in_progress: COLORS.warning, completed: COLORS.success };
```

The second shape is how the `todo` tool kept rendering gemini colors in a claude session. Because `Object.assign` only overwrites the keys a palette actually has, both palettes must also declare the same keys — a key present in one alone silently keeps the previous theme's value.

Guards (`pnpm --filter @codent/app run validate:theme-palettes`, plus `test/theme-palettes.test.mjs`):

| Assertion | Why |
|-----------|-----|
| key parity across palettes | `Object.assign` staleness |
| contrast floors — 4.5:1 for every `COLORS` value on the base background and on `BG.toolResult`, 4.5:1 for `text` / `accent` / `muted` on `BG.message`, 8:1 for `text` there, 1.15:1 for strokes and 1.10:1 for fills | a hex is otherwise reviewed only by "looks fine in my terminal" |
| no module-scope palette capture outside `src/theme/` | the render-time rule above |
| `setTheme` repaints real consumers, and switching back restores the first palette exactly | proves the seam works and leaves nothing stale |

## Validate

```bash
pnpm --filter @codent/app run validate:core-imports
pnpm --filter @codent/app run validate:presentation-helpers
pnpm --filter @codent/app run validate:session-only-smoke
pnpm --filter @codent/app run validate:theme-palettes
pnpm --filter @codent/app test
```

### Manual Local CLI checklist (3.7)

With `pnpm start:cli` in a real workspace:

1. Chat: send a message, confirm streaming reply
2. `/mode plan` → plan mode footer; write/save plan; `/mode execute` if ready
3. `/compact` after enough context
4. Spawn a `task` subagent → `Ctrl+T` panel lists child + preview
5. Start with resume picker (`--resume` / picker mode) → list via Session, resume one session
