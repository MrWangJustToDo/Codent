## 1. Pause-aware discard

- [x] 1.1 Add a `runIsPausingForInput(messages)`-style predicate next to the existing continuation
  helpers in `packages/core/src/agent/stream/tool-phase-utils.ts`, composed from
  `hasPendingToolApprovals` / `hasPendingAskUser` / `needsToolPhaseContinue` (the same rule
  `AgentChatController` uses to decide whether to pump again). Document that this predicate and the
  controller's `shouldKeepPumping` must stay one rule.
  → landed as `hasPendingRunContinuation` (the task's suggested name under-described the
  answered-but-unexecuted half), with the doc stating explicitly why it is NOT
  `shouldContinueAgentPump`: `needsAgentResponseAfterTools` covers a turn whose tools already ran.
- [x] 1.2 In `task-prefork-middleware.ts`, gate the `onFinish` discard on "not pausing", resolving
  messages through the live chain — `managed.getChatController()?.getMessages()` first, then
  `managed.getUI()?.getMessages()`, then `deps.getUIChannel?.()?.getMessages()` — and defaulting to
  **not** discarding when none is available. Keep the existing
  `discardRegistered(managed, "run-finish")` call shape (see 3.1).
  → the controller-first order is the repo's convention for the live chain, and the three are the same
  object here (`AgentChatController` calls `setUIChannel(this.channel)`), so this is a stated
  preference rather than a behavioural difference.
- [x] 1.3 Update the middleware header comment: `onFinish` is a per-`chat()`-invocation boundary
  (`lifecycle-middleware.ts` owns the run boundary note), and name the pause rule + why the pause must
  not discard.
- [x] 1.4 Update `task-prefork.ts`'s `discardRegisteredPrefork` doc comment to state that the run
  boundaries discard *only* when no joining tool phase is pending.

## 2. Surviving pre-fork stays abortable

- [x] 2.1 Register each pre-fork's controller with the parent run's pending-abort surface
  (`RunCoordinator.addPendingAbortController`) in `task-prefork-middleware.ts`, and remove it in the
  existing `cleanup` callback alongside the parent-signal listener.
  → registered at ADMISSION inside `runPreForked` and removed in the same `finally` as `cleanup`,
  rather than at spawn: a pre-fork discarded while still queued never reaches `runPreForked`, so a
  spawn-time registration would have no path that deregisters it.
- [x] 2.2 Confirm by reading `run-coordinator.ts` that both `abort()` and the host-supplied
  `abortSignal` listener drain that list, and note the belt-and-braces relationship with
  `ManagedAgent.cascadeAbortToChildren` in the code comment.
- [x] 2.3 **Gap found in review of 1.2.** The stream hooks cannot cover a run aborted while PAUSED:
  upstream calls `runOnAbort` only from inside a `chat()` invocation (`index.ts:1474-1485` and that
  invocation's `finally` at `:1498-1510`), and a wait is exactly what ended it — so a paused run
  abandoned by Esc / force-submit / session switch / destroy reaches no terminal hook, and the eager
  runs stayed registered (and streaming) until a later run reported them as its own orphans.
  Discard at the abort funnel instead: `ManagedAgent.abort()` →
  `discardRegisteredPrefork(this, "run-abort", …)`, beside `cascadeAbortToChildren`. Closed there
  rather than in `interruptCurrentRun`, which is only one of the callers
  (`AgentManager.destroyAgent` and the local-session dispatch stop do not pass through it).

- [x] 2.4 **Second review round (measured with a probe over the real `ManagedAgent`).** Two more seats
  abandoned a run without reaching `abort()`, so the pause-keep leaked there: `ManagedAgent.reset()`
  (`/clear`, new session → `RunCoordinator.resetRunState`, no agent abort) and a session switch while
  PAUSED (`stopIfActive`'s `pumpDepth <= 0` guard returned before `interruptCurrentRun`). The switch
  seats were the worse ones — nothing aborted the eager run's controller either, so its subagent kept
  streaming into the transcript replacing its own.
  Closed at the seats: a private `discardRegisteredPreforkRuns()` (non-creating) called from
  `abort()` and `reset()`, plus `stopIfActive`'s guard now treating a registered pre-fork as "still
  active" (which closes every caller of a session switch at once, the controller method included).
  Covered by `validate:run-abort-ownership` §5 over four seats.

- [x] 2.5 **Third review round (found while closing the change).** The deferral at `onFinish` had no
  second half for a turn whose only pending call could not run: a `task` call whose arguments never
  finished streaming is settled as `error` by `cancelIncompleteToolCalls`, so no tool phase joins its
  pre-fork, and the turn-end boundary collected nothing — the eager subagent ran on unobserved (three
  pre-forks, zero discards in the session that surfaced it). The pump's turn end now discards with
  cause `run-finish` (skipped for a WAIT, which is the case that continues the run); the predicate was
  deliberately NOT narrowed, because the pump needs that phantom continuation to settle the dead call
  at its entry. Covered by `validate:run-abort-ownership` §5 (a fifth seat) and §6 (the call site).
## 3. Correct the documentation that now asserts the wrong thing

- [x] 3.1 Rewrite the header of `packages/app/src/utils/task-subagent.ts`: the read-side resolver is
  defence-in-depth; the iteration-boundary orphan it describes was fixed, but an approval/client-tool
  pause produced a second generation of the same shape, and the panel is the surface the resolver does
  not cover.
- [x] 3.2 Reword the `parent-run` row of `subagent-stop-reason.ts`'s taxonomy table: the approval
  pause is an invocation that ended on a wait, not a stream restart.

## 4. Validation

- [x] 4.1 Update the source assertion in `packages/core/scripts/validate-task-prefork.mjs` (~`:233-237`)
  to the new `onFinish` shape, so it still fails if the discard call is dropped rather than made
  conditional.
  → asserts the guard, the discard, and that the guard returns BEFORE the discard; plus `onAbort` /
  `onError` carrying their cause and NO guard.
- [x] 4.2 Add predicate cases: approval pending ⇒ no discard; `ask_user` pending ⇒ no discard;
  approval answered but tool not yet executed ⇒ no discard; nothing pending and no continuation ⇒
  discard reported with cause + subagent ids.
  → predicate cases (5 shapes) + the call site driven through the real middleware with a fake
  `ManagedAgent`: keep on a wait, discard+report on a finished run, keep when no channel is readable.
- [x] 4.3 Add a case that a pre-fork spanning a pump boundary is still aborted by a run-level abort
  (2.1), and that `onAbort` / `onError` / the restart path still discard unconditionally.
- [x] 4.4 Assert the cap/queue requirements are untouched: a covered invocation still admits up to the
  cap and a queued run still starts only on admission.

## 5. Verification

- [x] 5.1 `pnpm build:core` then `pnpm --filter @codent/core tsc --noEmit`,
  `node packages/core/scripts/validate-task-prefork.mjs`.
- [x] 5.2 Full gates: `pnpm exec eslint <changed files>`, `node scripts/run-all-validators.mjs --dir
  packages/core`, `pnpm --filter @codent/app test` — lint + typecheck clean, core 187 passed / 0
  failed / 2 skipped, node 6/0, app 118/0.
- [ ] 5.3 **Not run by hand.** The reported repro (one turn with two `task` calls plus an
  approval-requiring tool) was never re-run interactively — this item is what prompted the log
  archaeology that found 2.5 instead, and the only post-fix session with pre-forks turned out to be
  the *broken* shape (no tool phase ever joined them), not the fix's shape. What covers the behaviour
  without it: `validate:task-prefork` drives the real middleware against a real message chain (a
  pending approval keeps the runs; an invocation with nothing pending discards), `validate:run-abort-ownership`
  drives all five abandonment seats, and 2.5 added the call-site assertion for the turn end. Left
  unchecked on purpose: nothing here re-ran the interactive repro, and a tick would say otherwise.
  and confirm in `.agents/logs/<session>/agent.log`: no `subagent:prefork-discarded`, exactly one
  `Tool start: task (pre-fork)` + one `Tool start: task` per call id, and one subagent per call id in
  the session's task panel.
  → **not run from here**: it needs an interactive turn that pauses on an approval, which the
  validator suite cannot drive. The mechanism is covered at the call site (see 4.2) and the primary
  message source is asserted to be the chain the wait was detected on; the log/panel confirmation is
  a manual step for the reviewer.
- [x] 5.4 Confirm the abandonment paths still report: abort mid-run, a run error, and a restart-style
  retry each still emit `subagent:prefork-discarded` with the right cause.
  → `onAbort` / `onError` driven through the middleware (discard + cancel even with a wait pending);
  the restart path asserted at its call site.

## 6. Reviewer notes

- **Non-vacuity**: each new value case was run against the pre-fix code (the relevant file stashed,
  core rebuilt) — the four call-site assertions in `validate:task-prefork` fail without the discard
  guard, and `validate:run-abort-ownership`'s new case fails without the abort-funnel discard
  (`a run abort discards the registered pre-fork`). Nothing in 4.x passes without the change.
- **Where the new coverage lives**: the pause rule + the middleware call site are in
  `validate:task-prefork`; the abandonment seats are in `validate:run-abort-ownership` (section 5,
  table-driven over `abort()` / `reset()` / `stopActiveRun()` / direct `stopIfActive()`), because that
  validator owns the run-abort funnel and already builds a real `ManagedAgent` to drive it — a second
  harness for the same thing would be the drift this change is about.
- **The seat inventory is not enforced, deliberately.** Section 5 enumerates today's seats; a *new*
  way to abandon a run would need to be added to it by hand. A source scan for "another place that
  abandons a run" cannot be written honestly, and the alternative — funnelling every abandonment
  through one method — is the run-vs-agent registry redesign D6's alternative would need.
- **Behaviour when no channel is readable** (a host that passes neither `getUIChannel` nor an agent
  channel): the discard is skipped, so such a host keeps a stranded pre-fork until an abort. Chosen
  deliberately — a stranded run is recoverable, a discarded one is not — and unreachable for the
  hosts in this repo (every chat agent wires a channel).
- **Pause-time semantics** (deliberate): while the parent waits for an approval, its pre-forked
  subagents keep streaming. That is the point (it hides the wait), and a denied approval does not
  cancel the `task` — a different tool call.
