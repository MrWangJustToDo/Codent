# Core Control-Plane Invariants

Catalogue of ordering/lifetime rules that the `converge-core-control-plane` change turns into
structure. Status values:

- **comment-only** — the rule lives in prose and is trusted by review.
- **validator** — a script checks some observable consequence, but the writer set is not restricted.
- **partial** — a type/lease/identity already encodes part of it.
- **structured** — the target shape; no task needed.

"Target task" is the convergence task that replaces the current encoding.

## Lifecycle

### I1. Agent creation is register-then-bootstrap

The order is: build the object graph → bind the log/scope → run bootstrap (extensions, MCP,
memory) → register → emit `session:start`. A failure after any acquisition rolls back everything
acquired so far.

| Current encoding | Target task |
|---|---|
| comment-only in `agent-factory` / `agent-manager`, partial try/catch rollback, `validate:create-bootstrap-rollback`, `validate:bootstrap-log-binding` | T1 (`LifecyclePhase`), F1/F2 |

### I2. A run prepares before it builds adapters

`prepareForRun` mints the run's `AbortController`; the adapter/runner may then reject on config
without the previous run's aborted signal deciding the outcome. The pump then runs stream → tool
phases → finalize exactly once.

| Current encoding | Target task |
|---|---|
| comment-only in `run-agent` + `RunFinalizer` ordering, `validate:run-stream-recovery`, `validate:agent-run-finalization` | T1 (`RunPhase`), E1 |

### I3. Teardown is ordered

Stop producers → settle the session switch → destroy extensions → destroy background work →
close/await persistence → flush logs → release ownership. A failure in one step must not skip the
rest.

| Current encoding | Target task |
|---|---|
| comment-only + per-step try/catch in `lifecycle-coordinator`, `validate:lifecycle-coordinator` | S7 (switch phases), T1 |

## Sessions

### I4. One live owner per disk session

An ownership claim exists for exactly one live agent; a claim is released only by its owner, and a
failed create/restore must not release another process's claim.

| Current encoding | Target task |
|---|---|
| `SessionOwnership` map + `validate:session-ownership`; reservation/placeholder outside it | S1–S3 |

### I5. The switch commits once

`unload → restore target → commit → reset transient → rebind sidecars → release leaving`. Before
commit the leaving session is authoritative; after commit the target is; exactly one of them is
current at any observation.

| Current encoding | Target task |
|---|---|
| comment-only "COMMIT — the one adoption" in `managed-agent-session`, `validate:session-switch-safety`, `validate:session-branching` | S7, S10 |

### I6. Restore repairs are persisted before the baseline resets

Read-side repairs (background command/task/tool-call settlement) must be written to disk before
the sync tracker treats the repaired transcript as persisted.

| Current encoding | Target task |
|---|---|
| partial: `saveRestoredMessages` + `validate:session-restore-state` | S5 |

### I7. Background work ends with the session

A session switch awaits killing/reset of command jobs and background tasks; a terminal un-notified
item is kept for the next resume, a running one is settled (killed/cancelled) with the shared
reason.

| Current encoding | Target task |
|---|---|
| `BackgroundWorkService` facade + per-source epochs, `validate:background-task`; reset is fire-and-forget | S8 |

## Runs and state

### I8. One run currency

Every async continuation captures one epoch (session generation + run token + lifecycle
generation) and checks it before writing. A non-current continuation performs no observable work.

| Current encoding | Target task |
|---|---|
| 9 mechanisms (RunToken, lifecycleEpoch, session generation, `isSessionSwitching`, `stillOn*`, abort identity, compaction lease, background epoch, extension lease), `validate:session-staleness` | E1–E10 |

### I9. State is a projection of three axes

`LifecyclePhase × RunPhase × WaitKind → AgentStatus`. Terminal/active are derived, not overlapping
sets; a run paused on the user is waiting, not simultaneously terminal and active; a failed turn
with an unanswered question projects `awaiting_user`.

| Current encoding | Target task |
|---|---|
| 10-value enum + 23 triggers, overlapping `TERMINAL/ACTIVE`, `validate:agent-status`, `validate:approval-batch-resume` | T1–T9 |

### I10. Compaction is an exclusive operation, not a status

A compaction lease (auto/manual/reactive) owns the operation; exactly one producer applies a
checkpoint; a superseded lease can neither apply nor restore status.

| Current encoding | Target task |
|---|---|
| `CompactionController` lease, `validate:compaction-*`, `validate:manual-compact-interlock` | T6 (+ S1 operation lease) |

## Permissions

### I11. One authorization decision per call

Availability → hard policy → auto modes → declarative requirement → command analysis → extension
hooks → persisted decision. Earlier stages win; the decision is recorded once with its source;
only an answered decision is resumable.

| Current encoding | Target task |
|---|---|
| 13 gates, three decision representations, `validate:approval-decisions`, `validate:command-safety*`, `validate:auto-mode-approvals`, `validate:plan-verification` | A1–A10 |

### I12. Hard policy outranks auto-approval

Auto mode and plan execution may skip the prompt, never a hard deny (subagent external path,
env override, destructive rule, missing annotations). Fail closed when a requirement is unknown.

| Current encoding | Target task |
|---|---|
| partial: `evaluateCommandApproval` + per-mode branches; `validate:command-safety-portability`, `validate:auto-mode-approvals` | A3–A7 |

### I13. Plan/auto modes are mutually exclusive and single-sourced

Entering one clears the other; persistence stores one mode snapshot; plan execution auto-approval
requires `todosSeeded`. Readers use `ModeState`, not controllers.

| Current encoding | Target task |
|---|---|
| `ModeCoordinator` enforces exclusivity; 70+ direct reads; `validate:mode-coordinator` | M1–M5 |

## Extensions

### I14. A registration is a lease

One context per incarnation; every registration surface checks liveness; disable revokes the
lease before slow teardown and removes artifacts before awaiting `deactivate()`; re-enable gets a
new context and clears the disabled notice.

| Current encoding | Target task |
|---|---|
| partial: `context-factory` lease + `validate:extension-lifecycle-lease`, `validate:extension-tool-restore`, `validate:extension-disable-notice` | extension state enum (extension task) |

## Observability

### I15. One event, one record

Telemetry events carry identity from the emitter (agent/session/run); the log bridge maps them
through one policy table; internal/projection events are withheld from the wildcard consumer.

| Current encoding | Target task |
|---|---|
| structured: `AgentEventBus` + `AgentLog` + `validate:event-log-bridge`, `validate:agent-event-envelope` | none (do not converge further) |

## Rules

1. When a task makes an invariant structural, update its status and remove the prose it replaces.
2. A new control-plane rule starts here as **comment-only**; it becomes a validator or a type
   before it becomes a convention.
3. An invariant that only exists in a comment and has no validator is a review risk: name it here
   before relying on it.
