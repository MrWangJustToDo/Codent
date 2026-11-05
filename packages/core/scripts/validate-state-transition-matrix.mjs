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
assert.equal(projectAgentStatus(transition(idle, { type: "settle", result: "completed" })), "completed");
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

// --- initial state is the zero value ---------------------------------------
function initState() {
  return { ...INITIAL_AGENT_STATE };
}

console.log(`state transition matrix validation passed (${STATUSES.length} statuses)`);
