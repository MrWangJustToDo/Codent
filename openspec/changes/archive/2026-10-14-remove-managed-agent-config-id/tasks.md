## 1. Remove the host-supplied id

- [x] 1.1 Drop `id?: string` from `ManagedAgentConfig` in
      `packages/core/src/managers/managed-agent.ts`; `ManagedAgent` keeps
      `init.id ?? generateId("agent")`.
- [x] 1.2 Give the id an internal channel instead: `AgentManager.spawnSubagent(parentId, config, id?)`
      forwards it to `createManagedAgent(config, parentId, id?)`, which passes it to
      `buildManagedAgent({ id })` (replacing the `id` it used to destructure out of the config).
      `run-subagent.ts` hands the id over as an argument instead of a config field.
- [x] 1.3 Confirm the public type is the only thing hosts see: a host passing `id` no longer compiles
      (`pnpm typecheck`), and the other four `spawnSubagent` callers (validators, no id) are unaffected.

## 2. Coverage

- [x] 2.1 `validate-session-identity.mjs` (the validator that owns id semantics) asserts a spawned
      subagent is registered under exactly the id handed to `spawnSubagent` — the provenance the
      internal channel exists for. (The first draft named `validate-cancel-semantics.mjs`; it has no
      real spawn, only a fixture.)
- [x] 2.2 Non-vacuity: dropping the id forward inside `spawnSubagent` must fail that assertion (the
      subagent would get a minted id) — record the run in the commit message.

## 3. Verification

- [x] 3.1 `pnpm build:core && pnpm typecheck`
- [x] 3.2 `node scripts/run-all-validators.mjs --dir packages/core` — expect 0 failed.
- [x] 3.3 `pnpm --filter @codent/app test` (the app reads no agent id, but its build consumes the
      public type).
