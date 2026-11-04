## Why

Core's data plane (event bus, log seam, tool registry, compaction algorithms) is converged, but its **control plane** — agent/run/session/extensions lifecycles, status transitions, permissions, and session ownership — is spread across ~15 classes and 9 different "is this still current?" mechanisms, with ordering invariants encoded in comments and ~83 control-plane validators. Every new async path has to re-solve ownership, and the same class of bug (stale run signal, cross-session usage/write, terminal+waiting contradictions) keeps recurring. Converge it now, before more hosts and features multiply the entry points.

## What Changes

- Introduce **`Epoch`** as the single currency for "is this async continuation still current?" (`sessionGen` + `runToken` + `lifecycleGen`), replacing ad-hoc `sessionIdAtStart` / `stillOn*` / `captureSessionStaleness` / scattered `isSessionSwitching` guards.
- Introduce **`SessionLease` + `SessionRuntime`**: one object owns session identity, generation, ownership, disk reservation, restore placeholder, log-sink binding and persistence baseline; the session switch becomes an explicit, rollbackable `lease.switchTo()` transaction over four ports instead of a 38-member host interface.
- Introduce **`authorizeToolCall()`**: one ordered permission pipeline (availability → hard policy → auto modes → declarative requirement → command analysis → extension hook → decision store), replacing 13 independent gates and three representations of the same decision.
- Introduce **three state axes** — `LifecyclePhase`, `RunPhase`, `WaitKind` — with a single transition table; `AgentStatus` becomes a pure projection (wire values unchanged). Removes the `TERMINAL/ACTIVE` overlap, the `compacting` special case and the `error + ask_user` contradiction.
- Introduce **`ModeState`** as the single read API for plan/auto (`planPhase`, `auto`, `approvalPolicy`, `toolAvailability`), with `todosSeeded` moved into authorization facts; removes 70+ direct `planMode` reads.
- Split **`ManagedAgent`** (3091 lines / ~176 methods) into a thin facade plus `ModelState` / `SessionState` / `RunState` / `ModeState` / `ToolState` / `ExtensionState` facets, and reorganise control-plane code by domain (`agent/run`, `agent/session`, `agent/mode`, `agent/approval`, `agent/state`) instead of technical role.
- Add control-plane guards: writer inventory, transition/authorize/lease matrices, epoch equivalence, metrics CI.
- **BREAKING (workspace-internal, not package-public)**: internal module paths and the `SessionLifecycleHost` interface are replaced; `packages/app` / `cli` / `acp` / `server` are updated in the same change where they touch an internal path. No public export removal is planned; `AgentSessionSnapshot` gains additive phase fields; wire event names and `AgentStatus` values are unchanged. Compatibility is sacrificed only where the architecture requires it.

## Capabilities

### New Capabilities

- `core-agent-epoch`: one captured `Epoch` governs every async continuation (persist, usage, wake, subagent settle, tool write-back); no cross-session/cross-run writes by construction.
- `core-session-lease`: one `SessionLease` / `SessionRuntime` owner for session identity, generation, ownership, reservation, sink binding, persistence baseline and the switch transaction.
- `core-tool-authorization`: one ordered authorization pipeline and one decision record per tool call; availability and approval share the same policy facts.
- `core-agent-state`: three explicit state axes with a transition table; `AgentStatus` is a derived projection with no overlapping terminal/active semantics.
- `core-mode-policy`: a single `ModeState` read API and policy facts for plan/auto, including plan-execution auto-approval and tool availability.

### Modified Capabilities

- `core-code-organization`: add domain-first control-plane layout and facade/facet requirements; retire the `managed-agent.ts` size exception; require the module map to follow the new layout.
- `managed-agent-runtime`: clarify that `ManagedAgent` remains the only runtime object while facets and `SessionRuntime` ports are internal parts of it, not a second agent object; services still receive explicit dependencies.
- `run-abort-ownership`: generalise the stale-pump currency requirement from `RunToken` to `Epoch` (session + run + lifecycle generation), and forbid new ad-hoc session-snapshot guards.
- `session-host-api`: snapshot MAY expose additive `lifecyclePhase` / `runPhase` / `wait` projections while `status` and existing fields keep their meaning; no command or event removal.

## Impact

- **Code**: `packages/core/src/managers/*` (ManagedAgent, controllers, services, middleware), `agent-session/*`, `runtime-types/*`, and new `agent/{state,run,session,mode,approval}/*` domains. No changes to compaction algorithms, models/provider, media, tree-sitter or LSP internals.
- **Hosts**: `packages/app`, `cli`, `acp`, `server` are touched only where an internal import or the `SessionLifecycleHost` interface is replaced; they keep using the curated `@codent/core` surface and `AgentSession`.
- **APIs / wire**: no event-name or `AgentStatus` value changes; `AgentSessionSnapshot` additions are optional/additive; approval decision events gain an optional `source`; tool-availability and approval behaviour remain equivalent (enforced by matrices).
- **Docs / validators**: `AGENTS.md`, `packages/core/ARCHITECTURE.md`, `docs/core-control-plane-convergence-tasks.md`; new `validate:control-plane-writers`, `validate:epoch-equivalence`, `validate:session-lease-matrix`, `validate:authorize-matrix`, `validate:state-transition-matrix`; the existing 263-validator suite stays green.
