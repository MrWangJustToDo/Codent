## Why

`@codent/core` has no instantiable runtime object. A process can host exactly one "world" - one
workspace and one LLM connection - because `CoreEnv` and `ModelProvider` live in module-level
singletons (`env.ts` `_env`, `model-provider.ts` `_provider`), the manager is a module-level
`export const agentManager = new AgentManager()`, and ~56 core modules call `getEnv()` /
`getModelProvider()` directly at run time. Consequently a server cannot host two isolated
workspaces/keys, tests cannot run two runtimes side by side, and any host that wants a second
independent agent must replace the globals (replace is not isolate). We want a first-class
`CodentAgent` instance that owns its runtime and can be created many times, without losing any
existing capability.

## What Changes

- Introduce `CodentAgent` - an instantiable runtime handle created with `CodentAgent.create(options)`,
  owning `{ CoreEnv, ModelProvider, AgentManager, AgentSessionHost }` and exposing session lifecycle
  (`createSession` / `getSession` / `listSessions` / `destroySession`) plus `dispose()`. The existing
  host bootstrap (`registerCoreEnv` / `registerModelProvider` / `agentManager`) is retained as an
  ambient/default runtime so current hosts and validators keep working unchanged.
- Add an internal `AgentRuntime` context (`{ env, modelProvider, rootPath }`) and pass it **explicitly**:
  `AgentManager` is constructed with a runtime, every `ManagedAgent` records it, the tool run context
  (`ToolRunContext.coreEnv`) is built from it (the seam already exists, only its source changes), and
  `SessionStore` / `MediaStore` / the websearch manager / caches are constructed with the runtime's
  `env`. The run path reads the runtime through these explicit seams instead of `getEnv()`; the ~56
  `getEnv()` call sites on the run path are updated. `getEnv()` / `getModelProvider()` remain only as
  the ambient fallback for unmigrated or script code.
- Converge the workspace-scoped internal singletons to runtime scope: `MediaStore`, the websearch
  `ProviderManager` (+ its `initialized` flag), `sharedUsageHistory` (+ its write chain), `gitInfoCache`,
  `fileMutationQueues`, and `commandJobRegistry`; the ambient `agentManager` becomes the runtime's
  manager. State that is not workspace data stays process-global, with reasons recorded (tool /
  presentation registries, the models.dev metadata cache, `TreeSitterManager`, id / teardown / lifecycle
  registries, and the per-`ManagedAgent` WeakMaps). `AgentRuntime` / `CodentAgent` carry a `name` that
  per-runtime services (usage history, command jobs, log naming) associate with.
- Normalize module organization for the runtime boundary: extract the CoreEnv abstraction into
  `packages/core/src/env/` (`index.ts` interface + ambient registry, `types.ts`, `lsp.ts`,
  `teardown.ts`); add `packages/core/src/runtime/` (`agent-runtime.ts` the `AgentRuntime` instance,
  `codent-agent.ts`, `model-provider-registry.ts`); move the three loose files at the `agent/` root to
  their domains (`ui-channel.ts` + `channel-write.ts` -> `agent/ui/`, `dispatch-order.ts` ->
  `agent/extension/`); update docs, which MUST resolve. Internal renames land directly (no
  compatibility shims beyond the documented ambient-runtime aliases).
- Keep the app contract: `AgentSession` / `AgentSessionHost` / `createAgentFromConfig` are unchanged; a
  `CodentAgent` supplies the `host`. App-side direct `getEnv()` reads are routed through the active
  session's runtime so the UI follows the instance.
- Staged delivery (each stage green on `pnpm build` + CI): (1) additive `AgentRuntime` + `CodentAgent`
  with explicit runtime injection and ambient fallback; (2) de-globalize the remaining singletons and bind
  `AgentManager` / `ManagedAgent` to the runtime; (3) migrate hosts and app to instance-based creation;
  (4) file/organization normalization and docs.

## Capabilities

### New Capabilities

- `agent-runtime-instances`: the `CodentAgent` runtime handle - how many isolated runtimes a process
  may hold, what each owns (env, provider, manager, host), how it is created and disposed, and the
  guarantee that two instances do not share workspace or LLM state.

### Modified Capabilities

- `managed-agent-runtime`: `ManagedAgent` / `AgentManager` SHALL obtain environment (fs, shell, fetch)
  and model connection from an injected runtime rather than process-global registries, while remaining
  the single runtime object per agent.

## Impact

- Affected code (core): `env/`, `provider/` (moved out of `models/`), `managers/agent-manager.ts`,
  `managers/agent-factory.ts`, `managers/run-agent.ts` (run context), `agent/runner/run-context.ts`,
  `agent/media/media-store.ts` (+ `media-utils.ts`), `agent/persistence/session-store.ts` (and its
  `SessionStore` constructors), `agent/tools/websearch/provider.ts` (+ `websearch/index.ts`),
  `agent/turn-context/env-context.ts`, `agent/usage/usage-history-service.ts`,
  and the ~56 `getEnv()` call sites on the run path (now reading the run context / injected runtime).
- New/changed public API (`@codent/core`): `CodentAgent` + `CodentAgentOptions` + `AgentRuntime` (type)
  exported from `index.ts`; `registerCoreEnv` / `registerModelProvider` / `agentManager` remain as the
  ambient-runtime compatibility surface.
- Hosts: `cli`, `acp`, `im-bridge`, `codent`, `extension`, `playground`, `server` migrate their bootstrap
  to `CodentAgent.create`; global registration is kept only for browsers/tests that cannot construct a
  full runtime.
- App: no Host/Session contract change; the few direct `getEnv()` reads (`FileTree`, `FileContent`,
  `WorkspaceFileMode`, `Help`, `use-workspace-info`) resolve through the active runtime.
- Tests/validators: new `validate:agent-runtime-instances` proving two instances with different
  `rootPath` and different provider connections coexist; existing `validate:*` must stay green
  (ambient fallback).
