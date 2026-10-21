# @codent/core — Runtime Architecture

This document describes how `@codent/core` boots, initializes agents, and runs the main loops: session, tools (including approval), compaction, and memory.

For monorepo-wide context see [AGENTS.md](../../AGENTS.md). For public exports see [src/index.ts](./src/index.ts).

---

## Completion status (as of 2026-10)

| Area                                      | Status           | Notes                                                                                                                   |
| ----------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| CoreEnv abstraction                       | **Done**         | `registerCoreEnv` / `getEnv`                                                                                            |
| Agent factory & manager                   | **Done**         | Root vs subagent split                                                                                                  |
| TanStack agent loop                       | **Done**         | `AgentRunner` + middleware stack                                                                                        |
| Event protocol + log extension              | **Done**         | Unified `AgentEventBus` (one bus, emit/intercept, retain/scope); the built-in log extension is its only `"*"` consumer                     |
| Model config (`openai` / `anthropic`)     | **Done**         | `resolveModelConfig`, `createTextAdapter`                                                                               |
| Model catalog read                        | **Done**         | ONE `loadModels` per host plane, carried on the runtime (`readModels()` — entries only); the selected model is the **session's** |
| Session persistence                       | **Done**         | Unified `persistSession`; save failures reject + emit `session:save-error`                                              |
| Agent Session API                         | **Done**         | Snapshot/commands + Local/Remote Host; **app is Session-only** (no ManagedAgent in UI)                                  |
| Compaction (micro / auto / reactive)      | **Done**         | + manual compact via ManagedAgent / Session `compact`                                                                   |
| Memory (prefetch / extract / consolidate) | **Done**         | Post-run extraction; in-flight extracts coalesce to latest (`queued`)                                                   |
| Tool approval                             | **Done in core** | `status` middleware + `needsApproval` on tools; app handles UI/keyboard only                                            |
| Extensions                                | **Done**         | `ExtensionRunner` + `extensions-middleware` + per-turn `before_agent_start` / turn-context providers                    |
| Plan mode                                 | **Done**         | `PlanModeController` + tool filter + `/mode plan`; session `planMode` restore; executing auto-approve gated on `todosSeeded` |

**Known gaps**

1. **Tool approval UX** — core `AgentChatController` owns tool-phase continuation (package-internal); app handles UI/keyboard only.
2. **Subagents** — no session store, memory, MCP, or extensions (by design).
3. **`reasoningConfig`** — `defaultEffort` is wired as the runner's default when no explicit `reasoningEffort` is configured (`run-agent.ts`); `effortValues` remain advisory (adapter picks closest supported effort).

---

## Layer diagram

```
┌─────────────────────────────────────────────────────────────────┐
│ Hosts: CLI / Extension                                           │
│   AgentSession (Local or Remote) ← preferred host API              │
│   registerCoreEnv(node|remote) — workspace plane (separate)      │
└────────────────────────────┬────────────────────────────────────┘
                             │ getSnapshot / dispatch / subscribe
┌────────────────────────────▼────────────────────────────────────┐
│ @codent/core                                                  │
│  AgentSession ← AgentEventBus channel projection (AGENT_EVENT_META)  │
│  AgentManager ──► ManagedAgent (run semantics unchanged)         │
│  AgentEventBus (root) ──► log extension (only "*" observer consumer)│
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│ Workspace: node | server /api/fs|command…                        │
│ Agent HTTP: server /api/agent/* (Session REST + SSE)             │
└─────────────────────────────────────────────────────────────────┘
```

---

## 1. Startup entry points

### 1.1 Host bootstrap (CLI example)

```
packages/cli/src/index.tsx
  loadEnv()
  parseCliArgs()
  coreEnv = createNodeEnv(...) | createRemoteEnv(url)
  provider = createDirectModelProvider(...) | createRemoteProvider(url)
  registerCoreEnv(coreEnv) / registerModelProvider(provider)   // ambient fallback
  initConfig() → useWorkspaceInfo.init(coreEnv)
  render(<CoreEnvProvider value={coreEnv}><AdapterProvider value={new LocalAgentAdapter({ env, provider })}>…<App/></…)
```

**Rule:** prefer `CodentAgent.create({ env, provider | direct, host? })`; the ambient `registerCoreEnv()` / `registerModelProvider()` are the fallback for scripts and code without a runtime in scope. `registerCoreEnv()` must run before any `@codent/core` API that touches filesystem, shell, or platform (that includes `initConfig` / `useWorkspaceInfo.init`); model resolution goes through the runtime's provider — `CodentAgent.create` must be given the provider (or `direct` fields) before agents run.

### 1.2 App agent creation

```
packages/app/src/adapter/create-agent.ts
  resolveModelConfigFromProvider({ model, style, baseURL, apiKey }, host.getModelProvider?.())
    // uses the runtime's ModelProvider (remote forces baseURL/apiKey); ambient fallback when omitted
  host.create({ modelInfo, modelStyle, ... })   // host = CodentAgent.host (local) | remote host
  wire React stores (useAgent)
  optional: continueLatestSession() / resumeSession() → initialMessages
```

### 1.3 Chat transport (in-process)

| API                                                                                | File                                | Use                                                 |
| ---------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------- |
| `ManagedAgent.initChat(manager, initialMessages?)`                                 | `managers/agent-chat-controller.ts` | Main CLI chat session                               |
| `AgentChatController.sendMessage` / `steer` / `followUp` / `respondToToolApproval` | same                                | User turns, mid-run queues, tool-phase continuation |
| `agentManager.runAgentStream(agentId, input)`                                      | `managers/run-agent.ts`             | Core streaming entry                                |
| `AgentSession` / `AgentSessionHost`                                                | `agent-session/`                    | Preferred host/UI control surface                   |

### 1.4 Public vs internal APIs

| Symbol                                                            | Exported from `@codent/core`?                                                     |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `CodentAgent`, `CodentAgentOptions`                               | Yes — **preferred runtime entry** (`CodentAgent.create({ env, provider | direct, host? })`); `AgentRuntime` is internal (`dev.ts`). `readModels()` reports the **catalog** the runtime was built with (entries, no active selection) |
| `agentManager`, `AgentManager`                                    | Yes — **deprecated ambient fallback**; UI hosts must use AgentSession              |
| `ManagedAgent`, `ManagedAgentConfig`                              | Yes — bootstrap only; app forbids importing ManagedAgent                            |
| `AgentChatController`                                             | **No** — package-internal (`dev.ts` / validate); reached via ManagedAgent bootstrap |
| `ManagedAgent.initChat`                                           | Yes (bootstrap helper)                                                              |
| `AgentSession`, `AgentSessionHost`, `createLocalAgentSessionHost` | Yes — **preferred host/UI control surface**                                         |
| `buildManagedAgent`, `getDefaultSkillDirs`                        | **No** — package-internal / `dev.ts`                                                |
| Session-sync tracker helpers, tool-phase pump helpers             | **No** — `dev.ts` / package-private                                                 |
| The built-in log extension                                        | **No** — a `StreamConsumer` in the `agent/log` domain (it owns the `"*"` subscription via `start()`)                                          |
| `SessionStore`                                                    | **No** — DENY list; use Session / SessionService                                    |

See `scripts/validate-core-public-exports.mjs` for the authoritative DENY/EXPECT lists.

### 1.5 Module layering

```
hosts / app  →  runtime (CodentAgent / AgentRuntime)  →  managers (orchestration)  →  agent/* (domain)  →  models / provider / env
                              ↓
                       runtime-types/   (shared status, events, TokenUsage — no manager deps)

env/ is the workspace plane (CoreEnv) — an orthogonal leaf. provider/ is the LLM plane
(ModelProvider + registry); `models/` (config + models.dev metadata) and `provider/` are a
**coupled pair** — `provider→models` resolves a connection from config, `models→provider`
lists/registers an entry's provider — a known, bounded cycle (both edges are narrowed in
`validate:layer-boundaries`). The runtime composes the planes.
```

**Rules (enforced by `validate:layer-boundaries`):**

That gate derives the edges from the imports rather than from a pattern: it reads each
file as one text (a multi-line `import { … } from "…"` is an edge too — the earlier
line-at-a-time parser silently missed 16 of the `managers → agent` imports), resolves
every relative specifier to its top-level layer, and checks the pair against an edge
table. It enforces **three** properties:

1. **Declared edges** — every used edge is in the table, each with a reason; a `type-only`
   entry additionally forbids a runtime value from crossing. A re-exported type is an
   edge, but a weaker one.
2. **No dead grants** — every table entry is exercised by at least one import. A grant
   nobody uses reads as a boundary while nothing tests it, and it hides the fact that the
   module it was written for no longer crosses it (`env → runtime-types` and
   `runtime → utils` were exactly that and were deleted).
3. **Acyclic module graph** — the runtime-value import graph between **files** has no
   cycle. This is the property the layer diagram cannot state: `models` ↔ `provider` and
   `agent` ↔ `models` cross at layer granularity by design (config entries construct
   providers; side-text-query reuses two leaf helpers), but the modules underneath form a
   DAG. Type-only imports erase and may cycle freely — `runtime-types/hosts.ts` is a port
   hub and does.

- `agent/**` MUST NOT import `managers/**` (the manager-side ports it needs are declared in `runtime-types/hosts.ts`)
- `models/**` MUST NOT import `managers/**`
- `runtime-types/**` may only reach upward from `hosts.ts` (the port file), type-only
- `env/index.ts` is the bottom of the stack and must not import upward — process-scoped teardown is registered via `env/teardown.ts` hooks instead
- Edges that must stay type-only: `agent → agent-session`, `models → agent` (narrowed to two leaf modules), `runtime-types → {managers, agent, models}`
- Package-wide stream helpers live in `agent/stream/` (not under `subagent/`)
- UI channel lives in `agent/ui/ui-channel.ts`
- Run middleware lives in `managers/middleware/` (wired by `run-agent`); plan-mode middleware stays in `agent/plan/`
- The LSP transport port lives in `env/lsp.ts`, beside the `CoreEnv.createLspConnection` that names it
- A value cycle is broken by **moving the shared function down or injecting the dependency**, never by
  adding an edge. Both shipped fixes are worked examples: `getMessageContentSize` (renamed from its tool-only spelling) moved down into
  `token-estimator.ts` (so `message-utils` → `token-estimator` is the only direction, and the
  duplicated `estimateContentChars` disappeared with it), and `progress-summary` takes its summarizer
  spawner as a `SummarizerSpawn` argument (`run-subagent` passes `runSubagent`, and
  `SubagentRunDeps` moved to `types.ts` so no type edge is needed either).

> History: this replaced two gates that shared one regex (a specifier containing `/managers/`), so `models → agent`, `runtime-types → *`, `env → agent` and `agent → agent-session` had no coverage at all. Two gates covering two of six edges reads as coverage and is not.

### 1.6 ManagedAgent host surface

| Field / API                                 | Host access                                                                        |
| ------------------------------------------- | ---------------------------------------------------------------------------------- |
| `status`, `context`, `ui`                   | Read-only getters                                                                  |
| `usage`, `planMode`, `autoMode`             | `readonly` service refs (mutate via methods); auto and plan are mutually exclusive |
| `runner`, `textAdapter`, `runnerConfigKey`  | **Private** — package-internal accessors only                                      |
| `setStatus` / `setContext` / `setUIChannel` | Mutation entry points (`setUIChannel` package-internal)                            |
| `statusController.applyRunOutcome(...)`     | Unified run finalization (chat + detached/subagent)                                |

---

### 1.7 Identity: runtime / agent / session

> **runtime = where it runs (env + keys) · agent = who runs (handle, process-scoped) ·
> session = what was said (persisted, survives a restart)**

| id | Minted by | Prefix | Lifetime | Keyed on it |
| --- | --- | --- | --- | --- |
| agent id | `ManagedAgent` (`init.id ?? generateId("agent")`) | `agent_…` | **One process**; re-minted on restart | `AgentManager.agents` catalog · event-bus scope (`of(agentId, parentId)`) · **AgentSession addressing** · remote `/api/agent/:id` · `parentId` · per-agent log file name |
| disk session | `SessionStore` | `ses_…` | **Across restarts** | `.agents/sessions/<id>.jsonl` · `.agents/logs/<id>/` · `session.resume` · `AgentSessionSnapshot.activeSessionId` · session-ownership claims |
| `task` subagent ids | `generateId("subagent")` | `subagent_…` | One process | task rows / panel · that agent's log file name |

`AgentSession` is **not** a fourth id: a handle is addressed by `agentId` (`host.create()`,
`host.connect(agentId)`, `/api/agent/:id`) and *carries* the disk session it is attached to.
The two id spaces meet where a handle is **resolved**: the catalog operations actually take the
disk id (`listPersistedSessions` / `deleteSession`, and ACP's `session/list` / `session/delete`),
while every other request goes through the agent id.

Today's contract:

- One runtime owns one `AgentManager` → one live root agent → one `AgentSession` (the app layer is
  session-only: a second conversation is a second runtime).
- A subagent has **no** disk session, but does have its own log file under the root agent's session
  directory — the directory is keyed by the disk session, the file name by the agent.
- `parentId` always references an **agent id**, never a session.
- One disk session is held by one live agent at a time (`AgentManager.sessionOwners`).
- `/resume` **re-binds** the existing agent instance to another disk session (it does not create a
  second agent); the previous session's ownership is released on the switch.

Direction (if one agent is ever to serve several sessions): the conversation-scoped state moves off
`ManagedAgent` into a session object, `ManagedAgent.id` stops being the correlation key (the disk
session becomes it), and session ownership grows a **file-level** lease — today's claim table is
per-manager, so two runtimes over one workspace can open the same session and each write its own copy.

---

## 2. Initialization process

### 2.1 `AgentManager.createManagedAgent(config, parentId?)`

```
agent-manager.ts
  buildManagedAgent({ config, manager, emit, getDefaultSkillDirs })
  agents.set(managed.id, managed)
  emitSessionBootstrapEvents(managed, bootstrap)   // root agents only
  link parent.childIds if subagent
```

### 2.2 `buildManagedAgent` wiring (`agent-factory.ts`)

**Root agent** (`!parentId`):

| Step | Action                                                                                                                                                                                                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `AgentLog`, `TodoManager`, `ManagedAgent` (UI channel attached before LLM runs)                                                                                                                                                                                                             |
| 2    | `createTools()` → filesystem, grep, glob, tree, run_command, …                                                                                                                                                                                                                              |
| 3    | `managed.setEventBus(manager.of(agentId, parentId))` — agent-scoped `AgentEventBus` for session projections + telemetry `dispatchEvent` (up-flows to root)                                                                                                                                                                                                                              |
| 4    | `loadAgentDoc()` → `setAgentDocContent` (AGENTS.md / CLAUDE.md)                                                                                                                                                                                                                             |
| 5    | `todo`, `webfetch`, `websearch`, `ask_user` tools                                                                                                                                                                                                                                           |
| 6    | `SkillRegistry.loadFromDirectories` → `list_skills`, `load_skill`, `task`                                                                                                                                                                                                                   |
| 7    | `setCompactionConfig` from model context window                                                                                                                                                                                                                                             |
| 8    | Create `McpManager` + `MemoryManager` data layers (connected / registered later by the built-in extensions below)                                                                                                                                                                           |
| 9    | `ExtensionLoader` / `ExtensionRunner` — scan `.agents/extension` then `~/.agents/extension` (plus `AGENT_EXTENSION_DIRS` / `config.extensionDirs` / `--extension-dirs`); programmatic `config.extensions` last                                                                              |
| 10   | Built-in extensions through the runner — LSP (`codent-lsp`), Skills (`codent-skills`), Memory (`codent-memory`), MCP (`codent-mcp`: `McpManager.initialize` on activate, tools kept as `mcp__<server>_<tool>` with multimodal `content[]`, `/mcp` command; deactivate → `shutdown`) |
| 11   | `SessionStore` → `setSessionStore({ modelStyle, model })`                                                                                                                                                                                                                                   |

**Subagent** (`parentId` set): inherits parent config via `spawnSubagent`; skips docs, skills, MCP, memory, extensions, session, and most root-only tools.

### 2.3 Event infrastructure — the unified bus (manager construct time)

```
AgentManager constructor
  rootEventBus = createAgentEventBus()            // single process-wide root
  createLogExtension({ bus, resolveLog }).start()  // only "*" observer consumer
                                                 // (bridgeTelemetryToAgentLog is its policy half)

ManagedAgent.setEventBus(manager.of(agentId, parentId))  // per-agent scoped bus
  agent:state / session:* retained providers registered here
  telemetry dispatchEvent re-routed onto the scoped bus (up-flows to root)
```

One registry (`AgentEvents` type map + `AGENT_EVENT_META`), two dispatch modes:

| Mode         | Mechanism                                                                                     | Role                                    |
| ------------ | --------------------------------------------------------------------------------------------- | --------------------------------------- |
| Observer     | `bus.emit` / `bus.on("name"| "*")` — sync, fire-and-forget, error-isolated; `retain` replays current value to late subscribers | state / messages / usage / lifecycle notifications |
| Interceptor  | `bus.intercept` / `bus.onIntercept` — async, shared mutable event, cancel short-circuit, `tool:before:*` pattern keys, ordered by declared dispatch order (`ExtensionAPI.order`, §8.5) | extension tool before/after/error hooks, `before_agent_start` |

`AgentSession` subscribes the agent's scoped bus **once** and projects every
observer event to a session channel declared in `AGENT_EVENT_META[type].channel`;
per-subscriber reconcile replays retained channels (state/mode/mcp/…) so late
subscribers see initial values without a snapshot refetch. `scope(id)` mints
child buses — a subagent's events up-flow to its parent and the root, while
siblings stay isolated.

### 2.4 Session bootstrap events (`session-bootstrap-events.ts`)

Emitted **after** the agent is registered (so the log extension can resolve `managed.log`):

| Event            | When                       |
| ---------------- | -------------------------- |
| `session:doc`    | Agent doc loaded           |
| `session:skill`  | Skills registered          |
| `session:mcp`    | MCP servers connected      |
| `session:memory` | Memory index ready         |
| `session:start`  | Bootstrap complete (`cwd`) |

These also map to hook scripts where applicable (`SessionStart`, `Notification`, etc.) via `agent-event-bus.ts`.

**Note:** `session:start` does not create a `SessionData` file yet. The first on-disk session record is created lazily on first save.

---

## 3. Session start flow (user prompt → first LLM call)

### 3.1 Shared run skeleton + profiles

Inner LLM/tool stream execution is shared. Outer orchestration differs by **profile**:

```
Shared skeleton (agent/run/run-agent-skeleton.ts)
  ensureUIChannel → manager.runAgentStream → consumeAgentStream(channel)
  → optional applyRunOutcome(path: chat|detached)

InteractiveChat profile (AgentChatController)
  pumpToolPhases / queues / approvals / session persist
  → runAgentOnce(channel) per stream; outcome path "chat" after full pump

Worker profile (runSubagent — task / compact)
  spawn + tool isolation → always ensureUIChannel → runAgentOnce once
  → bridgeUI only gates parent panel / task-tool streaming
  → outcome path "detached" (avoids task-panel ghosts)
```

Host observation remains **AgentSession** only. One runtime owns exactly one live root session (a second session is a second runtime); it reuses this same run skeleton. `AgentManager`'s ownership registry (`Map<sessionId, agentId>`) keeps each disk session bound to one live agent (§6.3).

### 3.2 `runAgentStream` pipeline

```
run-agent.ts: executeManagedAgentRun
  ensureAgentRunner(managed)          // build middleware + AgentRunner
  managed.prepareForRun({ messages, abortSignal })
  // Reuse RunCoordinator.currentAbortController as TanStack chat abortController
  // so ManagedAgent.abort() cancels the live stream (main agent + subagent/task).
  runStreamWithRecovery({ run: () => runner.run({ abortController }) })
```

### 3.3 `prepareForRun` (`managed-agent.ts`)

```
RunCoordinator.setupAbortController(abortSignal)  // current = run AbortController
if !isToolContinuationPrepare(agent.status, messages):
  memory.prefetchRelevantMemories()     // see §7
  emitEvent("prompt:submit", { prompt })
```

`AgentChatController.executeStream` must **not** create a second AbortController before `runAgentStream` — that previously left `abort()` cancelling a controller `chat()` was not listening to. Status middleware keeps `"aborted"` sticky so leftover chunks cannot resurrect `"running"`.

On user cancel, `cancelIncompleteToolCalls` marks truncated / never-executed tool calls (`input-streaming`, orphan `input-complete`, etc.) as `error` with a synthetic tool-result. That stops the UI spinner and prevents the next `chat()` from re-entering TanStack `executeToolCalls` with invalid JSON arguments.

`isToolContinuationPrepare` uses existing state — no extra run-phase field:

- `status === "waiting"` (approval pause), or
- last message is not `user` (tool-phase / approval continuation within the same turn).

### 3.4 Middleware stack (each LLM iteration)

Built in `buildAgentRunner` (`run-agent.ts`), order matters.
Sources: `managers/middleware/*` for run stack; `agent/plan/plan-mode-middleware.ts` for plan gating.

```
1. status-middleware         status transitions only (via AgentStatusController)
2. approval-resume-middleware re-apply persisted approvals so resumed tools do not re-prompt
3. lifecycle-middleware      usage tracking, thinking events, memory commit, llm:request/response
4. compaction-middleware     auto-compact + channel-anchored wire projection (cache by revision)
5. message-transform-middleware  extension message transformers (registerMessageTransformer).
                             MUST run immediately after compaction, and ONLY consumes
                             config.messages — anything placed before the projection is discarded
6. wire-recovery-middleware  per-run wire overrides that are NOT in the channel: the capability
                             strip (unsupportedMultimodalPartTypes) and the max_tokens
                             continuation prompt. MUST run after message-transform: a strip
                             replaces media with a placeholder, so stripping first would hide
                             the real attachment from an extension transformer
7. tool-compact-middleware   per-tool LLM shaping
8. turn-context-middleware   inject changed <ctx kind=...> sections post-compaction (per-kind
                             hash diff; subagents filtered by SUBAGENT_ALLOWED_KINDS whitelist;
                             systemPrompts = frozen only)
9. extensions-middleware     ExtensionEventBus intercept + agent:tool-* lifecycle events
10. early-tool-result-ui      apply each tool output to StreamProcessor as soon as it finishes
11. task-prefork-middleware  subagent task prefork / phase state
12. plan-mode-middleware     block forbidden tools while plan mode restricts tooling
13. background-notification-middleware
                             completed background-command notifications as <ctx kind=background_notification>
                             synthetic messages (append; persisted + id-deduped)
14. prompt-cache-middleware  Anthropic cache_control + OpenAI prompt_cache_key + sorted tools
                             (must stay last so cache breakpoints see the final payload)
```

Each middleware declares its own phase (`observe` / `context-transform` / `tools` / `wire-annotate`) via
`defineMiddleware(phase, { name, ... })`, and `sortMiddlewaresByPhase` stable-sorts by phase. **Within a
phase the array position in `buildAgentRunner` decides the order**, so same-phase adjacency is a real
contract — `compaction`, `message-transform`, and `wire-recovery` are all `context-transform`, which is why
`validate:middleware-order` drives `buildAgentRunner` instead of checking a copied factory list.

### Wire overrides vs. the channel projection

The projection in `compaction` is the authority on what the model sees: it rebuilds every wire call from
`channel.getMessages()` and **discards the incoming `config.messages`**. That makes `config.messages` a
write-only channel on the way in — anything that edits the array handed to `runner.run()` applies to the
first call of a run only and is overwritten from the second call on.

Three call sites assumed the older contract and were silently dead: the pre-send capability strip, the
widened strip retry after a multimodal API rejection, and the `max_tokens` continuation prompt. They now
arm per-run state on `RunCoordinator` (`setWireDropPartTypes` / `setWireContinuationArmed`) which
`wire-recovery` applies after the projection. Two rules follow:

- **Never edit the messages passed to `runner.run()` expecting them to reach the model.** State the
  intent on the run and let `wire-recovery` apply it, or write to the UI channel if it should be durable.
- **Anything wire-only stays wire-only.** The strip and the continuation prompt are never written to the
  channel, so the persisted session and the transcript keep the original media and only what the user said.

### Message-operation ownership (writers on the wire are pure)

`compaction` rebuilds the wire from the channel and `WireProjectionCache` returns the **same array
reference** on every hit within a run. The projected array is therefore shared, long-lived state, and a
writer that edits its input instead of returning a replacement corrupts every later call of the run — with
no error and no other guard noticing. Rules:

- **Every writer returns a replacement** (new array, and new message objects for changed entries).
  `applyToolCompact` and `injectSyntheticMessages` both follow this; the latter returns `{ injected, messages }`
  so a caller must use the new wire rather than rely on a side effect on the old one.
- **Read the cache before parsing.** `applyToolCompact` consults `ToolCompactCache` *before*
  `parseToolMessageOutput`. Decoding a tool payload (`JSON.parse` of up to ~100KB per result) runs on every
  model call and its result is discarded on a hit — that decode was most of the cost: 0.49 ms/call →
  0.05 ms/call for 60 results × 25 KB payloads.
- **One projection implementation.** `projectWireFromChannel` (`managers/middleware/wire-projection.ts`) is
  shared by the compaction middleware and `ManagedAgent.getMessagesForLLM` (manual `/compact`, reactive
  compact, memory extraction, run-outcome previews), over the agent's single `WireProjectionCache`. A second
  projection is what would let a reader disagree with the window the model actually receives.

Validate: `pnpm --filter @codent/core run validate:message-ops-purity`.

TanStack runs tools sequentially but emits batched `TOOL_CALL_END` results only after the whole tool phase. `early-tool-result-ui` calls `AgentUIChannel.addToolResult` in `onAfterToolCall` so finished tools (e.g. the first of two `task` calls) show complete while later tools still run. The later stream chunks re-apply the same output idempotently.

**Approval continuation:** After the user (or auto-approve) responds, a second `chat()` run executes pending tools and TanStack may re-emit `TOOL_CALL_START`/`ARGS` with an `argsMap`. `AgentUIChannel` drops those replays when the `toolCallId` already exists in UI messages so the call is not cloned onto a new assistant (approval metadata stays on the original part). `TOOL_CALL_END`/`RESULT` still flow to update that part.
Status logic is centralized in `AgentStatusController` (`managers/agent-status-controller.ts`). `status-middleware` is the runtime hook for status; `lifecycle-middleware` owns usage and run finalization side-effects. Chat and detached runs converge on `statusController.applyRunOutcome(...)` (see `managers/agent-run-outcome.ts`).

### 3.5 Lifecycle status transitions

| Phase                       | Status                  | Trigger                                                      |
| --------------------------- | ----------------------- | ------------------------------------------------------------ |
| Run starts                  | `running`               | `status.onRunStart` / `prepareRunPhase`                      |
| Model reasoning             | `thinking`              | `REASONING_MESSAGE_*` chunk                                  |
| Text output                 | `responding`            | `TEXT_MESSAGE_CONTENT`                                       |
| Tool call                   | `running`               | `TOOL_CALL_START`                                            |
| Tool approval pending       | `waiting`               | `status.syncApprovals` on `onToolPhaseComplete`              |
| Client tool (`ask_user`)    | `awaiting_user`         | App host calls `ManagedAgent.setClientToolWaiting(true)`     |
| Auto-compact                | `compacting`            | `status.beginCompaction("auto")`                             |
| Reactive compact            | `compacting`            | `status.beginCompaction("reactive")`                         |
| Success                     | `completed` / `idle`    | `onRunFinish` (preserves `waiting` / `awaiting_user` if set) |
| Stream ended, tools waiting | `completed` / `waiting` | `statusController.reconcileAfterRun` after `pumpToolPhases`  |
| User abort                  | `aborted`               | `onRunAbort` / `onUserCancel` / `RunCoordinator`             |
| Error                       | `error`                 | `onRunError` / `onExternalError`                             |

---

## 4. Tool approval flow

Core **declares** which tools need approval and **owns agent status** during the approval pause. **Execution blocking** and resume are still handled by TanStack AI + `@codent/app` (`addToolApprovalResponse`).

### 4.1 Core: `needsApproval: true` + status middleware

`createStatusMiddleware` (`managers/middleware/status-middleware.ts`) delegates approval transitions to `AgentStatusController`:

| Hook                  | Action                                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `onToolPhaseComplete` | When `info.needsApproval.length > 0`: `waiting`, `setPendingApprovalCount`, emit `agent:tool-approval-request` per tool |
| `onBeforeToolCall`    | When status is `waiting`: clear count, `running` (approved tool executing)                                              |

Tools with approval required (`defineServerTool` in `runtime/define-tool.ts`):

- `write_file`, `edit_file`, `delete_file`
- `run_command`

Helper (available but not used by app today):

```typescript
managed.isToolNeedsApproval(toolName); // managed-agent.ts
```

### 4.2 TanStack protocol

`AgentRunner.run()` → TanStack `chat({ tools, middleware })` emits stream chunks. When a tool has `needsApproval: true`, the stream includes approval request state on tool parts (`part.approval`).

### 4.3 App layer (not in core)

| Step                         | Location                                                                                                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Chat session                 | **core** `AgentChatController` — `StreamProcessor` + `pumpToolPhases()`                                                                                                                                                              |
| App hook                     | `use-agent-chat.ts` — `AgentSession` dispatch + subscribe (`messages` / `queues` / `state`)                                                                                                                                          |
| Detect pending approval (UI) | `use-agent-chat.ts` — `isPendingToolApproval()` for keyboard / input mode                                                                                                                                                            |
| Agent status                 | **core** `approval` middleware — not app                                                                                                                                                                                             |
| UI                           | `ToolCallPartView.tsx`, `Footer.tsx`                                                                                                                                                                                                 |
| Keyboard                     | `use-agent-keybindings.ts` — `y` approves **one** pending tool per press; `n` enters freeform deny-reason input                                                                                                                      |
| Deny reason                  | App collects reason in freeform mode; `respondToToolApproval(id, false, reason)` stores it on `part.approval.reason` and adds a `tool-result` part for the LLM                                                                       |
| Empty model turn             | TanStack may leave a `parts: []` assistant shell after `TEXT_MESSAGE_START` with no content; `AgentUIChannel.finalizeStream()` strips trailing shells; `needsAgentResponseAfterTools()` skips shells when deciding pump continuation |
| Resume                       | `respondToToolApproval()` — core re-runs while `shouldContinueAgentPump()` (approved execution or model follow-up after denial)                                                                                                      |

**Mixed tool batches** (e.g. `tree` + `run_command`): TanStack defers non-approval tools while approvals are pending. Core `pumpToolPhases()` loops `runAgentStream()` until `shouldContinueAgentPump()` is false — no `ChatClient.shouldAutoSend()`.

**Steering / follow-up queues:** While a pump is executing (`pumpDepth > 0`) or status is `waiting` / `awaiting_user`, `steer()` / `followUp()` enqueue user content without aborting. A finished pump that left status `running` because tool-phase work remains (`shouldContinueAgentPump`) does **not** defer — `sendMessage` starts a fresh pump (and the controller auto-chains another pump when the phase cap is hit). Drain points in `pumpToolPhases`:

| API        | When delivered                                                                |
| ---------- | ----------------------------------------------------------------------------- |
| `steer`    | After tool execution finishes for the current batch, before the next LLM call |
| `followUp` | Only when the agent would otherwise stop (no tool continuation)               |

Default drain mode is `one-at-a-time`. `stop()` / `clearMessages()` clear both queues. Mid-run injects call `markNextPrepareAsContinuation()` so prepare skips memory prefetch / `prompt:submit`.

### 4.4 Client tools (`ask_user`)

Client tools pause the run until the host supplies output via `addToolResult`. Core does **not** infer UI status from message parts — the app sets it explicitly:

| API                                        | When                                                     |
| ------------------------------------------ | -------------------------------------------------------- |
| `ManagedAgent.setClientToolWaiting(true)`  | App detects pending `ask_user` (select list or freeform) |
| `ManagedAgent.setClientToolWaiting(false)` | User submits answer, before `addToolResult`              |

Status becomes `awaiting_user` (distinct from approval `waiting`). Exposed in CLI via `useAgentChat().setClientToolWaiting`.

**Critical:** `runner.run()` receives **UIMessages** from `AgentChatController` so TanStack `chat()` can extract `part.approval` before conversion.

No manual user text is required; each `y` only approves one tool when several `run_command` calls are pending.

### 4.4 Extensions vs user approval (different mechanisms)

| Mechanism                    | File                                                               | Purpose                                     |
| ---------------------------- | ------------------------------------------------------------------ | ------------------------------------------- |
| **User approval**            | TanStack + app                                                     | Block destructive tools until user confirms |
| **Extension deny/transform** | `extensions-middleware.ts` → `ExtensionEventBus` (`tool:before:*`) | Extension skip/transform before tool runs   |

Lifecycle tool events (`agent:tool-start` / `agent:tool-end` / `agent:tool-error`) always emit on the agent's scoped `AgentEventBus` (observer mode), whether or not an extension runner is present. Extension interception (`tool:before:*` / `tool:after:*`) is interceptor mode on the same bus.

---

## 5. Compaction flow

Three proactive layers run on **every** LLM iteration (via `compaction-middleware.onConfig`), plus reactive retry on API errors.

### 5.1 Layer 1 — Tool compact

**Files:** `agent/compaction/tool-compact/`, `managers/middleware/tool-compact-middleware.ts`

Runs **after** context auto-compact in the middleware stack.

- Tools with `toModelOutput` on `defineServerTool` are transformed for the LLM; result cached per `toolCallId` in `ToolCompactCache`
- **Skips** approval placeholders (`pendingExecution: true`) — tool-compact runs on `onConfig` before execution; transforming those messages would strip the marker and TanStack would skip the real tool run
- **Preserves tool errors** (`{ error: string }` from TanStack `output-error`) — bypasses success-only `toModelOutput` formatters and keeps an explicit `Error: …` text result
- **UI** `UIMessage` history is unchanged; only the LLM `ModelMessage` path is shaped

Large tool outputs at **execute** time still use `maybeCacheOutput` (`.agents/cache/tool-output/`) as a separate fallback — not part of compaction.

That cache has **two** collectors, and neither subsumes the other: compaction's `cleanupOrphanedToolCache` is reference-based and therefore only ever fires for a session that compacts, over files that session's wire referenced; `sweepStaleToolOutput` is an age sweep (7 days, lazily on the first cache write of a process) that catches everything the reference pass structurally cannot see — sessions that never compacted, and files no session ever referenced. Removing the age sweep reintroduces unbounded growth (measured: 289 of 688 files in a real workspace were unreferenced leak).

### 5.2 Adapter vs capability boundary

**Rule:** provider wire-protocol quirks belong under `packages/core/src/models/` (`createTextAdapter` and subclasses). Middleware / tools / UI must not branch on vendor names (`deepseek`, etc.).

| Kind                   | Where                                       | Examples                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Adapter-specific**   | `models/adapter-factory.ts`, `*-adapter.ts` | DeepSeek `reasoning_content` echo (`ReasoningChatCompletionsTextAdapter`); Chat Completions tool-image lift (`liftToolMediaForChatCompletions` — tool text stays string, images become a synthetic user `image_url` message); PDF text extract in `read_file` for Completions; Anthropic vs OpenAI Chat Completions style selection |
| **Capability-generic** | middleware / reactive retry                 | Multimodal strip via `vision`/`audio`/`video`/`document` (`capability-message-utils`); context-overflow reactive compact (provider `code` first)                                                                                                                  |
| **Config / metadata**  | `model-config`, `models.dev`, session       | `modelStyle`, pricing, `capabilities[]` (see below), unused-for-now `reasoningConfig` (tag/effort/budget — not yet mapped to request options)                                                                                                                                                                                        |

### Model capabilities — where the list comes from

The capability list has exactly one source of truth: `MODEL_CAPABILITIES` in `models/types.ts`. `ModelCapability` is derived from it, and the extension-facing boolean flags (`MODEL_CAPABILITY_FLAGS`, exhaustively keyed by that union) name each member — so the union, the list and the flag surface cannot drift apart, and a new capability is a compile error until it is named in both places.

`parseModelsDevModel` (`provider/models-dev.ts`) fills the list for a metadata-resolved model:

| Source | Grants | Notes |
| ------ | ------ | ----- |
| `modalities.input` | `vision` (`image`), `audio`, `video`, `document` (`pdf`; `document`/`file` aliases) | Authoritative, per-modality, exact in both directions. Primary source. |
| `attachment` | `vision` only | **Fallback**, used only when `modalities.input` is absent. It is one boolean and cannot say *which* modality, so it is never expanded into `document` — doing that once marked 34% of the catalog document-capable when only 23% accept `pdf`. |
| `reasoning` / `tool_call` / `structured_output` | `reasoning` / `tool_calling` / `json_output` | One-to-one booleans. |
| `cost.cache_read` or `cost.cache_write` present | `prompt_caching` | Caching is inferred from cache pricing existing. |

**`undefined` means unknown; `[]` means "declared, and none apply".** The two states look alike and mean opposite things, and keeping them distinct is what lets `UsageTracker.hasCapability` stay permissive without over-sending:

| `ModelInfo.capabilities` | `UsageTracker` | `hasCapability` | Pre-send strip for a text-only model |
| --- | --- | --- | --- |
| `undefined` (no metadata resolved) | `null` | permissive — allows everything | does **not** strip (nothing is known) |
| `[]` (resolved, no evidence) | `[]` | strict — denies everything absent | **strips** |

A successful metadata parse must therefore return `[]`, never `undefined`, for a plain text model. 330 of 7842 catalog entries resolve to `[]` (plain text / TTS) and are now correctly stripped; they were previously exempt because `[]` was indistinguishable from unknown.

Three hops have to preserve the distinction, and all three are guarded by `validate:capability-unknown-vs-none` (merge + probe) and `validate:model-capabilities` (mapping): `deriveCapabilities` (must emit `[]`, not seed a placeholder), `mergeModelInfo` (an override's `undefined` means "this side has no data", while an explicit `[]` is a real declaration that must win), and `UsageTracker.setCapabilities` (`undefined` → `null`).

A member removed from `MODEL_CAPABILITIES` makes an existing `MODEL_CAPABILITIES` env var / CLI value fail validation, since the schema rejects unknown names rather than ignoring them.

**Reasoning echo field (`interleaved`).** models.dev's `interleaved` is a union — `true` (names no field) or `{ field: "reasoning_content" | "reasoning_details" }` — and it is the only field that answers "does reasoning come back interleaved with tool calls, and on which wire field". It drives two `ModelInfo` fields:

| Field | Meaning |
| ----- | ------- |
| `reasoningInterleaved` | `interleaved` is present. **This is what the adapter routes on** — `capabilities.includes("reasoning")` alone is not enough. |
| `reasoningEchoField` | Set **only** for the non-default `reasoning_details`. `undefined` means `reasoning_content`, which is what the adapter already sends. |

Only 15 of 7842 entries name `reasoning_details`; the 982 that name `reasoning_content` and the 86 bare `true` entries all mean the default. Two entries (`siliconflow-cn/…/MiniMax-M2.5`, `novita-ai/minimax/minimax-m2.1`) carry `interleaved` **and** `reasoning: false` — routing on the capability flag gave them no echo adapter at all. Counts are asserted, so a catalog change surfaces instead of drifting.

`reasoningEchoField` is **not consumed**: the adapter still sends `reasoning_content`. What we can fix is the handoff, not the capture — TanStack's `extractReasoning` seam returns `{ text: string }`, so OpenRouter's structured `reasoning_details` blocks (encrypted / summarized / signed) have nowhere to live. OpenRouter accepts the string field (`reasoning_content` is a documented alias of `reasoning`), so this is a capability gap for signed/encrypted reasoning, not a hard failure. Validate: `validate:reasoning-echo` (rules) and `validate:model-capabilities` (catalog counts + routing).

**Not modelled:** `temperature`, `open_weights`, `modalities.output`, `experimental`.


**DeepSeek reasoning echo** (`reasoning-chat-completions-adapter.ts` + `reasoning-content-cache.ts`):

1. Buffer stream `REASONING_MESSAGE_CONTENT` and emit `STEP_FINISHED.delta` so TanStack’s in-run engine keeps `message.thinking` on tool-call assistants.
2. Cache by `toolCallId`; `convertMessage` restores `reasoning_content` when UI→model conversion dropped `thinking`.
3. No chat / compaction / UI pipeline hooks for this.

### 5.3 Layer 3 — Auto compact

**Files:** `agent/compaction/auto-compact.ts`, `apply-compaction-result.ts`

**Trigger:** `shouldTriggerAutoCompact` when window input tokens ≥ `tokenThreshold × compactAtPercent / 100`. After a successful compact, `usage.resetWindow()` zeroes window tokens, so the next `onConfig` would otherwise fall through to `estimateTokens(projected wire)` and fire again immediately. Compaction middleware skips auto-compact when the latest durable channel message is already a SUMMARY (`isLatestDurableMessageCompactionSummary`, ignoring trailing `<ctx kind=...>`). `autoCompact` also no-ops when `toSummarize` is only previous SUMMARY / synthetic ctx messages.

```
setStatus("compacting") via beginCompaction("auto")
emit compaction:auto-start
autoCompact(messages, config, agentId, manager)
  → findCutPointByBudget (token-budget keep window)
  → summarizeConversation with <to_compress> + <still_in_context> (+ optional <previous-summary>)
applyCompactionResult(channel, usage, result)
  → append `[CONVERSATION SUMMARY]` UIMessage onto the UI channel, reset window usage
  → return chronological post-append messages (for orphan tool-cache cleanup)
compaction middleware (same onConfig):
  → convertMessages(channel) → getModelVisibleMessages → { messages: wire }
emit compaction:auto-complete | compaction:auto-error
setStatus("running") via endCompaction
```

**Why re-project from the channel:** After append, TanStack `engineMessages` still match the **pre-compact** length. Returning those would drop the new SUMMARY for the immediate LLM call. Post-compact always rebuilds wire from the live channel. Engine `this.messages` is ephemeral and is never merged back.

`getModelVisibleMessages(chronological)` returns summary-first wire order:

```
[latestSummary, …kept turns before summary…, …messages after summary…]
```

The durable channel stays chronological. Projection is never written back.
The summarizer sees both the cut-away history and the kept tail (budget-aware) so Goal/Next stay aligned.
On later iterations (no compact), `onConfig` again converts the live channel and projects summary-first wire.

**Segmented summarization sizing:** `summarizeConversation` splits `toSummarize` with `splitMessagesByTokenBudget`, which sizes each message by its **serialized** length (`serializeConversation` caps tool results at 2000 chars and tool args at 200) rather than the raw wire. `estimateTokens` on the raw wire counts full tool output and overestimates the actual prompt several-fold, so measuring it forced needless multi-segment passes. The per-call input budget is `contextWindow − min(defaultMaxTokens, SUMMARY_OUTPUT_CAP) − overhead`, so a model declaring a huge `limit.output` (e.g. 384k) does not starve the budget.

**Compact observability:** auto-compact writes its decision-side inputs to the agent log at `debug` (category `compaction`) so segmentation can be diagnosed without reconstructing it from subagent logs. `autoCompact` logs the cut plan (`tokensBefore`, `triggerAt`, `keepRecentTokens`, `cutIndex`, `splitTurn`, slice message counts) plus `estimatedTokens` (raw wire) vs `serializedTokens` (truncated prompt) for `toSummarize`; `summarizeConversation` logs the resolved `inputBudget` / `stillTokens` / `compressBudget` alongside both measures and the resulting `segments` + per-segment `segmentTokens`.

### 5.4 Reactive compact (emergency)

**Files:** `run-stream-recovery.ts`, `stream-recovery/*`, `reactive-compact.ts`, `managed-agent.handleReactiveCompact`

When the API rejects the request as too long — classified by the provider's stable `code` (`context_overflow`, `context_length_exceeded`, `model_context_window_exceeded`, `prompt_too_long`, …) with prose only as the fallback, see `isPromptTooLongError` / `CONTEXT_OVERFLOW_CODES` in `agent/compaction/reactive-compact.ts`:

```
runStreamWithRecovery catches RUN_ERROR / thrown error
  → strategies: reactive-compact | capability-sanitize | transient-retry | max-tokens-continue
  → getMessages: () => managed.ui.getMessages()   // live channel, not a pre-run snapshot
  → reactive path: handleReactiveCompact (max 1 retry by default; skipped for subagents)
  → transient path: 429 / rate-limit / 502–504 / network — same messages + exponential backoff
    (honors Retry-After when present; works for main agent and subagents)
  → before restart-style retry (not max-tokens continue): `resetRetryUiState()` on the channel —
    attempt-scoped only (summary banner + phase unlock), NEVER the message history, which is the
    wire this retry re-projects from — plus `statusController.onRecoveryRetry()` for both profiles
  → beginCompaction("reactive")  // emits compaction:reactive-start only (not auto-start)
  → reactiveCompact: summarize + keep tail messages
  → applyReactiveCompactionResult → append SUMMARY on channel
  → endCompaction + emit compaction:reactive-complete | compaction:reactive-error
  → retry runner.run; next onConfig projects from live channel (shared MAX_RECOVERY_ATTEMPTS ≈ 3)
```

Unhandled `RUN_ERROR` chunks (anything other than a successful recovery strategy) are **thrown** — never yielded. `AgentChatController` / `AgentUIChannel.consumeRun` also wrap streams with `throwOnRunError`, so failures surface as `status: error` + `agent:stream-error` instead of a silent `Completed` with no assistant message. Handled errors are recorded on the agent and **not** rethrown from the chat pump (avoids unhandled rejection crashing the CLI).

**Empty stream guard:** Some OpenAI-compatible gateways return HTTP 200 HTML (e.g. SSO login) for `stream: true`; the SDK iterates zero chunks and does not throw. After each `chat()` consume, `AgentChatController` flags an error when messages show no model progress (no new/updated assistant text, tool calls, or tool results) via `shouldFlagEmptyModelStream` (`agent/run-helpers/empty-model-stream.ts`).

**Vision / multimodal:** Some text-only APIs (notably DeepSeek Chat Completions) reject multimodal parts with `unknown variant image_url, expected text`. `runStreamWithRecovery` uses capability-aware sanitization (`vision` / `audio` / `video` / `document`): unsupported parts are stripped from the **wire** copy (and all multimodal parts are stripped once on schema rejection); UI history keeps media for display.

#### Deliberately not used: server-side context management

The Anthropic adapter accepts a `modelOptions.context_management` we do not set
(`BetaContextManagementConfig`, whitelisted by `ai-anthropic` and sent with its beta;
`@tanstack/ai` 0.69's `withCompaction({ native })` is the SDK-level entry for the OpenAI
Responses equivalent, `POST /responses/compact`, which we do not reach either because we run
Chat Completions). It holds three edits, and two of them land on work this layer already does —
so the reason for declining each is recorded rather than left to be rediscovered:

| Edit | Overlaps | Why we do not send it |
|------|----------|------------------------|
| `clear_tool_uses_20250919` | Layer 1 `tool_compact` (`clear_at_least` / `clear_tool_inputs` / a preserved-tool list against our `toModelOutput` projection) | **Deferred, not excluded.** The wire/channel divergence it causes is already our accepted model for tool results (the channel keeps the full persisted result, the wire gets the projection). What keeps our own is that `tool_compact` runs on every provider while this is Anthropic-beta-only, and its place in the pipeline is load-bearing — `message-transform` must precede it and the capability strip must follow, because a strip before it sees JSON text and passes the image through. |
| `clear_thinking_20251015` | Layer 2 `reasoning_stripping` (**disabled** pending the DeepSeek `reasoning_content` echo-back requirement) | Doubly unreachable while Layer 2 stays off; revisit if that decision is ever reversed. |
| `compact_20260112` | Layer 3 `auto_compact` (server-side summarization, `instructions`, a trigger token threshold) | **Excluded by the channel being the source of truth.** Auto-compact *appends a SUMMARY message to the channel* — a visible transcript row that `getModelVisibleMessages` then projects summary-first, and `session:compact` / restore read back. A server-side compact returns an opaque compaction block that has no durable row, so the channel and the wire would disagree in a way nothing downstream can reconcile (context fill accounting, restore, the reactive-overflow path). It is also Anthropic-only, while auto-compact must run on OpenAI-compatible providers too. |

### 5.5 Manual `/compact`

**File:** `packages/app/src/commands/compact.ts`

Calls exported `autoCompact` + `applyCompactionResult` directly (same engine as auto-compact).

### 5.6 Configuration

```typescript
compaction: {
  tokenThreshold: 100_000,      // default from model contextWindow (capped)
  compactAtPercent: 80,         // trigger at 80% of threshold
  keepRecentTokens: undefined,  // token budget kept after auto-compact (derived from contextWindow / default 128k window)
}
```

Set via `ManagedAgentConfig.compaction` in `agent-factory.ts`.

---

## 6. Session flow

### 6.1 Storage

| Item      | Value                                                                                        |
| --------- | -------------------------------------------------------------------------------------------- |
| Directory | `.agents/sessions/`                                                                          |
| File      | `{sessionId}.session.jsonl` (append-only message log; one line per message)                  |
| Schema    | `SessionData` v7 (`agent/persistence/types.ts`; each log line = message + full state snapshot) |

Each log line is `{ t: "message", message: UIMessage | null, state }`: the message plus a full snapshot of the non-message state at that point (`usage`, `cost`, `contextTokens`, `todos`, `todoPlanBound`, `planMode`, `autoMode`, `modelStyle`, `model`, metadata). `load()` folds by `message.id` (later line wins, first-seen position; `state` = newest line). `save()` appends only new/changed messages; a state-only change re-emits the last message line. `message: null` is allowed only on the first line (initial/empty-session state). There is no separate snapshot file. A structural rewrite is written to a sibling temp file and renamed into place when the host fs implements the optional `rename?` primitive (node/server/WebContainer do; others fall back to an in-place `writeFile`), so a crash mid-rewrite leaves either the old log or the new one — never a truncated file.

**Message timestamps live on the message (v7).** A log line carries no time of its own: `message.updatedAt` (epoch ms, the store's stamp of the message's last content change) is written onto the message, so everything about one message sits in one JSON object next to TanStack's `message.createdAt`. `SessionStore` resolves these stamps before the no-op check and never re-stamps an unchanged message, so a re-emitted line stays byte-identical and a no-op save still writes nothing. Approvals are not stored as a table: they are derived from the folded messages' tool-call `approval` parts, and a decided approval keeps its decision time on the part itself (`approval.updatedAt`), stamped by the channel when the decision is made (`AgentUIChannel.addToolApprovalResponse`) and reused verbatim by the in-memory approval table. Because the time travels with the part, a later state-only re-emit or a whole-log rewrite cannot move it — the store records the earliest time it ever saw for each approval (`SessionStore.statusStamps`) and re-applies it.

**v6 logs still fold.** Until the 6 → 7 bump the line carried `messageUpdatedAt` and an `approvalAt` map; `foldLog` reads those when a message/part has no stamp of its own, so resumed pre-v7 sessions keep their write and decision times and gain the new shape on their next write. A log whose message has no stamp of its own is folded as-is (no timestamps injected), so an unchanged resume stays a byte-level no-op — no forced migration rewrite. A log stamped with a **newer** version (v8+) is still skipped, so a downgraded host degrades to "session not found".

**Legacy files are ignored (v6):** only `.session.jsonl` is recognized, so a v4/v5 `.session.json` (journal + materialized snapshot) is neither listed nor loaded — there is no migration. Sessions written before v6 do not appear in `/resume`; their files stay on disk untouched. For the same reason a log stamped with a **newer** `version` (e.g. a future v8) is not listed or folded: `isSupportedSessionVersion` gates it, so a host downgrade degrades to "session not found" instead of silently folding an unknown shape. A missing or malformed `version` (non-integer / non-positive / non-number) is rejected the same way.

**Single-process ownership:** a live agent claims its disk session in-process (`AgentManager.acquireSessionOwnership`, enforced by `restoreSession`), and an empty session carries a `reservedAt` window so a second process skips it during startup reuse. Writes from two processes bound to the *same* session id are **not** guarded (the last full state snapshot wins); running two hosts against one `.agents/` directory is unsupported.

**Binary media (v4):** On persist with `uiMessages`, `SessionService` clones → dehydrates Image/Audio/Video/Document parts to content-addressed **binary** files under `.agents/media/<hash>.<ext>`, writing `media://` refs + `metadata.mediaRef` into the log's message lines. Runtime messages stay hydrated (data URLs / raw base64). Restore hydrates for the UI, then re-dehydrates into `this.data` (so interrupt-snapshot repairs and media extraction stick). See `agent/media/`.

**Media IO failures never escape the host (v4):** dehydrate runs inside `persistSession`'s try/catch — a write failure emits `session:save-error` (target `session+uiMessages`) and still saves the rest of the state, and the fire-and-forget `void …persist…` call sites attach `.catch` (no unhandled rejection). On the read side, `hydrateUIMessages(messages, { onMissing })` reports every un-hydratable `media://` ref (`not-found` / `invalid-ref`, in content parts or tool results) instead of dropping it silently, and `restoreSession` folds the count into `session:restore.mediaMissing`.

**Interrupt snapshots:** TanStack `MESSAGES_SNAPSHOT` (tool-approval interrupts) is built from engine `this.messages` and would replace the chronological channel. `AgentUIChannel.processChunk` drops every snapshot. Incremental TEXT/TOOL chunks plus `addToolResult` / `addToolApprovalResponse` keep the channel current. Hydrate/dehydrate still repair stringified multimodal `ContentPart[]` in persisted JSON.

### 6.2 Write paths (unified persist)

| Trigger                                    | Function                                                                                   | What is saved                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **Run finalizes** (finish / abort / error) | `ManagedAgent.finalizeRun` → `SessionService.persistSession`                               | Session state: `usage`, `cost`, `contextTokens`, `todos`, `planMode`, `model`/`modelStyle`, `name`; auto-title if `"New Session"` |
| **User message (core)**                    | `AgentChatController` after `addUserMessage` (send / drained steer                         | follow-up) → `maybeSaveSessionUIMessages(..., "user-message")`                                     | Session state **plus** `uiMessages` when fingerprint changed |
| **Pump idle (core)**                       | `AgentChatController.persistMessages` → `maybeSaveSessionUIMessages(..., "pump-complete")` | Same; also on Esc/abort after cancelling incomplete tools                                          |
| **Manual flush**                           | `saveSessionUIMessages` (`/clear`, slash commands)                                         | Force full persist                                                                                 |

App hosts subscribe to Session `messages`/`state` for UI only — they do **not** checkpoint to disk. Approval decisions mutate the tool-call message part (`pending` on request, `approved`/`denied` on `y`/`n` or auto-approve), so they ride the same persist triggers as `uiMessages` (the message line is re-emitted). The decision timestamp is written onto that part by `AgentUIChannel.addToolApprovalResponse`, which returns it so `AgentChatController` hands the *same* value to the in-memory approval table (`approvals.upsert`) — one time value for the log and the table. On restore the table is derived from the messages (`normalizeSessionApprovals`); chat middleware rebuilds `resumeToolState.approvals` from it (pending omitted).

On restore, `PlanModeController.restoreState` rehydrates phase (and reloads markdown from `planFilePath` when missing). `/clear` / `ManagedAgent.reset` always `planMode.disable()`.

`SessionStore.save`: incremental append — content signature (state sans `updatedAt` + per-message fingerprints) is compared **before** `updatedAt` is bumped, so a re-save of unchanged data is a true no-op with zero IO. New/changed messages are appended as lines; a state-only change re-emits the last message line; a session that goes non-empty → empty, any non-append history change, or a save with no delta baseline (`prev === undefined`, e.g. an unprimed store) rewrites the file to converge on the session. Per-session write lock; `delete()` removes the log and clears the cached bookkeeping. The message timestamps (`message.updatedAt` / `part.approval.updatedAt`) are resolved before that comparison and are deliberately not part of it: an unchanged message keeps the stamp it was written with (from disk or from the last write), so a re-emitted line is byte-identical and a state-only re-emit cannot move an approval's decision time. The only mutation of the live objects is `session.updatedAt`, always after the no-op check.

**Run finalization** (`finalizeRun`):

| Reason     | Session persist | Memory extraction | `agent:stop`             |
| ---------- | --------------- | ----------------- | ------------------------ |
| `finished` | Yes             | Yes (async)       | `{ reason: "finished" }` |
| `aborted`  | Yes             | No                | `{ reason: "aborted" }`  |
| `error`    | Yes             | No                | `{ reason: "error" }`    |

Owned by the **chat pump** / detached runners — not per-`chat()` lifecycle middleware. The terminal
sequence itself (outcome kind → apply status → persist → `finalizeRun` → `turn:summary`) lives in
`RunFinalizer`, so the callers below cannot reorder it:

- `AgentChatController.pumpToolPhases` — `RunFinalizer.finalizeChat` when kind is `finished` / `aborted` / `error` (not `waiting`, so approval resume keeps turn context)
- `AgentChatController.stop` — `aborted` (generation bump skips the in-flight pump’s outcome path)
- `run-subagent` — `RunFinalizer.finalizeDetached` after the detached status outcome

Idempotent per turn via `resetTurnLifecycle` / `beginTurnFinalize` (stop + pump must not double-fire).

### 6.3 Resume

```
AgentManager.resumeSession(agentId, sessionId)
  → managed.restoreSession(sessionId)
    → SessionService.restoreFromStore
      → usage.reset(); hydrate uiMessages
      → restore usage, todos, approvals (missing/`[]` backfills from UIMessage approval parts)
    → host.approvals.restore(session.approvals)
    → host.applyPersistedModel({ model, modelStyle })  // adopted unless `providerMode: "remote"`
    → host.setReasoningEffort(session.reasoningEffort)
    → host.setDisplayName(session.name)
    → UI channel.setMessages(uiMessages) when channel present
    → clear steer/follow-up queues (no-op before initChat)
    → syncInteractionStateFromUIMessages (approval / ask_user)
    → host.refreshState()  // retained `state` re-emit (swapped sessionId + adopted model/name)

Host.create `{ resumeSessionId | continueSession }` and Session `session.resume`
share that restore path. Create then calls `initChat(initialMessages)` because
the chat controller does not exist yet.

AgentManager.continueLatestSession(agentId)
  → store.getLatest() → resumeSession
```

App bootstrap resume still passes `initialMessages` from Host.create into `ManagedAgent.initChat()`.

**Ownership dedup.** `AgentManager` keeps a process-local ownership registry
(`Map<sessionId, agentId>`) so a disk session is bound to at most **one** live agent
at a time. A live root claims the active id at bootstrap and after `/clear`; `restoreSession`
acquires the target before the switch, releases the session being left **only after the restore
succeeds**, and rolls the attempted target back when it fails. A refused target (already owned by
another live agent) is rejected with a clear error and leaves the current claim untouched (the
`/resume` picker marks such entries `bound (active)`). `destroyAgent` releases the current id, so
an owned session is never double-resumed and a switch never leaks the claim it left behind.

### 6.4 Channel ↔ wire projection

**Message flow (expected contract):**

```
uiMessages (source of truth on AgentUIChannel; chronological, including SUMMARY checkpoints)
  → onConfig (every iteration, including post-compact):
      convertMessages(channel) → getModelVisibleMessages → { messages: wire }
      + resumeToolState.approvals from SessionData.approvals (pending omitted)
  → never write projected wire arrays back as durable channel state
  → drop every engine MESSAGES_SNAPSHOT; TEXT/TOOL + addToolResult keep the channel live
```

Recovery / continuation always re-reads `managed.ui.getMessages()` (not a closed-over snapshot from run start), so a mid-run compact is visible to the next attempt.

- **Each `onConfig`** (turn-context middleware, after compaction): changed `<ctx kind=...>` sections are injected into the channel + wire (per-kind hash diff); wire is otherwise projected from the live channel.
- **User send** (`AgentChatController.sendMessage` / drained queues): `maybeSaveSessionUIMessages(messages, "user-message")`.
- **After run idle** (`AgentChatController` after `pumpToolPhases`, including approval wait / abort cleanup): `maybeSaveSessionUIMessages(messages, "pump-complete")`.
- **During runs / core**: `persistSession()` and `finalizeRun` write the model-state fields (model / modelStyle / reasoningEffort / usage / todos / plan / approvals / name); they never pass `uiMessages`.
- **Manual `/compact`**: appends summary checkpoint onto the channel; `persistSession()` + `maybeSaveSessionUIMessages(..., "force")`.
- **Manual `/clear`**: `saveSessionUIMessages()` force-flushes before rotating session.

### 6.5 Session events

| Event                | When                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------ |
| `session:restore`    | `ManagedAgent.restoreSession` succeeds (`sessionId`, `messageCount`, `tokenEstimate`, `mediaMissing` when >0). Also drives a retained `state` re-emit (swapped session id, adopted model / display name) |
| `session:save-error` | `SessionStore.save` fails (target: `session`, `uiMessages`, or `session+uiMessages`) |

---

## 7. Memory flow

### 7.1 Index build + per-turn injection (not frozen)

```
MemoryManager.initialize()     // .agents/memory/*.md + MEMORY.md
createMemoryExtension → ctx.registerContextProvider({ content: () => <memory_index> })
collectBeforeAgentStart (per user turn) → <ctx kind=codent-memory> section
```

The memory index (`<memory_index>`) is **not** frozen into the system prompt — it is
injected per-turn by the built-in Memory extension via `registerContextProvider`, so
freshly extracted memories surface without waiting for compaction. The index is captured
at snapshot time by re-evaluating the provider each user turn and hash-diffed like any
other `<ctx kind=...>` section (only changed index re-injects).

### 7.2 Per-turn prefetch (before each run)

**`MemoryService.prefetchRelevantMemories`** — called from `prepareForRun`:

```
Extract last user message text
findRelevantMemories(query, manager, textAdapter, alreadySurfaced)
  → LLM side-query or keyword fallback, max ~5 memories
formatRelevantMemories → memory.relevantContent
emit memory:prefetch { status: injected | empty | skip-* | error }
```

### 7.3 Per-iteration injection

**`turn-context-middleware`** (runs `onConfig`, after compaction):

```
onConfig → build dynamic sections (current_date, git_status, memory, plan mode, etc.)
         → per-kind hash diff vs last admitted (seeded from persisted messages on restore)
         → changed kinds injected as synthetic <ctx kind=...> user messages
           (after latest real user; persisted; UI-filtered; wire + channel in sync)
systemPrompts = frozen only (no dynamic tail)
```

Dynamic context lives in chronological user messages so OpenAI/DeepSeek prefix cache keeps
the frozen system + prior history stable across turns. Only changed sections are re-injected
mid-run; a periodic refresh re-admits everything once the conversation grows past
`DEFAULT_REFRESH_MESSAGE_THRESHOLD` since the last admit. `findCutPointByBudget`
skips synthetic `<ctx kind=...>` messages when walking the token-budget boundary.
After compaction / clear, `resetAdmittedTurnContext()` forces a fresh admission.
`TurnContextController` owns the frozen prompt, per-kind admission state, the instruction digest
snapshot and pending per-extension sections; the middleware reads them through `ManagedAgent`
delegates, and `ManagedAgent.reset()` funnels through the controller's single `resetTurnState()`.

**Subagent isolation:** subagents run the same middleware but only `SUBAGENT_ALLOWED_KINDS`
(`current_date`, `git_status`, `project_instructions`) pass; memory / todo / plan / mode /
extension / instruction kinds are filtered. `project_instructions` for a subagent resolves
through the parent agent's agentDoc (`run-agent.ts` wiring) — agent-factory loads agentDoc
only for root agents.

**Instruction file loading & `@` imports** (`agent/prompt/instruction-files.ts`): the single
source of truth for which instruction file wins and what it expands to, shared by
`agent-doc-loader.ts` (system prompt) and `turn-context/instruction-context.ts` (change
detection + re-injection). `CLAUDE.md` then `AGENTS.md`, first found wins and is the only one
loaded — composition between them is explicit, via `@path` imports that are inlined at load
time (max depth 5). A leading `/` in a reference is **project-root-relative**; references in
code regions, extensionless tokens (npm scopes), `../` escapes, and cycles are left literal
and reported instead of silently dropped (cycle detection is per chain, so a sibling
re-reference still expands). The change-detection digest hashes the **expanded** text plus
its notices, so editing an `@`-imported file re-injects the block; the byte budget (65536) is
counted in bytes and truncation is surfaced. Validate: `validate:instruction-imports`,
`validate:instruction-context`, `validate:instruction-budget`.

Section kinds are declared once in `agent/turn-context/turn-context-message.ts`
(`TURN_CONTEXT_KINDS`); the builder, the subagent allowlist, and `session-retrieval` all read from it.
A kind is a section's identity for per-kind hash admission, so a spelling drift would compile while
splitting one kind into two independently-admitted ones. (`SUBAGENT_ALLOWED_KINDS` stays a
`ReadonlySet<string>`: extension sections carry arbitrary ids as their kind.)

**Session-retrieval guidance** (`agent/turn-context/session-retrieval.ts`): the single source of
truth for how the model reaches past conversation, emitted as `<ctx kind=session_retrieval>`.
Gated on workspace history existing, evaluated **once per agent** so the section stays
byte-stable (a per-turn probe would flip on the first new session and re-inject); the body is
static with no counts for the same reason. Root agents only — the kind is deliberately absent
from `SUBAGENT_ALLOWED_KINDS`. There is no separate transcript archive: the whole conversation
(including compacted-away messages) stays in the session log, and recall goes through
`session_search` / `session_read`. Validate: `validate:session-retrieval`, `validate:session-search`.

**Provider cache wiring** (`prompt-cache-middleware`, `models/prompt-cache.ts`):

| Style                                 | Behavior                                                                                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `anthropic`                           | Split system at the boundary; `cache_control: ephemeral` on frozen system, last tool, and latest user message (≤3 of Anthropic's 4 breakpoints) |
| `openai` (and other Chat Completions) | `prompt_cache_key` = session id (or agent id), merged into `modelOptions`                                                                       |
| all                                   | Tools sorted by name before each request (`toolsToArray` + middleware)                                                                          |

### 7.4 Commit surfaced memories

**`lifecycle-middleware.onFirstModelOutput`** → `memory.commitSurfacedMemories()`:

- Adds prefetched filenames to `alreadySurfaced` so they are not re-injected next turn.

### 7.5 Post-run extraction & consolidation

**`MemoryService.runExtraction`** — async, fire-and-forget from `finalizeRun` when `reason === "finished"`:

```
Guard: manager exists, ≥8 messages, not already in progress
extractMemories → structured one-shot query (side-query port) → write .agents/memory/*.md files
  → emit memory:extract { status: start | complete | empty | queued | skip-short | error }
If count >= consolidateThreshold (default 25):
  consolidateMemories → structured one-shot query (merge/delete decisions)
  → emit memory:consolidate
flushIndex → update memory.content for next session
```

**Only runs after successful finish** — not on abort or error.

---

## 8. Event system (cross-cutting)

### 8.1 Emission

Every event — telemetry, domain state, streaming output, extension UI — is emitted on the agent's scoped `AgentEventBus` (the **single** event mechanism):

```typescript
managed.emitEvent(type, data);            // scoped bus emit (observer) + envelope metadata
emitAgentTelemetry(managed, type, data);  // envelope-construction helper (same bus)
bus.emit("session:summary", payload);     // domain objects hold the scoped bus and emit
```

Observer `emit` is synchronous fire-and-forget with per-listener error containment; interceptor `intercept` (`{ type, payload, defaultReturn }`) is async, shared-mutable, can short-circuit, and walks the scope chain front-to-back in each node ordered by declared dispatch order (`ExtensionAPI.order`; ties keep load sequence). The built-in log extension is the single `"*"` observer on the root scope, and internal events are withheld from wildcard delivery (so wildcard ≡ `observeAny`).

### 8.2 Observation layers (L1–L4)

| Layer | Event source (unified bus)                                                                      | Host surface                                                                       |
| ----- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| L1    | `ManagedAgent.emitStateChange` → `agent:state` (retained) + `session:mode` + `session:interaction`; `setIterationProgress` → `agent:iteration` (retained) | Session `state` / `mode` / `interaction` / `iteration` channels                                                  |
| L2    | Telemetry envelope helpers → scoped bus (root `"*"` observer: the log extension)                | Session `lifecycle` channel (declarative projection)                               |
| L3    | Domain objects emit declared observer events (todos/usage/plan/summary/messages/queues/tool)     | Session `messages`/`tool`/`summary`/`todos`/`usage`/`plan`/`queues`/`extensions`/`mcp` |
| L4    | Extension interception (`tool:before:*` / `tool:after:*` / `tool:error:*` / `before_agent_start`) + `extension:ui` | Session `extension-ui` channel; host `ctx.ui` facade                        |

**Host observation API:** `AgentSession` only (`createLocalAgentSession` / HTTP client) — `getSnapshot` / `dispatch` / `subscribe(channels)`. There are **no** public domain `.on(...)` APIs: `AgentChatController.on("change")` and `ManagedAgent.on("change"|"ui")` were removed with the domain emitters, and the `AgentTelemetryBus` facade was deleted — `AgentEventBus` is the single mechanism.

**Projection:** `local-agent-session` keeps one subscription per agent scope and routes events to channels via declared metadata (`AGENT_EVENT_META`); retained events (`state` / `mode` / `messages` / `usage` / `todos` / `plan` / `extensions` / `mcp` / `queues` / `interaction` / `iteration`) replay their current value to each new subscriber. The former structured `log` session channel was removed — log observability is provided exclusively by the persisted JSONL file sink (`.agents/logs/{sessionId}/agent.log`).

**Messages channel:** Session snapshots always carry a full `UIMessage[]`; the `messages` channel delivers the same full array (JSON-patch / delta delivery is deferred). Wire projection for the model loop is cached by channel revision + last-message fingerprint (`WireProjectionCache`).

Tool process chunks (`run_command` stdout/stderr) are scoped by required `agentId`; Session `tool` channel receives them (`chunk` / `clear`).
Task / compact summary text uses `ManagedAgent.summaryStreams` (`SummaryStreamHub`: `reset` / `append` / `end`) on Session `summary` — not the tool-output registry. Compact stream ids are stable (`compactSummaryStreamId(agentId)` → key `compact:${agentId}`).

### 8.3 Event types (summary)

| Category          | Events                                                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Session bootstrap | `session:doc`, `session:skill`, `session:mcp`, `session:memory`, `session:start`                                                       |
| Session I/O       | `session:restore`, `session:save-error`                                                                                                |
| Run lifecycle     | `prompt:submit`, `agent:thinking`, `agent:abort`, `agent:stream-error`, `agent:extension-error`, `agent:stop`                                                   |
| LLM iteration     | `llm:request`, `llm:response` — **per TanStack iteration**, not per user turn; log-only (no channel)                                     |
| Iteration progress | `agent:iteration` → retained `iteration` channel + `AgentSessionSnapshot.iteration` (`{ current, max }`, 1-based per model turn). Projection-only: deliberately not written to the log |
| Turn rollup       | `turn:summary` — end of `AgentChatController.pumpToolPhases` (outcome, tool phases / tool calls, tokens, cost, duration)                 |
| Tools             | `agent:tool-start`, `agent:tool-approval-request`, `agent:tool-approval-resolved`, `agent:tool-end`, `agent:tool-error`                |
| Memory            | `memory:prefetch`, `memory:extract`, `memory:consolidate`                                                                              |
| Compaction        | `compaction:auto-*`, `compaction:reactive-*` (start kind matches path)                                                                 |
| Subagent          | `subagent:created`, `subagent:started`, `subagent:completed` (`summary` + `iterations`/`maxIterations`/`durationMs`/`usage`), `subagent:error`, `subagent:destroyed`, `subagent:phase`, `subagent:progress-summary-error` |

### 8.4 The log extension

**Files:** `agent/log/extension.ts` (the built-in extension), `agent/log/event-log-bridge.ts` (policy), `agent/log/event-log-rules.ts` (the rule table), `agent/log/jsonl-file-sink.ts` (the sink).

Logging has **two halves and two owners**, and the split is the point of the feature:

| Half | Owner | Does |
| ---- | ----- | ---- |
| Emission **seam** | `agent/agent-log/agent-log.ts` (core, not an extension) | level filtering, `run` stamping, envelope construction (`id`/`timestamp`/error shaping); hands the assembled entry to the attached sink |
| **Policy** | the built-in log extension | the event→entry rule table, message formatting, payload summarizing, the JSONL sink + rotation, the session-boundary divider, disk binding |

The seam is deliberately non-removable: ~76 core call sites plus `ctx.logger` write through it, and they must keep working during workspace construction, before extensions load, and while an extension is failing to activate. It is a **direct injection** (`log.attachSink({ handleEntry, flush, flushSync, dir? })`), not a bus event — an internal event could not be delivered to its only consumer anyway (internal events are withheld from wildcard delivery and from `observeAny`), and injection makes self-observation impossible by construction. `log.attachFileSink(options)` stays as a thin delegate over `createJsonlFileSink` so the log validators and `scripts/helpers/log-capture.mjs` drive the seam directly.

**Wiring:** `AgentManager` builds the instance in its constructor (`getLogExtension()`) and `start()`s it — that is the single `"*"` observer in core. Root sinks bind through `ManagedAgent.bindSessionLogSink()` → `getLogExtension().attachSink(...)`; subagent sinks bind in `spawnSubagent` → `logExtension.attachSink(subagentLog, { dir: parentDir, filename: `${id}.log` })`. Subagents have **no** extension runner (`agent-factory.ts` creates one only for roots) but do write logs, which is why the sink is handed to each `AgentLog` by core instead of being owned by a per-agent extension instance.

- `DEFAULT_EVENT_LOG_RULES` controls level/category/message per event, with dedicated multi-entry handlers for MCP / memory / compaction
- Emit sites should **not** duplicate `log.info` / `log.approval` for lifecycle events covered by the table
- **Entries emitted before a sink is bound are retained**, bounded by `MAX_PENDING_LOG_ENTRIES` (200), and drained into the first sink that attaches — so bootstrap diagnostics (including every extension activation failure) reach disk. Beyond the cap the oldest are dropped: this is a window, not a history buffer.

**Persistence-only log:** `AgentLog` writes every accepted entry straight to the JSONL file sink (`.agents/logs/{sessionId}/agent.log`, size-based rotation at 5 MiB / 5 files, 250 ms flush interval) — no in-memory ring, query API, or UI channel. Each entry is validated against `logEntrySchema` at the write boundary (a non-conforming entry is rejected with a `console.error` rather than written, so the file never contains an entry a reader would reject). Entries logged while an agent run is in flight carry a short `run` id (`prepareManagedAgentForRun` sets it, finalize clears it).

**Payload summarization:** `summarizePayload` turns large fields (`tool_input` / `tool_output` / unknown objects) into `{field}Bytes` + `{field}Preview` (≤200 chars); scalar observability fields (ids/names/counts/bytes/tokens/ms) pass through; the redundant `eventType` is dropped. A `cancelled` payload is written without a synthesized `Error` — a cancelled subagent's `error` text is its partial narration, not a fault.

**Opt-in hook echoes:** middleware hook-call echoes (`middleware:{name}:{hook}`) are off by default and only written when `MY_AGENT_LOG_HOOKS` is truthy.

**Timeline metrics:** `llm:request`/`llm:response` carry `model`/`iteration`; `llm:response` adds `reasoningTokens`, `costUsd`, `roundElapsedMs`, `firstTokenMs` (from `UsageTracker` per-call tracking). Status transitions are logged from `ManagedAgent.setStatus` (`from`/`to` + controller-supplied `trigger`); approval resolutions are emitted as `agent:tool-approval-resolved` by `ToolApprovalTable.upsert` (pending → approved/denied only).

### 8.4a Teardown and the exit path

An extension that buffers state needs two exits, and they are different mechanisms:

| Registration | When it runs | Awaited? |
| ------------ | ------------ | -------- |
| `ctx.registerFlush(fn)` | `destroyExtension` / `destroyAll` / disable — **before** `deactivate()` | yes, per extension |
| `ctx.registerExitFlush(fn)` | `process.on("exit")` and the fatal handlers | no (best-effort, contained) |

Order per extension: `session:shutdown` (interceptors) → `flush` → `deactivate` → unregister registrations + clear UI slots. A throwing flush is reported as `agent:extension-error` with phase `flush` and does not skip the remaining phases. The runner releases both registrations in `unregisterInstanceArtifacts`, so a destroyed extension stops running on `exit`.

`AgentManager.destroyAgent` keeps its synchronous signature: teardown is tracked as a promise and the log flush is chained onto its continuation, with `settleTeardowns()` for an ordered shutdown (which `LocalAgentSessionHost.destroy()` awaits). The log extension registers a sync exit flush over every sink it attached, so a hard exit with a live session still lands the pending batch.

### 8.5 Extension interception (L4)

Extension interception (`tool:before:*` / `tool:after:*` / `tool:error:*` / `before_agent_start`) is **interceptor mode on the same `AgentEventBus`** (invoked from middleware and prepare-for-run) — there is no separate interceptor bus. There is **no** `.agent-hooks` / hook-script path — customize via `.agents/extension` modules or programmatic `config.extensions`.

**Message transformers (`ctx.registerMessageTransformer`) are deliberately NOT one of those interceptor patterns.** They are a named registration method with a different shape: interceptor mode is a shared mutable payload with cancel short-circuitness, whereas a message transformer receives the model-facing message array and returns a replacement. The interceptor pattern lists above and below do not gain a message-transform entry, and `AgentEventBus` gains no third dispatch mode.

The non-bus extension surfaces are therefore exactly: `registerTool`, `registerCommand`, `registerContextProvider`, `registerMessageTransformer`, and `ui.render` / `ui.notify` / `ui.getContext` — each a registration or projection API, none a dispatch mode. **Observation (`ctx.events.observe` / `observeAny` / `retained`) is NOT on that list**: it is bus-backed, delivered by the observer dispatch mode the bus already had, which is why the observation section above documents it under the bus rather than under the non-bus surfaces.

**Dispatch order (`ExtensionAPI.order`).** Four extension surfaces are observable as a **sequence**, and each was ordered by the same uncontrolled variable — the order extensions load. `order?: number` makes the sequence declarable: **lower runs first**, absent means `0`.

| Read | Surfaces | What the order decides |
| ---- | -------- | ---------------------- |
| **Chain** (front-to-back) | interceptor dispatch, message-transformer chaining, turn-context section position | which extension runs **earlier** — a cancelling interceptor suppresses everything after it |
| **Resolution** (back-to-front) | same-named extension tools | which extension **wins** — the highest order, because a later-running extension supersedes |

Both readings come from one sort on `(order, load sequence)` (`agent/extension/dispatch-order.ts`): chain surfaces read it forward, the resolution surface reads the last entry. Ties keep **load sequence**, recorded by `ExtensionRunner` when the extension loads — so an extension that declares nothing keeps the exact position it would have had, and only declared extensions move. It is a **dispatch** rule (which position an extension runs in) and is deliberately unrelated to the loader's **resolution** rule for a duplicated extension id (`extension/paths.ts`, later directory wins).

It governs **nothing else**: observer delivery stays registration-ordered, `ui.render` slots are combined by key, commands are looked up by name, and the flush phases are phase-scoped. The effective order is reported on `ExtensionInfo` (`order`, plus `declaredOrder` to tell "declared 0" from "defaulted"), and `getExtensionInfos()` returns entries in dispatch order, so the Extensions panel (`Ctrl+Y`) shows where each extension actually runs. The bus's interceptor array is re-sorted **on mutation**, not inside `intercept` (a per-tool-call hot path); the ranked tool stack lives in `ExtensionRegistryService`, whose live entry is re-derived from the ranks so a middle-owner disable promotes the right survivor.

Validate: `pnpm --filter @codent/core run validate:extension-order`.

| Property | Behaviour |
| -------- | --------- |
| Registration | `ctx.registerMessageTransformer(fn)` returns a disposer. At most one per extension (re-registering replaces; a stale disposer is inert). Cleared on disable / destroy. |
| Position | The dedicated `message-transform` middleware, running **immediately after `compaction`** (same `context-transform` phase). |
| Invoked | Once per model call — the initial `init` call and every later iteration — so restart-style retries (429 / capability strip / reactive compact / max_tokens) are covered too. |
| Sees | The channel-projected wire produced by `compaction`. Synthetic messages written to **both** channel and wire (turn context, background notifications) are present. Edits from middleware that rewrite only `config.messages` **before** the projection are not. |
| Returns | A replacement `ModelMessage[]`, or `void` / a non-array to leave the previous value. The output is **wire-only**: never written back to the UI channel, the session store, or any durable state. |
| Ownership | The system hands the transformer a fresh outer array **and** fresh message objects, so in-place edits cannot reach the array retained by `WireProjectionCache` (which the engine also keeps for the rest of the run). Content-part objects inside a message are **not** exclusively owned — return a new message to change a part. |
| Zero overhead | With no transformer registered the middleware returns no config change: the pipeline and the projection cache behave byte-for-byte as if it did not exist. |
| Failure | A throwing transformer logs a warning and emits `agent:extension-error` with `phase: "message-transform"`; the last valid message set is kept and the run continues. |
| Scope | Subagents do **not** inherit the parent's transformers (`if (!parentId)` at `agent-factory.ts:176`). In a remote-session host the transformer runs **server-side**, so an external endpoint's credentials belong in the server environment. Disc-loading hosts only — browser-only hosts (WebContainer playground) cannot load extensions from disk. |
| Capabilities | `ctx.capabilities` carries the provider's raw declared set, or `null` when **unknown** — `null` and an empty set are different on purpose (`null` = nothing declared, so every `modelHas*` boolean is `true`; `∅` = declared, none apply, so every boolean is `false`). `ctx.unsupportedPartTypes` is the derived multimodal strip set. Every capability also gets a flat named boolean (`modelHasVision`, `modelHasAudio`, … one per entry of `MODEL_CAPABILITIES`), all from the same probe that gates pre-send stripping — never re-derived from host config. The distinction survives three hops (`deriveCapabilities`, `mergeModelInfo`, `setCapabilities`), so a resolved plain-text model reports `∅` and has its modalities stripped rather than sent to an endpoint that rejects them. The capability list lives once, in `models/types.ts`: `MODEL_CAPABILITIES` is the runtime array and `ModelCapability` is derived from it, while `MODEL_CAPABILITY_FLAGS` (exhaustively keyed by that union) maps each capability to its boolean name — adding a capability therefore fails compilation until both the flag name and the table are updated, instead of silently missing a flag. Every member must be evidenceable from metadata (`streaming` was granted to all entries with no field behind it, and `computer_use` had no source — both removed). |

Same-phase ordering note: `compaction` and `message-transform` declare the same phase, so the phase sort cannot order them — their relative order comes from the array position in `buildAgentRunner`, which is why `validate:middleware-order` asserts the adjacency against the pipeline the runner **actually assembles** rather than a copied factory list.

The ExtensionEventBus also carries **session lifecycle events** (distinct from the L2 `session:start` telemetry): `session:start` (emitted at the end of `emitSessionBootstrapEvents`, payload `{ cwd, sessionId }`) and `session:shutdown` (emitted in `AgentManager.destroyAgent()` before `extensionRunner.destroyAll()`, so extensions can release resources first).

**Observation (`ctx.events.observe` / `observeAny` / `retained`).** Interception lets an extension *change* an operation; observation lets it *read* one. The three accessors reuse the bus's existing **observer** dispatch mode (synchronous, registration-ordered, fire-and-forget, throw-isolated) — they are not a third dispatch mode, and `ctx.events.on` (the interceptor spelling) is unchanged. They register on the extension's **scoped** bus, so a root-scope extension receives subagent events up-flow with no `agentId`/`parentId` comparison.

The observable set is declared once, in `agent/extension/types.ts`, as `EXTENSION_EVENT_VISIBILITY` — an exhaustive table over `AgentEventType` (`as const satisfies Record<AgentEventType, "observable" | "internal">`). Adding an event to the registry therefore fails compilation until it is classified, so a new event can neither become observable by accident nor be silently absent from `observeAny`. `internal` rows must state their reason; today they are `tool:chunk` / `tool:clear` (token-by-token streaming already has a dedicated UI path) and `extension:ui` (observing it would couple extensions through each other's publishes).

**`observeAny` expands the declared set; it does not use the bus's `"*"`.** Two reasons, and the second is a hard contract: `"*"` would ship the internal events above to extensions, and `agent-event-bus` requires the log extension to remain the **only** wildcard consumer in core. `observe` replays a retained event's current value once on subscribe (opt out with `{ replay: false }`); `observeAny` never replays, so a broad subscriber is not hit with a burst of snapshots; `retained(type)` reads on demand. Every disposer is recorded in `ExtensionRegistrations.unsubObservers` and released on disable/destroy.

**Failure containment:** a synchronous throw is contained by the observer dispatch mode itself; a returned **rejected promise** is caught by the extension observer facade and reported as `agent:extension-error` with `phase: "event-observer"` — the bus's observer path is synchronous, so without that catch a rejecting handler would become an unhandled rejection and, under `installAgentLogProcessGuards`, a fatal one.

**Payloads are shared references and read-only by contract.** An observed payload is the *same object* the session channel projection and the log extension receive, so an extension that mutates it mutates live state. The contract is documented rather than enforced by freezing — deep-freezing would add per-emit work on the hot path and change behaviour for existing in-core consumers.

Validate: `pnpm --filter @codent/core run validate:extension-event-observation`.

**Per-turn prompt hooks:** On each root user prompt (not tool continuations / subagents), `prepareForRun` calls `ExtensionRunner.collectBeforeAgentStart`, which:

1. Runs `before_agent_start` interceptors (observable event only — a fresh event per handler).
2. Runs each enabled extension's `registerContextProvider({ content })` (only non-empty content emits).
3. Emits each extension's turn-context text as its **own** `<ctx kind=<extension id>>` section in the dynamic turn snapshot (enable and disable share the same tag — an enabled extension carries its injected `content`, a disabled one carries only its `disabledContent` notice). Per-extension kinds keep the per-kind hash admission granular (only the changed extension re-injects, which is prompt-cache friendly).

There is no system-prompt append channel (`extension_system_append` was removed): extensions inject exclusively through `registerContextProvider`, so the frozen system prompt stays byte-stable and cacheable.

## Repo demos live in `examples/extensions/` and are **opt-in** via `AGENT_EXTENSION_DIRS`, `ManagedAgentConfig.extensionDirs`, or CLI `--extension-dirs` (not in core defaults). Extension `registerCommand()` is mirrored onto `ManagedAgent` and synced into app slash commands after bootstrap (`syncExtensionCommands`). Built-in names (`/help`, …) win over extension conflicts. `registerTool()` converts definitions via `defineServerTool` before they enter the TanStack tool set. Tool schemas may use **`ctx.z`** (host Zod) or any Standard-Schema / JSON-Schema-compliant schema (the `inputSchema`/`outputSchema` type is the widened `SchemaInput`). `tool:after:*` interceptors can set `event.payload.modifiedResult` to replace the model-facing result. `ExtensionUI.render(surface, key, payload)` publishes a `render` notification into a named host surface (currently `footer`, rendered as the bottom-most footer region) — the payload is either raw text (ANSI sequences and line breaks preserved) or a generic layout tree built from the closed primitive set `text` / `row` / `column` / `box`, and the host renders it with a single generic renderer. There are deliberately **no predefined extension components**: no status API, no widget vocabulary, no confirm dialog, no color helper. Slots are keyed (extensions never overwrite one another), retained so late subscribers reconcile, cleared when the owning extension is disabled/destroyed, and coalesced (~100ms) with identical-payload dedupe. `ctx.ui.getContext()` returns a live snapshot (model / status / usage / workspace / session name / mode) that is also pushed to subscribers as a `context` notification when relevant state changes; `ctx.ui.notify(message, level)` stays the host-native notification path. Each `ExtensionContext` also exposes `ctx.coreEnv` (the runtime CoreEnv: `rootPath`, `fs`, `runCommand`, `exec`, `fetch`, `path`, `getEnv`) so extensions do real I/O without importing host-specific APIs — `agent-factory.ts` wires it from the global `getEnv()`. `ExtensionRunner.getExtensionInfos()` + `setEnabled(id, enabled)` power the app **Extensions panel** (`Ctrl+Y`, list / toggle enable-disable); disabling calls `deactivate()` and unregisters the extension's tools, commands, interceptors, and turn-context providers (wired via `onUnregisterTool`/`onUnregisterCommand` → `ManagedAgent.unregisterExtensionTool/Command`). Tool unregistration **restores what the registration shadowed** rather than deleting the name: `ExtensionRegistryService` keeps a **stack per tool name** (bottom = what was there before the first extension, top = live), where each entry stores its own tool so nothing has to remember what it covered. Disabling an extension removes that owner's entries and re-reads the top, which is the same operation whether the owner was live or buried — so a disable that hands the name back to an earlier extension and one that removes it outright are one code path. That single operation is what makes the runner unable to get the case wrong: it reports one `onUnregisterTool(name, ownerId)` per registration and keeps **no ownership map of its own** (a per-runner `name → owner` map cannot answer "is this name still mine?" — two agents loading the same extension share an id — so asking it either deleted a live owner's tool or left the built-in shadowed). That is why disabling an extension that shadowed `read_file` gives the built-in back instead of removing it until restart. The model-output handler and the **presentation descriptor** are stacked by the same owner (`ToModelOutputRegistry`, `presentation/registry.ts`), and `defineServerTool` / `defineClientTool` pass the registering extension as `ownerId` so both are dropped with it and the restored tool's own shaping and display flags take over again — releasing a buried owner leaves the surviving owner's descriptor alone (clearing the whole entry would leave a live tool described by the fallback table, or by nothing, which drops its historical rows out of the compact view). The tool stack itself is per agent, and the two process-global registries are keyed by an owner id that `ManagedAgent` **namespaces by agent** (`agentId:extensionId`) — an extension loaded onto two agents offers the same id twice, and without that scope a disable on one agent released the other's handler and descriptor as well. Scope is applied at the `ManagedAgent` boundary rather than in `defineServerTool` because that is the only place that knows which agent a registration belongs to (the tool factories are shared and never told). Validate: `pnpm --filter @codent/core run validate:extension-tool-restore`.

## 9. End-to-end run diagram

```
User sends message (AgentChatController.sendMessage)
  │
  ▼
agentManager.runAgentStream(agentId, { messages: UIMessage[], abortSignal })
  │
  ▼
executeManagedAgentRun
  ├─ ensureAgentRunner (lazy build AgentRunner + middleware)
  ├─ prepareForRun
  │    ├─ (user-turn only) memory.prefetchRelevantMemories
  │    └─ (user-turn only) emit prompt:submit
  └─ runStreamWithReactiveCompactRetry
       └─ runner.run → TanStack chat()
            │
            ├─ [each iteration] compaction.onConfig → autoCompact if threshold exceeded
            │    (DeepSeek reasoning echo is adapter-only; no strip here)
            ├─ tool-compact.onConfig → toModelOutput + recent-window placeholders
            ├─ turn-context.onConfig → system prompt dynamic segment (turn snapshot)
            ├─ extensions.onBeforeToolCall → agent:tool-start (+ optional ExtensionEventBus)
            ├─ [tool execute or approval pause]
            ├─ extensions.onAfterToolCall → agent:tool-end/error (+ optional ExtensionEventBus)
            ├─ early-tool-result-ui.onAfterToolCall → AgentUIChannel.addToolResult (per-tool UI)
            └─ lifecycle.onFinish → llm:response (usage snapshot)
                 (turn finalizeRun is NOT here — see pump / detached below)
  │
  ▼
[core] AgentChatController.pumpToolPhases end (finished/aborted/error) → finalizeRun
[core] AgentChatController.stop → finalizeRun(aborted)
[core] run-subagent after detached outcome → finalizeRun
       ├─ session.persistSession (model state)
       ├─ memory.runExtraction (async, finished only)
       └─ emit agent:stop
  │
  ▼
[core] user send / drained queues → maybeSaveSessionUIMessages(..., "user-message")
[core] pump idle / abort cleanup → maybeSaveSessionUIMessages(..., "pump-complete")
[core] finalizeRun / /compact → persistSession() (model fields only)
[app] /clear etc. → saveSessionUIMessages() (force)
```

---

## 10. Plan domain vs tool factories

| Concern                                                                               | Location      | Examples                                                                          |
| ------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------- |
| Plan **domain** (phase machine, prompts, safe-command, verification gate, middleware) | `agent/plan/` | `PlanModeController`, `plan-mode-middleware`, `plan-prompts`, `plan-verification` |
| Plan **tool factories** (model-callable tools)                                        | `agent/plan/` | `create-plan-tool` (`create_plan` / `update_plan` / `complete_plan`)              |

Domain-owned tools live next to their domain (same pattern as `subagent/begin-summary-tool` and `subagent/task-tool`). Universal workspace tools stay under `agent/tools/`.

**Verification contract:** `create_plan` / `update_plan` require a non-empty `verification` checklist (content quality is prompt guidance, not a hardcoded command blacklist). Plan markdown gets a `**Verification:**` section. In retro, `complete_plan` requires `verificationResults: { item, passed, evidence }[]` covering every parsed checklist item (all `passed: true`). Legacy plans with no Verification section accept a single passing smoke/N/A result. User `/mode done` bypasses the agent gate. Helpers: `parseVerificationItemsFrom*`, `gateCompletePlanVerification`. Validate: `pnpm --filter @codent/core run validate:plan-verification`.

---

## 11. Key file index

| Area                | Primary files                                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry / connect     | `index.ts`, `agent-session/*`                                                                                                                |
| Manager             | `managers/agent-manager.ts`, `managers/agent-factory.ts`                                                                                     |
| Agent runtime       | `managers/managed-agent.ts`, `managers/run-agent.ts`, `managers/agent-run-outcome.ts`                                                        |
| Stream recovery     | `managers/run-stream-recovery.ts`, `managers/stream-recovery/*`                                                                              |
| Runner              | `agent/runner/agent-runner.ts`                                                                                                               |
| Middleware          | `managers/middleware/*.ts` (+ `agent/plan/plan-mode-middleware.ts`)                                                                          |
| Stream helpers      | `agent/stream/*`                                                                                                                             |
| UI channel          | `agent/ui/ui-channel.ts`                                                                                                                        |
| Shared types        | `runtime-types/*`                                                                                                                            |
| Telemetry           | `agent/agent-event-bus/*` (the unified bus), `managers/telemetry/emit-agent-telemetry.ts`, `agent/log/*` (the log extension)                                        |
| Persistence         | `managers/services/session-service.ts`, `agent/persistence/session-store.ts`                                                                          |
| Services (extracted) | `managers/services/` — session / memory / compaction / extension-registry / usage-history; `managers/run-coordinator.ts` (run lifecycle)               |
| Usage               | `agent/usage/usage-store.ts` (pure IO), `managers/services/usage-history-service.ts` (global history)                                                   |
| Cross-cutting utils | `utils/emitter.ts`, `utils/generate-id.ts`                                                                                                             |
| Domain helpers      | `agent/run-helpers/*` (tool-phase, empty-stream, pending queue — stay with chat/run)                                                                   |
| Memory              | `managers/services/memory-service.ts`, `agent/memory/*.ts`                                                                                             |
| Compaction          | `managers/services/compaction-service.ts`, `agent/compaction/*.ts`                                                                                     |
| Plan                | `agent/plan/*` (domain + plan tool factories)                                                                                                         |
| Tools               | `agent/tools/*.ts` (universal), `agent/tools/runtime/define-tool.ts`; domain tools under `plan/` / `skills/` / `subagent/` / `todo/`                     |
| Subagent            | `agent/subagent/run-subagent.ts`, `agent/subagent/task-tool.ts`                                                                              |
| Models              | `models/model-config.ts`, `models/adapter-factory.ts`, `models/prompt-cache.ts`                                                              |
| CoreEnv             | `env/index.ts` (+ `@codent/node` / `@codent/server`)                                                                                           |

---

## 12. Validation scripts

```bash
pnpm --filter @codent/core run validate:emit-agent-event
pnpm --filter @codent/core run validate:event-log-bridge
pnpm --filter @codent/core run validate:extensions-middleware
pnpm --filter @codent/core run validate:agent-ui-channel
pnpm --filter @codent/core run validate:suppress-replayed-tool-chunks
pnpm --filter @codent/core run validate:early-tool-result-ui
pnpm --filter @codent/core run validate:extension-prompt-hooks
pnpm --filter @codent/core run validate:extension-pi-like
pnpm --filter @codent/core run validate:streaming-scope
pnpm --filter @codent/core run validate:summary-stream
pnpm --filter @codent/core run validate:local-agent-session
pnpm --filter @codent/core run validate:run-agent-skeleton
pnpm --filter @codent/core run validate:tanstack-tools
pnpm --filter @codent/core run validate:compaction-messages
pnpm --filter @codent/core run validate:message-chain-projection
pnpm --filter @codent/core run validate:suppress-messages-snapshot
pnpm --filter @codent/core run validate:reactive-compact
pnpm --filter @codent/core run validate:run-stream-recovery
pnpm --filter @codent/core run validate:agent-run-finalization
pnpm --filter @codent/core run validate:layer-boundaries
pnpm --filter @codent/core run validate:accessor-convention
pnpm --filter @codent/core run validate:runner-wiring
pnpm --filter @codent/core run validate:agent-status
pnpm --filter @codent/core run validate:prompt-cache
pnpm --filter @codent/core run validate:subagent-run-stats
pnpm --filter @codent/core run validate:model-config
pnpm --filter @codent/core run validate:tool-phase-utils
pnpm --filter @codent/core run validate:session-sync-tracker
pnpm --filter @codent/core run validate:tool-approval-resume
pnpm --filter @codent/core run validate:restore-session-chat-state
```

Full package validation: `pnpm build:core` + `pnpm typecheck` (core tools typecheck clean as of recent fixes).
