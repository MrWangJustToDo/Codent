## Context

`@codent/core` splits into a converged **data plane** (one `AgentEventBus`, one `AgentLog` seam, one tool registry/presentation, self-contained compaction algorithms) and a **control plane** that is still spread out:

- `AgentStatus` (10 values, 23 triggers) is written from 4 files (35 call sites) and simultaneously encodes stream phase, liveness, user pause and exclusive operations. `TERMINAL_STATUSES` and `ACTIVE_STATUSES` overlap on `waiting` / `awaiting_user`.
- Nine different "is this still current?" mechanisms coexist: `RunToken`, chat-controller `lifecycleEpoch`, UI-channel session generation, `isSessionSwitching`, `sessionIdAtStart` / `stillOn*`, the abort-controller identity, the compaction lease, background-work epochs and the extension incarnation lease.
- Session ownership is stored in six places (ownership map, disk reservation, deletion tombstone, sync tracker, log-sink binding, restore placeholder) and reached through a 38-member `SessionLifecycleHost`.
- Tool permission is decided at 13 entry points (static flag, MCP annotations, command analyzer, auto mode, plan execution, rules, env overrides, subagent profile, external paths, extension interceptor, plan-mode tool filtering, code-mode exclusions, client tools) and recorded in three representations.
- Mode logic is consistent at the coordinator but read directly in 70+ places; `ManagedAgent` is 3091 lines / ~176 methods.

The planning source is `docs/core-control-plane-convergence-tasks.md` (67 tasks, waves, coverage matrix). This design chooses the target shape and the migration strategy; it does not repeat the task list.

## Goals / Non-Goals

**Goals:**

- One answer to "is this async continuation still current?" (`Epoch`).
- One owner of session identity/ownership/switch (`SessionLease` + ports).
- One permission decision per tool call (`authorizeToolCall`), with availability and approval sharing policy facts.
- Three explicit state axes with a transition table; `AgentStatus` becomes a derived projection.
- One mode read surface (`ModeState`) and policy facts.
- A thin `ManagedAgent` facade plus facet modules; control-plane code grouped by domain.
- Behavior preservation: every convergence keeps the existing observable contract unless a spec delta says otherwise.

**Non-Goals:**

- Rewriting the event bus, log seam, tool registry/presentation, compaction algorithms, models/provider, media, tree-sitter or LSP internals.
- Changing `AgentStatus` values, event names, or the curated public export list.
- Redesigning the agent loop, the TanStack integration or the compaction cut policy.
- Introducing a second agent runtime object, a service locator, or dependency-injection container.

## Decisions

### D1. `Epoch` composes the existing generations instead of replacing them at once

An `Epoch` value carries the session generation (UI channel), the run token (`RunCoordinator`) and the lifecycle generation (chat controller). `EpochSource.capture()` composes them. Three predicates keep each migrated contract exact instead of making every caller stricter: `isCurrent()` = the captured session generation is live (the old captured-session-id guard, and the chat controller's generation-only staleness check — a switch is admitted before it stops the run, so the old run still owns its terminal write); `isStable()` = `isCurrent()` and no switch in flight (middleware/disk-read window); `isRunCurrent()` = `isCurrent()` plus the captured run token and lifecycle generation (run-scoped writers).

- **Why**: each existing mechanism is correct in its slice; the problem is that every new path picks one and re-implements the check. Composing them gives one predicate without a risky rewrite of all producers.
- **Alternatives**: (a) keep per-site guards — rejected, the bug class recurs; (b) introduce a new global counter — rejected, two sources of truth and a lost update on restore; (c) replace `RunToken` outright — rejected, it is already embedded in the run loop and validators.
- **Consequence**: `sessionIdAtStart` / `stillOn*` / post-await `isSessionSwitching` are deleted; `isSessionSwitching` survives only for synchronous admission at API boundaries.

### D2. `SessionLease` is a state machine, not another god object

The lease holds session id, generation, owner and state; it owns the transitions that currently write six stores. The switch transaction is `lease.switchTo(target)` with explicit phases. `SessionRuntime` groups four ports (`RunControl`, `TranscriptPort`, `ModePort`, `SidecarPort`).

- **Why**: the scattered feeling comes from the *transaction* reaching into every subsystem through a 38-member host. A lease makes the state explicit; ports make the dependencies explicit.
- **Alternatives**: (a) extend `SessionLifecycleService` — rejected, keeps the host; (b) a `SessionManager` class with the same host — rejected, same coupling with a new name; (c) event-driven switch — rejected, ordering and rollback would become implicit again.
- **Consequence**: ownership map, reservation, placeholder, sink binding and tracker become lease internals; the switch becomes fault-injectable.

### D3. Authorization is a pipeline with a single decision record

`authorizeToolCall({ tool, args, policy, epoch })` runs seven ordered stages and returns `{ action, source, reason }`. The approval table is the store; the UI part, resume map and JSONL row are projections. Extension `tool:before` skip becomes a stage, not a parallel gate.

- **Why**: today a call can be allowed by one gate and denied by another with no shared record; adding a mode or tool class requires edits in several places. One pipeline gives one decision, one source, one record.
- **Alternatives**: (a) make it middleware — rejected, middleware transforms messages/config and runs inside the engine loop, while authorization needs args and a pre-execution verdict; (b) keep gates but emit a combined event — rejected, the gates would still disagree; (c) move everything into `ToolApprovalTable` — rejected, that is storage, not policy.
- **Consequence**: tool availability and approval share `AgentPolicyFacts`; plan-mode filtering remains a projection of the same facts (the model must not be offered unavailable tools).

### D4. Three axes, one transition table, `AgentStatus` as projection

`LifecyclePhase` × `RunPhase` × `WaitKind` → `AgentStatus`. All writes go through `transition(event)`. Terminal/active predicates derive from the axes. Compaction is a run phase, not a status value.

- **Why**: the current enum conflates four questions; the overlap sets and special cases are the symptoms.
- **Alternatives**: (a) add more status values — rejected, the enum keeps conflating; (b) one flat FSM with every combination as a state — rejected, combinatorial and breaks the wire type; (c) keep the status as SoT and derive axes — rejected, the contradictions remain in the SoT.
- **Consequence**: wire compatibility is preserved by the projection; the axes are additive in the snapshot.

### D5. `ModeState` is a read API over the existing coordinator

Plan and auto controllers remain the owners; `ModeState` exposes the read model and the policy facts. `todosSeeded` moves into `AgentPolicyFacts`. Direct controller reads outside `agent/mode/` are removed by a source gate.

- **Why**: mutual exclusivity already works; the problem is the 70+ read sites and the shadow `todosSeeded` condition.
- **Alternatives**: fold modes into the state machine — rejected, modes are policy, not liveness; keep direct reads — rejected, the spread is the problem.

### D6. Facade + facets now, directory move last

`ManagedAgent` keeps the public surface and delegates model/session/run/mode/tool/extension clusters to facet modules. Domain directories are introduced mechanically after semantics are stable.

- **Why**: the composition root is the largest file but moving it while changing behavior creates unreviewable diffs.
- **Alternatives**: one big-bang rewrite — rejected; keep the file and only add comments — rejected, the header already documents the debt.

### D7. Behavior-preserving adapters, equivalence first

Every semantic change lands behind an adapter that runs the new path beside the old one, with a matrix validator comparing observable outcomes. Old paths are deleted at the end of the phase (no permanent dual-write).

- **Why**: the control plane has 83 validators; behavior equivalence is the only safe way to keep them meaningful while the internals move.
- **Alternatives**: rewrite then fix tests — rejected, it hides regressions until late.

## Risks / Trade-offs

- **Switch-transaction regression (messages/ownership)** → phase-level fault-injection matrix (`validate:session-lease-matrix`), plus a temporary dual-run of the old and new transaction in development.
- **Approval ordering change weakens safety** → the pipeline first composes the existing decision functions unchanged; the matrix asserts fail-closed defaults and stage precedence before any duplicate gate is deleted.
- **A missed state path leaves the agent stuck** → transition matrix + the existing pump/compaction validators; `transition()` records illegal events instead of silently accepting them.
- **An async path misses the epoch and writes cross-session** → writer inventory + source guard; the Epoch phase deletes the old guards only after all call sites are audited.
- **Directory move collides with logic changes** → the move is a separate, logic-free PR after the facade split; `validate:layer-boundaries` and `validate:module-organization` gate it.
- **Adapters become permanent** → each phase has a removal checklist in its DoD; the next phase's first task verifies the previous adapters are gone.
- **Host breakage for internal imports** → host packages are updated in the same change as the interface removal; the curated `@codent/core` exports do not change.

## Migration Plan

1. **P0 (guardrails)**: writer inventory, invariants catalogue, baseline metrics, equivalence helper, validator gap list. No behavior change.
2. **P1 (Epoch)**: add `Epoch`/`EpochSource`, then migrate persist/usage/wake/subagent writes, then delete the old guards. Gate: `validate:epoch-equivalence`.
3. **P2 (SessionLease)**: introduce the lease around existing stores, then the ports and the switch transaction, then narrow the host. Gate: `validate:session-lease-matrix`.
4. **P3 (Authorize)**: compose existing decisions into `authorizeToolCall`, migrate the command/auto/plan/interceptor paths, then remove duplicate gates. Gate: `validate:authorize-matrix`.
5. **P4 (State axes)**: add the projection, invert the writer, collapse triggers, remove the overlap/special cases. Gate: `validate:state-transition-matrix`.
6. **P5 (Facade/dirs)**: extract facets, move modules by domain, update docs. Gate: full suite + typecheck + lint.

Rollback is per wave: each wave is an independent merge with its own validator; reverting the wave leaves the previous adapters in place. No phase changes a public export or wire name.

## Open Questions

- Should the three axes be exposed in `AgentSessionSnapshot` in P4, or kept internal until the state machine has run for one release? (Spec allows additive; default: expose behind the existing optional-field convention once `T9` is green.)
- Where does `SessionRuntime` live — `agent/session/` or `managers/`? **Resolved for now: `managers/session-runtime.ts`.** Its ports name manager-owned collaborators (`RunCoordinator`, `SessionPersistence`, `ModeCoordinator`, the controllers), and the layer table allows `managers → agent`, not the reverse. Moving it to `agent/session/` requires first extracting those collaborators into `runtime-types` ports (task 7.7); the target module map still expects that end state.
- Exact wire name/shape of the approval `source` field (`source` vs `decidedBy`): decide in `A8`, keep it optional and additive.
- Do we keep `AgentStatus` indefinitely as the wire projection, or mark it derived/deprecated for hosts? Default: keep it; no host migration is required.
