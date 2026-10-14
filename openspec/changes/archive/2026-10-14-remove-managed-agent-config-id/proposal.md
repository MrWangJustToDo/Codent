## Why

`ManagedAgentConfig` accepts `id?: string` and `ManagedAgent` honours it
(`init.id ?? config.id ?? generateId("agent")`), but nothing in the repository passes it: the seam is
reachable only from a host, and no code reads the id it would set. An id a host can choose but nothing
correlates against invites hosts to treat the **agent id as a stable key** — which it is not. It is
minted per process and re-minted on every restart; the stable key is the persisted disk session
(`AgentSessionSnapshot.activeSessionId`, ARCHITECTURE.md §1.7).

Two ids that read alike and behave differently is the confusion this removal closes, in the same spirit
as the `activeSessionId` rename: keep the minting in core, and let the type say so.

## What Changes

- **BREAKING** (core public type): remove `id?: string` from `ManagedAgentConfig`. `ManagedAgent`
  mints its own id (`init.id ?? generateId("agent")`).
- Keep `init.id` — that is the **internal** creation seam a `task` subagent uses to claim the
  `subagent_…` id it was spawned under (`run-subagent.ts` passes it). It is not host-reachable.
- State the provenance rule where the id is declared: core-minted, process-scoped, **not** a
  correlation key.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `managed-agent-runtime`: adds the requirement that agent ids are core-minted and that
  `ManagedAgentConfig` accepts no id.

## Impact

- `packages/core/src/managers/managed-agent.ts` — the host-facing config type (no `id`) and the
  constructor's provenance comment (`init.id ?? generateId("agent")`).
- `packages/core/src/managers/agent-manager.ts` (`spawnSubagent` / `createManagedAgent`),
  `packages/core/src/managers/agent-factory.ts` (`buildManagedAgent`) and
  `packages/core/src/agent/subagent/run-subagent.ts` — the internal id channel the subagent path uses.
- Coverage: the type removal is compile-checked (a host that passed `id` no longer compiles). The
  internal channel is pinned by an assertion in `validate-session-identity.mjs` — a real spawned subagent
  keeps the id core handed over, and dropping that forward fails it. The second id-setting caller,
  `scripts/validate-tool-run-agentid.mjs` (a fixture that needs a distinguishable id), now passes it
  through `init.id`.
- Hosts: neither id-setter in-repo is a host — both are core-internal (`run-subagent.ts` mints the
  subagent id; the fixture stands in for one). A downstream host that passed `config.id` gets a type
  error, which is the intended signal.
- Behaviour: unchanged for every current caller. A subagent still gets exactly the id it was spawned
  under, a root agent still gets a minted one — what changed is who is allowed to say so.
