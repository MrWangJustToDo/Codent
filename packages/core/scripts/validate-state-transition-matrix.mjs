/**
 * Full state-transition matrix: every wire status round-trips, every event has an allowed or
 * rejected transition, and the controller's sequences match the pure state machine.
 *
 * It covers the model (projection round-trip, transition table), the old-status equivalence, and
 * drives the real controller (not a status-string mock), so a writer that bypasses the axes fails
 * here.
 *
 * Run: pnpm --filter @codent/core run validate:state-transition-matrix
 */

import assert from "node:assert/strict";

import {
  createAgentStatusController,
  deriveAgentState,
  INITIAL_AGENT_STATE,
  isActiveState,
  isParkedStatus,
  isStickyStatus,
  isTerminalState,
  projectAgentStatus,
  resolveFinishStatus,
  transition,
} from "../dist/dev.mjs";

const STATUSES = [
  "idle",
  "running",
  "completed",
  "error",
  "aborted",
  "waiting",
  "awaiting_user",
  "compacting",
  "thinking",
  "responding",
];

// --- old status ⇄ axes equivalence -----------------------------------------
for (const status of STATUSES) {
  for (const error of ["", "boom"]) {
    const state = deriveAgentState(status, error);
    assert.equal(projectAgentStatus(state), status, `${status} (error=${JSON.stringify(error)}) round-trips`);
    const expectedTerminal = status === "error" || status === "aborted";
    assert.equal(state.outcome === "error" || state.outcome === "aborted", expectedTerminal);
  }
}

// `resolveFinishStatus` keeps a terminal/parked/compacting turn and settles the rest.
for (const status of STATUSES) {
  const state = deriveAgentState(status, "");
  const expected =
    state.outcome === "error" || state.outcome === "aborted" || state.wait !== "none" || state.run === "compacting"
      ? status
      : "completed";
  assert.equal(resolveFinishStatus(status, ""), expected, `resolveFinishStatus(${status})`);
}
assert.equal(resolveFinishStatus("running", "boom"), "error");
assert.equal(resolveFinishStatus("completed", "boom"), "error", "a settled turn may still record a late fault");
assert.equal(resolveFinishStatus("waiting", "boom"), "waiting", "a parked run is not failed by a finish");

// --- transition matrix: allowed and rejected events -------------------------
const idle = deriveAgentState("idle");
assert.equal(projectAgentStatus(transition(idle, { type: "prepare" })), "running");
assert.equal(projectAgentStatus(transition(idle, { type: "stream-chunk", stream: "thinking" })), "thinking");
assert.equal(projectAgentStatus(transition(idle, { type: "pause", wait: "approval" })), "waiting");
assert.equal(projectAgentStatus(transition(idle, { type: "fail", error: "x" })), "error");
assert.equal(projectAgentStatus(transition(idle, { type: "interrupt" })), "aborted");
assert.equal(projectAgentStatus(transition(idle, { type: "compaction-start" })), "compacting");
assert.equal(projectAgentStatus(transition(idle, { type: "reset" })), "idle");

{
  const destroyed = transition(initState(), { type: "teardown" });
  for (const event of [
    { type: "prepare" },
    { type: "stream-chunk", stream: "responding" },
    { type: "pause", wait: "question" },
    { type: "settle", result: "completed" },
    { type: "fail", error: "x" },
    { type: "interrupt" },
    { type: "compaction-start" },
    { type: "reset" },
  ]) {
    assert.throws(() => transition(destroyed, event), /destroyed agent/, `${event.type} after teardown`);
  }
  assert.equal(transition(destroyed, { type: "teardown" }).lifecycle, "destroyed", "teardown is idempotent");
}

// A compaction keeps the phase through a stream finish and restores it afterwards.
{
  let state = transition(initState(), { type: "prepare" });
  state = transition(state, { type: "compaction-start" });
  state = transition(state, { type: "stream-end", result: "completed" });
  assert.equal(projectAgentStatus(state), "compacting");
  state = transition(state, { type: "compaction-end" });
  assert.equal(projectAgentStatus(state), "completed");
}

// A question outranks a failure/interrupt; an approval wait does not outrank a terminal outcome.
{
  let state = transition(initState(), { type: "prepare" });
  state = transition(state, { type: "pause", wait: "question" });
  state = transition(state, { type: "stream-end", result: "error", error: "down" });
  assert.equal(projectAgentStatus(state), "awaiting_user");
  assert.equal(state.errorMessage, "down");

  state = transition(state, { type: "interrupt" });
  assert.equal(projectAgentStatus(state), "awaiting_user");

  let approval = transition(initState(), { type: "prepare" });
  approval = transition(approval, { type: "pause", wait: "approval" });
  approval = transition(approval, { type: "interrupt" });
  assert.equal(projectAgentStatus(approval), "aborted", "an approval wait does not survive the turn ending");
}

// --- predicates are derived, not overlapping status sets --------------------
{
  const waiting = deriveAgentState("waiting");
  assert.equal(isActiveState(waiting), true, "a paused run is active for cancellation");
  assert.equal(isTerminalState(waiting), false, "a paused run is not terminal");
  const question = deriveAgentState("awaiting_user");
  assert.equal(isActiveState(question), true);
  assert.equal(isTerminalState(question), false);
  assert.equal(isTerminalState(deriveAgentState("error")), true);
  assert.equal(isActiveState(deriveAgentState("completed")), false);
}

// --- pause/resume keeps the run phase --------------------------------------
{
  let state = transition(initState(), { type: "prepare" });
  state = transition(state, { type: "stream-chunk", stream: "responding" });
  state = transition(state, { type: "pause", wait: "approval" });
  assert.equal(projectAgentStatus(state), "waiting");
  state = transition(state, { type: "resume" });
  assert.equal(projectAgentStatus(state), "responding");
  assert.throws(() => transition(deriveAgentState("idle"), { type: "resume" }), /requires a pending wait/);
}

// --- illegal transitions: strict throws, non-strict records without corruption
{
  const destroyed = transition(initState(), { type: "teardown" });
  assert.throws(() => transition(destroyed, { type: "prepare" }), /destroyed agent/);
  const rejected = [];
  const same = transition(
    destroyed,
    { type: "prepare" },
    {
      strict: false,
      onReject: (reason, event) => rejected.push(`${event.type}: ${reason}`),
    }
  );
  assert.equal(same, destroyed);
  assert.equal(rejected.length, 1);
}

// --- answering a question after a failed turn keeps the failure ------------
{
  let state = transition(initState(), { type: "prepare" });
  state = transition(state, { type: "pause", wait: "question" });
  state = transition(state, { type: "stream-end", result: "error", error: "down" });
  assert.equal(projectAgentStatus(state), "awaiting_user");
  state = transition(state, { type: "resume" });
  assert.equal(projectAgentStatus(state), "error");
  assert.equal(state.errorMessage, "down", "the failure survives the answered question");
}

// --- Esc while a failed turn is parked on a question keeps the failure ------
// The projection hides `error` behind `awaiting_user`, so the abort callers' `isActiveStatus`
// check cannot see the verdict. `interrupt` itself must keep it.
{
  let state = transition(initState(), { type: "prepare" });
  state = transition(state, { type: "pause", wait: "question" });
  state = transition(state, { type: "stream-end", result: "error", error: "down" });
  state = transition(state, { type: "interrupt" });
  assert.equal(state.outcome, "error", "an abort does not rewrite a failed run's verdict");
  state = transition(state, { type: "resume" });
  assert.equal(projectAgentStatus(state), "error");
  assert.equal(state.errorMessage, "down");
}

// --- `completed` + question is still cancellable; a dead approval wait is cleared ---
{
  let completed = transition(initState(), { type: "prepare" });
  completed = transition(completed, { type: "pause", wait: "question" });
  completed = transition(completed, { type: "stream-end", result: "completed" });
  completed = transition(completed, { type: "interrupt" });
  assert.equal(completed.outcome, "aborted", "a normally-finished parked turn can still be cancelled");

  let approval = transition(initState(), { type: "prepare" });
  approval = transition(approval, { type: "pause", wait: "approval" });
  approval = transition(approval, { type: "stream-end", result: "error", error: "down" });
  assert.equal(approval.wait, "approval", "stream-end does not clear the gate itself");
  approval = transition(approval, { type: "interrupt" });
  assert.equal(approval.outcome, "error", "the failure is kept");
  assert.equal(approval.wait, "none", "but an approval gate dies with the run");
}

// --- controller sequences match the pure machine ----------------------------
{
  let state = deriveAgentState("idle");
  const controller = createAgentStatusController({
    getStatus: () => projectAgentStatus(state),
    transition: (event) => {
      state = transition(state, event, { strict: false });
      return projectAgentStatus(state);
    },
    getError: () => state.errorMessage ?? "",
    setError: () => {},
    setPendingApprovalCount: () => {},
    setFinishReason: () => {},
    emitEvent: () => {},
  });

  controller.onRunStart();
  assert.equal(projectAgentStatus(state), "running");
  controller.onStreamChunk({ type: "REASONING_MESSAGE_CONTENT" });
  assert.equal(projectAgentStatus(state), "thinking");
  controller.onStreamChunk({ type: "TEXT_MESSAGE_CONTENT" });
  assert.equal(projectAgentStatus(state), "responding");
  controller.onRunFinish("stop");
  assert.equal(projectAgentStatus(state), "completed");

  controller.onRunStart();
  controller.onRunError("provider down");
  assert.equal(projectAgentStatus(state), "error");
  controller.onRunFinish("error");
  assert.equal(projectAgentStatus(state), "error", "a finish does not overwrite a failed run");

  controller.onRunStart();
  controller.onUserCancel();
  assert.equal(projectAgentStatus(state), "aborted");

  controller.resetToIdle();
  assert.equal(projectAgentStatus(state), "idle");
}

// --- `settle` needs a real turn --------------------------------------------
// A fresh agent has no run phase and no wait, so it has nothing to settle: reporting `completed`
// there published a verdict for a turn that never existed and skipped `reconcileAfterRun` (which
// returns early on `completed`).
{
  const fresh = deriveAgentState("idle");
  assert.throws(() => transition(fresh, { type: "settle", result: "completed" }), /settle requires a started run/);
  assert.throws(
    () => transition(initState(), { type: "settle", result: "completed" }),
    /settle requires a started run/
  );

  const rejected = [];
  const same = transition(
    fresh,
    { type: "settle", result: "completed" },
    { strict: false, onReject: (reason) => rejected.push(reason) }
  );
  assert.equal(same, fresh, "a rejected settle leaves the axes untouched");
  assert.equal(rejected.length, 1);

  // A WAIT is something to settle even with no run phase: `clearUnbackedWait` depends on it.
  let parked = deriveAgentState("awaiting_user");
  parked = transition(parked, { type: "settle", result: "completed", clearWait: true });
  assert.equal(projectAgentStatus(parked), "completed");

  // A run that already settled may settle again (every reconcile path does this).
  let settled = transition(transition(deriveAgentState("idle"), { type: "prepare" }), {
    type: "stream-end",
    result: "completed",
  });
  assert.equal(settled.run, "finalizing");
  settled = transition(settled, { type: "settle", result: "completed" });
  assert.equal(projectAgentStatus(settled), "completed");

  // A wait established before any chunk and then answered leaves `busy + run: idle`: `onRunFinish`
  // must still be able to settle it (the `isBusyStatus`-derived reconcile paths cannot — they
  // require `run !== idle`), or the projection stays `running` forever.
  let residual = transition(deriveAgentState("idle"), { type: "pause", wait: "question" });
  residual = transition(residual, { type: "resume" });
  assert.equal(residual.lifecycle, "busy");
  assert.equal(residual.run, "idle");
  assert.equal(projectAgentStatus(transition(residual, { type: "settle", result: "completed" })), "completed");
}

// --- an approval wait needs a verdict-free run ------------------------------
// A late `onToolPhaseComplete` used to park an already-settled turn: `waiting` is an ACTIVE status,
// so `shouldDeferMidRunQueue` stayed true with no pump left to drain the queue.
{
  for (const status of ["completed", "error", "aborted"]) {
    const state = deriveAgentState(status, status === "error" ? "boom" : "");
    assert.throws(
      () => transition(state, { type: "pause", wait: "approval" }),
      /pause requires a live run/,
      `${status} cannot park on an approval`
    );
    // A QUESTION is deliberately exempt: an unanswered `ask_user` outlives the verdict.
    assert.equal(
      projectAgentStatus(transition(state, { type: "pause", wait: "question" })),
      "awaiting_user",
      `${status} can still be parked on a question`
    );
  }
  // A live run can still park, and re-asserting the same wait is idempotent.
  let running = transition(deriveAgentState("idle"), { type: "prepare" });
  running = transition(running, { type: "pause", wait: "approval" });
  assert.equal(projectAgentStatus(running), "waiting");
  assert.equal(projectAgentStatus(transition(running, { type: "pause", wait: "approval" })), "waiting");
}

// --- sticky / parked are derived from the axes, not hand lists --------------
// Asserted as literal sets: a hand-maintained list that merely happens to match today would pass any
// assertion phrased as the same expression the implementation uses.
{
  const expectedSticky = ["aborted", "awaiting_user", "compacting", "completed", "error", "waiting"];
  assert.deepEqual(STATUSES.filter((status) => isStickyStatus(status)).sort(), expectedSticky.slice().sort());
  assert.deepEqual(STATUSES.filter((status) => isParkedStatus(status)).sort(), ["awaiting_user", "waiting"]);
}

// --- a late approval sync must not reopen a settled turn -------------------
// `syncApprovals` runs from `onToolPhaseComplete`, which can land after the turn ended (a retry, a
// pump unwinding). Pausing there projected `waiting` — an ACTIVE status — with no pump left, so
// every later message queued behind `shouldDeferMidRunQueue` and nothing drained it.
{
  let state = deriveAgentState("idle");
  const rejected = [];
  const controller = createAgentStatusController({
    getStatus: () => projectAgentStatus(state),
    getAgentState: () => state,
    transition: (event) => {
      state = transition(state, event, { strict: false, onReject: (reason) => rejected.push(reason) });
      return projectAgentStatus(state);
    },
    getError: () => state.errorMessage ?? "",
    setError: () => {},
    setPendingApprovalCount: () => {},
    setFinishReason: () => {},
    emitEvent: () => {},
  });
  const approval = { toolCallId: "call-1", toolName: "run_command", approvalId: "approval-1", input: {} };

  controller.onRunStart();
  controller.onRunFinish("stop");
  assert.equal(projectAgentStatus(state), "completed");
  controller.syncApprovals([approval]);
  assert.equal(projectAgentStatus(state), "completed", "a settled turn is not parked by a late approval");
  assert.equal(rejected.length, 1, "the rejected pause is reported, not silently dropped");

  // The same call on a LIVE run still parks it: this is the gate the pause exists for.
  controller.onRunStart();
  controller.syncApprovals([approval]);
  assert.equal(projectAgentStatus(state), "waiting");

  // A failed turn is equally closed to a late approval, and stays `error` rather than `waiting`.
  controller.onRunError("provider down");
  controller.syncApprovals([approval]);
  assert.equal(projectAgentStatus(state), "error");
}

// --- initial state is the zero value ---------------------------------------
function initState() {
  return { ...INITIAL_AGENT_STATE };
}

console.log(`state transition matrix validation passed (${STATUSES.length} statuses)`);
