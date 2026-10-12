## 1. Organization (pure moves, behavior-neutral)

- [x] 1.1 Create `packages/core/src/env/`: move `env.ts` -> `env/index.ts`, `env-types.ts` -> `env/types.ts`, `env-lsp.ts` -> `env/lsp.ts`, `env-teardown.ts` -> `env/teardown.ts`.
- [x] 1.2 Update every import of the moved env modules to the directory form (`../env`, `../env/types`, `../env/lsp`, `../env/teardown`); run `pnpm build:core` + `tsc`.
- [x] 1.3 Move `agent/ui-channel.ts` + `agent/channel-write.ts` -> `agent/ui/`; move `agent/dispatch-order.ts` -> `agent/extension/`; update imports.
- [x] 1.4 Update `AGENTS.md` core file-structure map + `packages/core/ARCHITECTURE.md` so every named path resolves (`core-code-organization`).
- [x] 1.5 Build core + run the full core `validate:*` set to confirm the moves are behavior-neutral.

## 2. Stage 0 — Additive runtime core

- [x] 2.1 Add `packages/core/src/runtime/agent-runtime.ts`: `AgentRuntime` class instance holding `env`, `modelProvider`, `rootPath` (and id).
- [x] 2.2 Add `packages/core/src/provider/` (pull the LLM plane out of `models/`): move `models/provider/*` there and add `provider/model-provider-registry.ts`; move the ambient `_provider` storage and `register/get/clear/has` into it (`ModelProvider` type + factories live in `provider/model-provider.ts`). `models/` re-exports the provider symbols.
- [x] 2.3 Keep the ambient env registry in `env/index.ts` (`registerCoreEnv`/`getEnv`/`clearCoreEnv`/`hasCoreEnv`); `getEnv()` resolves the ambient runtime only.
- [x] 2.4 Add `packages/core/src/runtime/codent-agent.ts`: `CodentAgent` + `CodentAgentOptions` (incl. `name?` runtime label) with `create`, `createSession`/`getSession`/`listSessions`/`destroySession`, `dispose`; owns an `AgentRuntime`, an `AgentManager` bound to it, an `AgentSessionHost` (local by default, `options.host` for remote-session, option a), and the runtime-scoped stores. Session-only (no one-shot `run`).
- [x] 2.5 Export `CodentAgent` + `CodentAgentOptions` from `packages/core/src/index.ts` (keep `AgentRuntime` internal for now); keep `registerCoreEnv`/`registerModelProvider`/`agentManager` as the ambient surface.
- [x] 2.6 Add `validate:agent-runtime-instances` (two instances, different `rootPath` + different providers; assert isolated fs roots, isolated provider connections, isolated session lists; assert ambient fallback) and wire it via the `validate:*` glob discovery.
- [x] 2.7 Build core + run existing `validate:*` to confirm the additive stage is behavior-neutral.

## 3. Stage 1 — Bind manager/agent/run context to the runtime

- [x] 3.1 Give `AgentManager` an `AgentRuntime` in its constructor (default = ambient); `buildManagedAgent` records `runtime` on the `ManagedAgent`.
- [x] 3.2 Change `createToolRunContext(agentId, env)` to take the agent's runtime env; pass it from the runner so `chat({ context })` carries the instance's `coreEnv`.
- [x] 3.3 Migrate the tool / middleware `getEnv()` call sites to the run context (`ctx.context.coreEnv`); list the migrated files.
- [x] 3.4 Migrate the remaining run-path consumers (media, persistence, mcp, managers) from `getEnv()` to their injected `runtime.env`.
- [x] 3.5 Add a validator guard that scans the run path (`agent/tools/**`, `agent/media/**`, `agent/persistence/**`, `agent/mcp/**`, `managers/**`) for direct `getEnv()` / `getModelProvider()` reads and fails on any that is not the run context or an injected runtime.
- [x] 3.6 Extend `validate:agent-runtime-instances`: a tool run in runtime A resolves A's `rootPath` while runtime B is concurrently active (filesystem + shell).
- [x] 3.7 Run the full core `validate:*` set; confirm no regression with a single ambient runtime.

## 4. Stage 2 — Runtime-scoped stores and caches

- [ ] 4.1 Constructor-inject `CoreEnv` into `SessionStore` (replace `get fs() { return getEnv().fs }`); update `agent-factory.ts` and `local-agent-session-host.ts` to pass the runtime's env.
- [ ] 4.2 Make `MediaStore` runtime-scoped (constructed with env; no module singleton); update `media-utils.ts` to use the runtime's store.
- [ ] 4.3 Make the websearch `ProviderManager` (+ `websearch/index.ts` `initialized` flag) runtime-held instead of a module singleton.
- [ ] 4.4 Move `gitInfoCache` (`agent/turn-context/env-context.ts`), `fileMutationQueues` (`agent/tools/util/file-mutation-queue.ts`), `sharedUsageHistory` + its write chain (`agent/usage/usage-history-service.ts`), and `commandJobRegistry` (`agent/tools/util/command-job-registry.ts`) to runtime scope.
- [ ] 4.5 Keep the non-workspace globals process-global and document why (tool / presentation registries, models.dev memory cache, TreeSitterManager decoupled from the workspace env, id / teardown / lifecycle registries, per-`ManagedAgent` WeakMaps); state each in the design inventory.
- [ ] 4.5 Extend `validate:agent-runtime-instances`: one local-env instance and one remote-env instance coexist - each writes/reads its own session log and media, resume works on both; and two agents in one runtime share the store while a third runtime does not.
- [ ] 4.6 Run affected `validate:*` (websearch-providers, media-store, session-persist-integrity, usage, turn-context).

## 5. Stage 3 — Migrate hosts to CodentAgent

- [ ] 5.1 `packages/cli`: build the runtime via `CodentAgent.create` (env + provider planes) and pass `agent.host` into `createAgentFromConfig`.
- [ ] 5.2 `packages/codent`: same migration.
- [ ] 5.3 `packages/acp` (`bootstrap.ts`) and `packages/im-bridge` (`local-host.ts`): build via `CodentAgent.create`.
- [ ] 5.4 `packages/extension` and `packages/playground`: build via `CodentAgent.create` (remote env / WebContainer env), keeping ambient registration only where a full runtime cannot be constructed.
- [ ] 5.5 `packages/server`: construct runtimes per server (env + optional remote env); drop reliance on the process-wide `agentManager`.
- [ ] 5.6 Run per-package bootstrap validators + `validate:coreenv-http`, `validate:provider-proxy`, `validate:agent-session-http`, `validate:websearch-tool-config`.

## 6. Stage 4 — App env routing, docs, archive

- [ ] 6.1 Route app direct `getEnv()` reads (`components/FileTree.tsx`, `components/FileContent.tsx`, `components/WorkspaceFileMode.tsx`, `components/Help.tsx`, `hooks/use-workspace-info.ts`) through the active session's runtime.
- [ ] 6.2 Promote `agentManager` to a documented ambient-only, deprecated surface in `AGENTS.md`.
- [ ] 6.3 Update `AGENTS.md` bootstrap sequences (CLI/extension) to show `CodentAgent.create`; re-check the file-structure map after all moves.
- [ ] 6.4 Run `pnpm build`, `pnpm lint`, `pnpm typecheck`, the full `validate:*` set, and `validate:core-public-exports`.
- [ ] 6.5 Archive the change and sync its spec deltas into `openspec/specs/`.
