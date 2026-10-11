## Context

Core currently has no instance boundary. `CoreEnv` and `ModelProvider` are process-global module
singletons (`env.ts` `_env`; `provider/model-provider.ts` `_provider`), `agentManager` is a
module-level `new AgentManager()`, and ~56 core modules read `getEnv()` / `getModelProvider()` at run
time. The stores are built on the same global: `SessionStore` exposes `get fs() { return getEnv().fs }`,
and `MediaStore` is a module singleton that reads `getEnv()` inside `save`/`load`. Every host
bootstraps by registering the globals, so a process can host only one workspace + one LLM connection
world.

Two seams already exist but are not wired to an instance: `ToolRunContext` carries `coreEnv: CoreEnv`
(`agent/runner/run-context.ts`) and is forwarded to every tool via `chat({ context })` - but
`createToolRunContext` fills it from `getEnv()`, and most tools call `getEnv()` directly instead of
reading the context. `SessionStore` and `ManagedAgent` already support multiple instances; the blocker
is the env source.

Constraints: existing hosts, the app's `AgentSession` / `AgentSessionHost` contract, and all
`validate:*` scripts must keep working throughout; `@codent/app` must stay on the CoreEnv-free side of
the boundary (it has a small allowlist of direct `getEnv()` reads).

## Goals / Non-Goals

**Goals:**
- A first-class `CodentAgent` that can be instantiated many times, each owning its own workspace,
  model connection, agent registry, session host, and stores.
- Instance correctness for `SessionStore` / `MediaStore` and the other env-backed singletons, including
  two instances that coincide in one process with different backends (one local workspace, one remote
  `CoreEnv`).
- Explicit data flow: the runtime is passed where it is used, so no read silently resolves to the wrong
  instance through an async-context boundary.
- Keep every current capability (local, `--remote-env`, `--remote-provider`, `--remote-session`).
- Normalize module organization around the runtime boundary; names state responsibility.
- Staged, each stage green on `pnpm build` + CI.

**Non-Goals:**
- No change to the `AgentSession` / `AgentSessionHost` public contract or the app's dispatch model.
- No change to the LLM runtime (TanStack `chat()`/adapters) or middleware semantics.
- No `AsyncLocalStorage`-based environment resolution (see Decisions).
- No one-shot `CodentAgent.run(prompt)` convenience for now: `CodentAgent` is session-only (a session
  already covers the headless case; add a helper later if it earns its place).
- Not a per-request multi-tenancy auth model - only runtime isolation in one process.

## Decisions

### Decision: `CodentAgent` is a facade over `AgentRuntime` + `AgentManager` + `AgentSessionHost` + stores

```ts
interface CodentAgentOptions {
  env: CoreEnv;                                  // required; replaces registerCoreEnv
  provider?: ModelProvider;                      // prebuilt LLM plane
  direct?: { model: string; style?: ModelStyle; baseURL?: string; apiKey?: string };
  name?: string;                                 // human label for the runtime (default: rootPath basename)
  defaults?: {                                   // merged into every createSession
    systemPrompt?: string; maxIterations?: number; maxConcurrentTasks?: number;
    mcpConfigPath?: string; extensionDirs?: string[]; toolConfig?: AgentToolConfig;
  };
  manager?: AgentManager;                        // advanced/test injection
  host?: AgentSessionHost;                        // remote-session (option a): skip the local manager
  rootPath?: string;                             // display/log only; env carries the real root
}

class CodentAgent {
  static create(options: CodentAgentOptions): Promise<CodentAgent>;
  readonly id: string;
  readonly runtime: AgentRuntime;
  readonly host: AgentSessionHost;
  createSession(opts?: Partial<AgentSessionCreateOptions>): Promise<AgentSessionCreateResult>;
  getSession(agentId: string): AgentSession | undefined;
  listSessions(): Promise<AgentSessionListEntry[]>;
  destroySession(agentId: string): Promise<void>;
  dispose(): Promise<void>;
}
```

Internally it owns one `AgentRuntime { id, env, modelProvider, rootPath }`, one `AgentManager` bound to
it, one `AgentSessionHost`, and the runtime-scoped stores. Alternatives: (a) make `AgentManager` itself
the runtime - rejected, it is a registry not a runtime and the app facade is `AgentSessionHost`; (b) a
`new CodentAgent(...)` constructor - rejected in favor of async `create` so setup failures precede the
instance.

### Decision: inject the runtime explicitly; do NOT use AsyncLocalStorage

The runtime is passed to where it is read:
- `AgentManager` takes a runtime in its constructor; `buildManagedAgent` records it on the
  `ManagedAgent` (`managed.runtime`).
- `createToolRunContext(agentId, env)` builds `ToolRunContext.coreEnv` from the agent's runtime env; the
  runner passes the agent's env. Tools that read `ctx.context.coreEnv` (extensions already do) are
  instance-correct; tools that call `getEnv()` are changed to read the run context (or `managed.runtime`)
  at their call site.
- `SessionStore` takes its `CoreEnv` in its constructor (`get fs()` reads the injected env, not
  `getEnv()`); the session service / host pass the runtime's env.
- `MediaStore`, the websearch `ProviderManager`, the models.dev cache, the git cache, and the
  usage-history chain are constructed per runtime (or keyed by `rootPath`).

Alternatives considered: **AsyncLocalStorage** (resolve `getEnv()` from `activeRuntime()` scoped at run
boundaries). Rejected. It is implicit and its correctness is unprovable statically: any async root that
outlives the scope - background command jobs and their streaming callbacks, MCP/LSP transports, SDK
callback trampolines, `setTimeout`/`setInterval`, the event bus - reads the ambient runtime and writes
to the *wrong* instance. It also fails two different ways depending on a miss (silent wrong instance vs
throw when no runtime is active). Explicit injection makes each read locate its instance in the call
graph and lets a validator scan the run path for any remaining direct `getEnv()`.

### Decision: stores bind to the runtime's env, so local and remote coexist

`CoreEnv` is the only backend abstraction (`createNodeEnv` vs `createRemoteEnv`); every store already
goes through `env.fs` / `env.base64Decode` / `env.runCommand`. Binding each store to the runtime's env
means an instance with a local env persists to the local workspace and an instance with a remote env
persists over HTTP, in the same process and concurrently, with no shared path or cache. Scoping is
**per runtime, not per agent**: all agents in one `CodentAgent` share its `SessionStore` / `MediaStore`
/ websearch manager; different `CodentAgent`s do not.

### Decision: runtime-scoped global state inventory

A sweep of core's module-level instances and lazily-created singletons classifies each as
workspace/state-scoped (bind to the runtime) or process-global (keep). The runtime owns each
scoped instance; agents of one runtime share it, different runtimes do not.

Bind to the runtime:
- `MediaStore` and the websearch `ProviderManager` (+ `websearch/index.ts` `initialized` flag).
- `sharedUsageHistory` (`agent/usage/usage-history-service.ts`) and its write chain (writes `.agents/usage/`).
- `gitInfoCache` (`agent/turn-context/env-context.ts`) - keyed by the workspace root today but stored globally.
- `fileMutationQueues` (`agent/tools/util/file-mutation-queue.ts`) - its key is `getEnv().path.resolve(path)`, so two roots collide globally.
- `commandJobRegistry` (`agent/tools/util/command-job-registry.ts`) - background command jobs of a workspace.
- `AgentManager` (the ambient one becomes the ambient runtime's manager).

Keep process-global (not workspace data, with the reason):
- `toModelOutputRegistry` and `agent/tools/presentation/registry` - code registries keyed by tool name + owner id.
- `models-dev` memory cache - model metadata, identical across workspaces.
- `TreeSitterManager` (`command-safety/command-parser.ts`) - bundled-language parsers (CPU); it MUST be
  decoupled from the workspace env rather than scoped (grammars are not workspace files).
- `env-teardown` hooks, `generate-id` issued ids, `agent-log/lifecycle-guards` active logs / exit
  flushes, `streaming-callback` agent-bus map, the many static `Set`s of tool/type names, and the
  `task-prefork` / `task-run-state` WeakMaps (already keyed by `ManagedAgent`).

`AgentLog` is already `new AgentLog()` per agent (`agent-factory.ts`), so it stays per-agent; the
runtime's `name`/`id` is what per-runtime services (usage history, command jobs, log naming) associate
with, mirroring how a session carries a display name.

### Decision: keep an ambient runtime for backward compatibility

`registerCoreEnv` / `registerModelProvider` / `agentManager` are re-expressed as the ambient runtime.
Hosts and scripts not yet migrated keep working; `agentManager` is the ambient runtime's manager
(deprecated, documented surface). `getEnv()` / `getModelProvider()` remain, but the run path no longer
calls them (verified by the validator). No old-path shims beyond this documented compat surface.

### Decision: directory layout and one access rule

Two new top-level directories under `packages/core/src/`, plus a cleanup of the `agent/` root:

- `env/` - the CoreEnv abstraction owns its own directory:
  - `env/index.ts` - `CoreEnv` / `ResolvedCoreEnv`, the default fills, and the ambient registry
    (`registerCoreEnv` / `getEnv` / `clearCoreEnv` / `hasCoreEnv`).
  - `env/types.ts` - from `env-types.ts` (`FileError`, `ExecutionError`, fs/command result types).
  - `env/lsp.ts` - from `env-lsp.ts`.
  - `env/teardown.ts` - from `env-teardown.ts`.
  Imports become the directory form (`../env`, `../env/types`).
- `runtime/` - the runtime instance:
  - `runtime/agent-runtime.ts` - `AgentRuntime`: a class instance holding `env`, `modelProvider`,
    `rootPath`. This is how non-tool code reaches the environment.
  - `runtime/codent-agent.ts` - the `CodentAgent` facade.
- `provider/` - the LLM plane, orthogonal to CoreEnv (pulled out of `models/`):
  - `provider/model-provider.ts` - the `ModelProvider` type + `createDirectModelProvider`.
  - `provider/model-provider-registry.ts` - the ambient `registerModelProvider` / `getModelProvider`
    registry (compat fallback; the runtime carries its own provider).
  - `provider/remote-model-provider.ts`, `provider/resolve-from-provider.ts`, `provider/models-dev.ts`.
- `agent/` root cleanup (the three loose files move to their domain directories):
  `agent/ui-channel.ts` and `agent/channel-write.ts` -> `agent/ui/`; `agent/dispatch-order.ts` ->
  `agent/extension/`.

One access rule, applied everywhere, replaces the global read:

- **Tools and middleware** read the environment from the run context: `ToolRunContext.coreEnv`
  (forwarded through `chat({ context })`), whose source becomes the agent's runtime env.
- **All other code** reads the environment / model provider from the `AgentRuntime` instance it was
  constructed with (`runtime.env`, `runtime.modelProvider`) - constructor injection, no ambient lookup.
- **Neither in scope** (scripts, a genuinely standalone helper) uses the ambient `getEnv()` /
  `getModelProvider()`, which is the only remaining global read and exists for backward compatibility.

`getEnv()` / `getModelProvider()` are therefore not deleted, but the run path stops calling them; the
validator scans the run path for any leftover direct call.

File renames land directly per `core-code-organization`; docs whose paths change are updated in the
same change.

## Risks / Trade-offs

- [A `getEnv()` call site is missed] it keeps resolving to ambient, so that one read is single-instance
  -> a validator scans the run path (`agent/tools/**`, `agent/media/**`, `agent/persistence/**`,
  `agent/mcp/**`, `managers/**`) for direct `getEnv()`/`getModelProvider()` and fails on any that is not
  an explicit runtime read.
- [Store scoped per agent instead of per runtime] agents of one runtime stop sharing media/session
  state -> assert cross-agent sharing within a runtime and non-sharing across runtimes.
- [Local + remote correctness] -> validator creates one local-env instance and one remote-env instance
  and asserts each writes/reads its own session log and media, and that a resume works on both.
- [Behavior drift across remote planes] -> run `validate:coreenv-http`, `validate:provider-proxy`,
  `validate:agent-session-http`, `validate:websearch-tool-config` unchanged at every stage.
- [Large diff] -> staged delivery with green build/CI between stages; stages additive until host
  migration.

## Migration Plan

1. **Stage 0 (additive)**: add `AgentRuntime` + `CodentAgent`; `registerCoreEnv`/`registerModelProvider`
   install the ambient runtime; `CodentAgent` builds a manager/host bound to its runtime. No run-path
   behavior change.
2. **Stage 1**: bind `AgentManager`/`ManagedAgent` to the runtime; `createToolRunContext` uses the
   agent's env; migrate the tool `getEnv()` call sites to the run context.
3. **Stage 2**: constructor-inject `SessionStore`; make `MediaStore`, websearch `ProviderManager`,
   models.dev cache, git cache, usage-history chain runtime-scoped.
4. **Stage 3**: migrate hosts (`cli`, `acp`, `im-bridge`, `codent`, `extension`, `playground`,
   `server`) to `CodentAgent.create`.
5. **Stage 4**: app routes direct `getEnv()` reads through the active runtime; organization
   normalization + docs; archive.

Rollback: stages are additive until Stage 3; reverting a stage returns to the prior global behavior
because the ambient runtime remains the fallback.

## Open Questions

1. **`AgentRuntime` export - internal (decided).** `CodentAgent` + `CodentAgentOptions` are the only
   public surface; `AgentRuntime` is an implementation detail reached in-repo via `dev.ts`. Promote it
   to a public export only if a real external consumer needs to name or pass a runtime.
2. **`--remote-session` - covered by `CodentAgent({ env, host })` (decided, option a).** A remote-session
   `CodentAgent` builds no local manager/provider and uses `env` for the workspace panel; one handle
   covers every plane.
3. **Provider probing at `create()` time?**
   Whether `CodentAgent.create` should probe the model connection (fail fast on a bad key / unreachable
   base URL) or stay lazy and surface the failure on the first run. Probing gives a clean setup error;
   lazy avoids a network round-trip and a false negative when the provider is temporarily down.
   Recommendation: lazy for now (matches today's behavior), revisit if hosts need an eager check.

