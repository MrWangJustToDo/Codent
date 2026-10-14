## Context

### The pre-fork contract as built

`task` calls are started **eagerly**: `task-prefork-middleware` watches `TOOL_CALL_END`, and at that
moment `TaskPreforkCoordinator.start()` admits the run (rolling FIFO window, cap 4) so the subagent
begins while the model is still streaming the rest of the turn. The tool phase later joins the
already-running promise by call id (`task-tool.ts:180`), so the run is never executed twice. The
coordinator is cached per parent agent (`WeakMap` in `task-prefork.ts`), so it — and its registered
runs — outlive a single `chat()` invocation.

Discards exist because a registered run whose tool phase will never arrive would keep streaming
unobserved. They live in exactly four places:

| Place | Cause | Fires when |
|---|---|---|
| `task-prefork-middleware.ts:121-125` | `run-finish` | the `chat()` invocation ends |
| `task-prefork-middleware.ts:126-130` | `run-abort` | the invocation is aborted |
| `task-prefork-middleware.ts:134-138` | `run-error` | the invocation fails |
| `run-stream-recovery.ts:375-391` | `run-start` | a restart-style retry replaces the attempt |

All four funnel through `discardRegisteredPrefork` (`task-prefork.ts:328-336`), which is what makes
the discard reportable (`subagent:prefork-discarded` carries the call id, the cause, and the
subagent ids it orphaned).

### What was observed

Session `ses_mv5gxmkr_gt2ns0`, run `gz0x8iqb`, two `task` calls in one turn. The task panel showed
four rows for two calls: two `⊘ (aborted)` and two live. The log shape, in ms from the run's
`prompt:submit`:

```
33585  Tool start: task (pre-fork)   call_01_…2408
33606  Subagent started 审查 read_file…            → subagent_mv6lpgiy_tw9vzi
35699  Tool start: task (pre-fork)   call_02_…9679
35718  Subagent started 审查 containment…          → subagent_mv6lpi5n_77sl1z
35748  Status: running → waiting  (approvals-pending)
35749  Approval requested: run_command  call_00_X3Mn…
35776  llm:response  finishReason: tool_calls      ← onFinish fires here
35778  Pre-fork discarded (run-finish) ×2          ← approval still pending
35783  Approval resolved (approved)
35856  Tool start: task ×2                         ← second generation spawned
35860  Subagent created mv6lpia1 / mv6lpia2        ← the ones that actually run
```

Both killed subagents had already issued one `llm:request` and were then `running → aborted` with
`stopReason: "parent-run"` — one wasted provider call each.

### Mechanism

1. The turn streams two `task` calls and one `run_command`. At each `TOOL_CALL_END` the middleware
   pre-forks a subagent; the `run_command` call is recorded as needing approval, which flips status
   to `waiting` (`agent-status-controller.ts:202-213`).
2. TanStack reaches the `beforeTools` boundary with that approval still pending and emits an
   interrupt; `emitBoundaryInterrupts` returns true, so it sets `toolPhase = 'wait'` and returns
   (`@tanstack/ai@0.68.0` `src/activities/chat/index.ts:2209-2220`). codent's side of this is
   `agent/approval/tool-approval-table.ts:174` — "Pending rows are omitted so `executeToolCalls`
   still interrupts".
3. Leaving the agent loop that way runs the terminal hook (`index.ts:1436` → `runTerminalHook()` at
   `1234`), which is `onFinish`. Upstream states the rule outright: *"A client-tool or approval wait
   ends this server-side chat invocation."* (`index.ts:1432`).
4. The invocation that ends at a `wait` is **not** the end of the run. `AgentChatController.pumpTool
   Phases` treats every approval/client-tool wait as a *pump boundary*: it breaks out when
   `hasPendingToolApprovals` / `hasPendingAskUser` (`agent-chat-controller.ts:413-414`), and a later
   pump — after the answer arrives — runs the tool phase that joins the pre-forks.
5. `task-prefork-middleware`'s `onFinish` discards anyway, because it treats `onFinish` as a run
   boundary. The next pump's tool phase finds nothing registered, `join()` returns `null`
   (`task-prefork.ts:220-225`), and a **second** subagent is spawned for the same call id. The
   orphaned first one stays in the catalog (`autoDestroy: false`), and the panel lists both.

The contract this violates is written down twice in the repo: `lifecycle-middleware.ts:5-6` says
turn-level finalization "is owned by `AgentChatController.pumpToolPhases` / detached runners — **not
per-`chat()` finish**", and `subagent-stop-reason.ts:11` lists the approval pause as a known cause of
this exact stop. This is also the **second** generation of the same mistake: the previously fixed
orphan came from discarding on `RUN_STARTED` (which fires per model iteration, not per run), and
`task-subagent.ts:4-9` still asserts the orphan "is fixed in core".

### Evidence that the pause is the trigger

Every session in the workspace log corpus that pre-forked a `task`, with "approval requested inside
the window from the first pre-fork start to the tool phase's `task` start" as the discriminator:

| Session | Pre-forks | Approvals in window | Discards |
|---|---|---|---|
| `ses_mv25wxe5_cvy16p` | 4 | 0 | 0 |
| `ses_mv26fqpd_05r32v` | 1 | 0 | 0 |
| `ses_mv26qfes_np76kx` | 1 | 0 | 0 |
| `ses_mv28b6xr_xm2yev` | 3 | 0 | 0 |
| `ses_mv2i1dr4_50il6f` | 8 | 0 | 0 |
| `ses_mv5gxmkr_gt2ns0` | 2 | **1** | **2** |

The five healthy sessions also show `llm:response = 0` inside that window — i.e. `onFinish` does not
fire at a normal model-turn boundary, only at the interrupt. (Methodology note for anyone re-reading
the logs: `grep prefork-discarded` over `.agents/logs` hits 15 lines, but only 2 are events
(`"event":"subagent:prefork-discarded"`); the rest are grep output and edit previews quoted inside
tool payloads.)

### Why the existing read-side guard does not hide this

`packages/app/src/utils/task-subagent.ts` already resolves a `task` row to "the live row, latest on a
tie", which is why the *tool row* in the transcript looked right. That resolution is applied to a
single call id; the **panel** renders `snapshot.subagents` directly
(`local-session-snapshot.ts:30-38`), so the same root cause shows up there and nowhere else.
`SubagentListPanel.tsx:112,122` computes `{tasks.length} total, {activeCount} active` — `total` is
the inflated number (`4` vs `2`); `active` was correct.

## Goals / Non-Goals

**Goals:**

- A registered pre-fork survives an invocation that ends because the run is pausing for input
  (approval or client tool), and is joined by the next pump's tool phase.
- The pause test and the controller's "will another pump run?" decision cannot drift apart.
- A pre-fork that outlives its invocation remains reachable by the run's abort.
- The failure is pinned by `validate:task-prefork`, including the negative case (a run that ends with
  no join and no wait still discards).

**Non-Goals:**

- Changing the concurrency cap, the FIFO queue, or the "a queued run does not start until admitted"
  contract (`task-concurrency`'s existing requirements).
- Changing the `subagent:prefork-discarded` payload or the stop-reason taxonomy.
- Making abandoned pre-forks cheap to *sync* to the panel (the panel is already reporting the catalog
  faithfully; after this change the orphan simply stops existing).
- Removing the discard from `onFinish` entirely (see D1 alternative).

## Decisions

### D1 — Keep the discard point; make it not fire on a pausing invocation

`onFinish` keeps `discardRegisteredPrefork(managed, "run-finish")`, but only after confirming the run
is not merely waiting. The stream's other abandonment hooks (`onAbort` / `onError`) stay
unconditional, since there is no later pump to join the runs.

*Measured, not assumed:* the stream hooks are **not** sufficient on their own. TanStack calls
`runOnAbort` only from inside a `chat()` invocation — a `MiddlewareAbortError` path
(`index.ts:1474-1485`) and that invocation's own `finally` when it is cancelled
(`index.ts:1498-1510`). A wait ENDS the invocation, so a run aborted while paused for an
approval/client tool reaches neither hook, and an eager run left registered there would stream on
until some later run reported it as an orphan of a run that never spawned it. That closure is D6.

*Alternative considered:* stop treating `onFinish` as a run boundary at all and discard from the real
turn-finalize seam (`pumpToolPhases` outcome). Cleaner in principle, since `onFinish` is documented as
per-invocation — but the run's true end is itself per-pump (`resetTurnLifecycle()`/`finalizeRun` run
per pump), so it buys no accuracy here while adding a new seam from the controller into the
subagent coordinator, and it would have to keep an `onFinish` fallback anyway for hosts that pump
outside `AgentChatController`. Deferred; can follow in its own change if we later want `onFinish` out
of the discard story entirely.

### D2 — The pause test is the controller's continuation rule, not a status string

The predicate is "the run is waiting for input, or the tool phase for a registered call has not run
yet": `hasPendingToolApprovals(messages) || hasPendingAskUser(messages) || needsToolPhaseContinue(messages)`
— the same helpers in `agent/stream/tool-phase-utils.ts` that `AgentChatController` uses to decide
whether to pump again (`shouldKeepPumping`, `agent-chat-controller.ts:358-360`). Messages come from
the live channel (`managed.getUI()?.getMessages()`, falling back to `deps.getUIChannel?.()`), which is
where approval state actually lives — `ChatMiddlewareContext.messages` is `ModelMessage[]` and does
not carry it, and `onFinish`'s `info` (`{ finishReason, duration, content, usage }`,
`index.ts:1266-1276`) has no pause signal at all.

Why not a status check (`getStatus() === "waiting"` / `getPendingApprovalCount() > 0`), which is the
obvious shape: it **misses the `ask_user` client-tool wait** (`status === "awaiting_user"`,
`agent-status-controller.ts:229-231`) that ends the invocation for exactly the same reason per the
same upstream rule, and it is **racy** — if the answer lands while the invocation is unwinding,
status is already back to `running` and the count is back to `0`, so the discard fires and the orphan
returns. `needsToolPhaseContinue` covers the answered-but-unexecuted case (`hasApprovalResponded
ToolsPendingExecution`) and is race-free.

Reusing these helpers also gives the negative case for free: nothing pending and no continuation
left ⇒ the discard is correct.

### D3 — A surviving pre-fork is registered on the run's abort surface

The middleware captures the parent run's abort signal at pre-fork time
(`task-prefork-middleware.ts:174`) and forwards its *reason* to its own controller. That binding
outlives its usefulness across a pump boundary: each pump's `prepareForRun` →
`RunCoordinator.setupAbortController` (`run-coordinator.ts:38-51`) installs a **new**
`currentAbortController` and merely detaches the old one's listeners (it does not abort it), so a
pre-fork born in pump N is bound to a signal that will never fire once pump N+1 starts.

Mitigation: alongside the signal listener, register the pre-fork's own controller with
`RunCoordinator.addPendingAbortController(controller)` (`run-coordinator.ts:83-89`), removed in the
existing `cleanup` callback. `RunCoordinator.abort()` and the host-supplied-`abortSignal` listener
both drain that list (`run-coordinator.ts:67-74, 100-108`), so the surviving pre-fork is reachable by
every run-level abort regardless of which pump spawned it. This is the same seam `webfetch` /
`websearch` already use for tool-scoped controllers, so it adds no new mechanism.

Note this is belt-and-braces, not the only protection: `cascadeAbortToChildren` reaches an active
child by manager lookup even with a stale signal, which is why a user `Esc` already stops a surviving
pre-fork (with the parent's reason, so the stop-reason classification stays correct). The gap the
registration closes is the run-level abort that does *not* cascade (a host-passed `abortSignal`).

### D4 — The reported cause keeps its current spelling

A real run-end discard keeps `cause: "run-finish"`; `run-abort` / `run-error` / `run-start` are
untouched. A pause no longer produces a discard at all, so no new cause value is needed and the
`PreforkDiscardCause` union, the `subagent:prefork-discarded` payload, and the log-bridge rendering
stay as they are.

### D5 — Correct the two comments that now assert something false

- `packages/app/src/utils/task-subagent.ts:4-9`: "the root cause of the orphan … is fixed in core" is
  true only for the iteration-boundary generation. Rewrite to describe the read-side guard as
  defence-in-depth and name the surviving trigger it does not (and should not) hide — the panel.
- `packages/core/src/agent/subagent/subagent-stop-reason.ts:11`: "the approval pause that also
  restarts the run" conflates a pump boundary with a stream restart. Name it as an invocation that
  ended on a wait.

### D6 — Abandonment is closed at the seats, not one caller

Keeping the run across a pause moves the leak window: the pause discards nothing, so something must
still own "this run is over" when the run is abandoned instead of answered. The stream hooks cannot —
per D1, `onAbort` needs a live invocation, and the wait is exactly what ended it.

Measured, with a probe that seeds a registered pre-fork on a real `ManagedAgent` (entry registered on
the run's abort surface, as the middleware does at admission) and then abandons the run:

| Seat | entry reclaimed | run cancelled | reported |
|---|---|---|---|
| `ManagedAgent.abort()` | ✓ | ✓ | `run-abort` |
| `ManagedAgent.reset()` (`/clear`, new session) | ✗ → **✓** | ✗ → **✓** | — → `run-abort` |
| `stopActiveRun()` (session switch, paused) | ✗ → **✓** | **✗ → ✓** | — → `run-abort` |
| `chat.stopIfActive()` (direct) | ✗ → **✓** | **✗ → ✓** | — → `run-abort` |

The session-switch seats were the worse two: with no pump and no guard hit, nothing ever aborted the
eager run's controller either, so the subagent kept streaming into the transcript that was replacing
its own. (`reset()` did stop the subagent — `RunCoordinator.resetRunState` drains the abort surface
the pre-fork registers on — leaving only the registry record to be misreported by a later run.)

Decisions:

- **`ManagedAgent.reset()`** discards through the same private helper `abort()` uses
  (`discardRegisteredPreforkRuns`, non-creating so a plain reset allocates nothing).
- **`stopIfActive`'s guard** stops treating `pumpDepth === 0` alone as "idle". A registered pre-fork
  means something IS still writing into the channel this method exists to protect, so the run is
  interrupted — which lands on `abort()` and therefore on the discard. This is the seat that closes
  every caller of a session switch at once (the controller method itself, so no future caller can
  reach it unguarded).
- **Seat inventory** (kept in one place so it can be re-derived): `abort()` — Esc / force-submit /
  host stop / destroy; `reset()` — `/clear`, new session; `stopIfActive` — session switch and
  `/clear` in place; the pump finalizing a turn with cause `run-finish` — the deferred
  `onFinish`; `prepareRestartStyleRetry` — stream restart (already had `run-start`); stream
  `onFinish` / `onAbort` / `onError` — live-invocation boundaries.
- A run that reaches **no** seat and no hook (a host that tears the process down) needs nothing: the
  coordinator is in-memory and per-agent, so it dies with the process.
- **The list was one seat short, and the review that closed this change found it.** `onFinish` defers
  the discard whenever a tool call is pending, on the assumption that the tool phase is about to join
  the pre-forks. A call whose arguments never finished streaming cannot run — `cancelIncompleteToolCalls`
  settles it as `error` — so nothing joins them and the turn simply ends: the deferred discard had no
  second half, and the eager subagent kept running with nobody to collect it. Observed in a real
  session (three pre-forks, zero discards, the subagents never reported an outcome), which is what made
  "the seat list is hand-written and a new abandonment path will not be discovered on its own" concrete
  rather than theoretical. `HasDeferredToolExecution` stays as it is: the pump needs the phantom
  continuation to *settle* those dead calls at its entry, so the fix is the missing seat, not a narrower
  predicate.

Consequences: a paused run abandoned by any of those now discards deterministically with the cause a
mid-stream abort already used (no vocabulary change), and the stream's `onAbort`, if it fires
afterwards, finds nothing registered and reports nothing — no duplicate report.

## Risks / Trade-offs

- **A pre-fork now runs while the user is deciding.** That is the intent (it hides the wait), but it
  changes what the panel shows during a pause: a subagent streaming while the parent is `waiting`.
  Consequence: a deny does not cancel the `task` (it is a different tool call), which matches how a
  `task` behaves next to any other approval.
- **Predicate coupling.** The middleware now depends on `tool-phase-utils`. That is deliberate
  (one rule for "will another pump run"), but it means changing those helpers changes the discard
  policy — worth a line in the helper's doc rather than a second implementation.
- **Channel availability.** `deps.getUIChannel` is optional and only some hosts pass it; the predicate
  resolves messages through `managed.getUI()` first so it does not silently degrade to "always
  discard" on a host that omits the dep. If neither is available the safe answer is **not** to
  discard (a stranded run is recoverable by abort; a discarded run is not).
- **Validator coupling.** `validate-task-prefork.mjs:233-237` asserts by source regex that
  `onFinish`/`onAbort`/`onError` each call `discardRegistered(managed, "run-…")`. The conditional
  discard must either keep that call shape or the assertion must be updated in the same commit;
  silently dropping the call would make the validator fail for the right reason but for the wrong
  message.
- **Reason drift, accepted.** For a pre-fork that outlives its invocation, the parent-signal
  forwarding can be stale, so an abort may arrive via the child cascade with `parent-aborted` instead
  of the parent's own reason. Both classify as `parent-stop`/`parent-run`-family, so no user-visible
  notice changes; recorded here so it is a stated consequence rather than a later surprise.

## Migration Plan

None required. The coordinator's registry is in-memory and per-agent; there is no persisted state,
no session-schema field, and no wire or tool-output change. Rollback is a revert of one middleware
condition plus the registration call.

## Open Questions

- Should the `onFinish` discard be removed entirely (D1 alternative) once the pump-boundary predicate
  exists, or is keeping it the cheaper guarantee against a host that pumps outside
  `AgentChatController`?
- Do we want a test-only host that answers an approval *while* an invocation is unwinding, to pin D2's
  race argument? The `validate:task-prefork` cases cover the predicate directly; the race is the part
  that would need a fake clock/scheduler to exercise end-to-end.
