# Change: Keep pre-forked `task` subagents alive across an input-pausing invocation

## Why

When one model turn contains both `task` calls and a tool that needs approval (or a client tool such
as `ask_user`), every pre-forked subagent is thrown away *before* its own tool phase can join it. The
tool phase then spawns a second subagent for the same call id, so the session's task panel lists the
abandoned attempt next to the live one — observed as `Tasks (4 total, 2 active)` for two `task`
calls. Each orphan has already paid an LLM request at the moment it was killed, and because
pre-forked subagents are created with `autoDestroy: false` they stay in the catalog for the rest of
the session (`total` stays inflated; `active` is unaffected).

Cause, verified from source + logs + a control experiment (details in `design.md`): a `beforeTools`
interrupt — which is how an approval or client-tool wait is implemented — **ends the TanStack
`chat()` invocation**, so the `task-prefork` middleware's `onFinish` runs while the run has merely
*paused*. That hook is documented as a per-invocation boundary (`lifecycle-middleware.ts` states
turn finalization is owned by `AgentChatController.pumpToolPhases`, "not per-`chat()` finish"), and
the registered pre-forks are meant to be joined by the tool phase of the **next** pump. Discarding
them at that point is not "early" — it is wrong.

## What Changes

- **`task-prefork` stops discarding at a pausing invocation.** `onFinish` keeps its discard duty for
  a run that is actually over, but skips it when the invocation ended because the run is waiting for
  user input. The abandonment boundaries (`onAbort`, `onError`) and the restart path are unchanged.
- **The pause test reuses the controller's own predicate.** The wait/continuation helpers in
  `agent/stream/tool-phase-utils.ts` already decide whether a follow-up pump will run; the middleware
  consults the same rule instead of a second, hand-rolled notion of "is the run waiting". This covers
  the approval wait *and* the `ask_user` client-tool wait (which a status-only check would miss), and
  is race-free if the user answers while the invocation is unwinding.
- **A surviving pre-fork stays abortable.** The parent-abort binding a pre-fork captures is replaced
  when the next pump sets up its own run controller, so a pre-fork that outlives its invocation is
  additionally registered on the run's existing abort surface (`RunCoordinator.addPendingAbortController`).
- **Two comments are corrected** to match reality: the app's `task-subagent.ts` asserts the orphan
  root cause "is fixed in core" (true for the iteration-boundary generation, not for this one), and
  `subagent-stop-reason.ts` describes the approval pause as a stream restart.
- **Coverage.** `validate:task-prefork` gains the pause cases (approval wait, client-tool wait, and
  the "no join and no wait ⇒ discard" case), and its source assertion is updated to the new shape.

Not a breaking change: no API, schema, or tool-output shape changes. What the model sees for a `task`
call is identical in the healthy path; the difference is that the orphan path stops happening.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `task-concurrency`: adds the pre-fork lifetime contract — a registered run survives an invocation
  that pauses for input and is joined by the tool phase of the next pump, and a pre-fork that
  outlives its invocation remains reachable by the run's abort.

## Impact

- Affected code:
  - `packages/core/src/managers/middleware/task-prefork-middleware.ts` (discard condition, abort-surface registration)
  - `packages/core/src/managers/controllers/agent-chat-controller.ts` — read-only reference for the pump loop; only touched if the predicate needs a shared export
  - `packages/core/scripts/validate-task-prefork.mjs` (new cases + updated source assertion)
  - `packages/app/src/utils/task-subagent.ts`, `packages/core/src/agent/subagent/subagent-stop-reason.ts` (comments)
- Unchanged: the concurrency cap/queue semantics, the queued-run admission contract, the
  `onAbort`/`onError`/restart discard paths, and the `subagent:prefork-discarded` event shape.
- Behavior: an approval-bearing or client-tool-bearing turn no longer wastes one LLM request per
  `task` call, and the task panel stops accumulating orphan rows for the session.
