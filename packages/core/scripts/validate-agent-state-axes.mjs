/**
 * State axes: deterministic projection, every existing status round-trips, and the transition
 * table rejects illegal events without corrupting state.
 *
 * Run: pnpm --filter @codent/core run validate:agent-state-axes
 */

import assert from "node:assert/strict";

import {
  deriveAgentState,
  INITIAL_AGENT_STATE,
  isActiveState,
  isTerminalState,
  projectAgentStatus,
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

// --- projection is deterministic and lossless for the current wire set -----
for (const status of STATUSES) {
  const state = deriveAgentState(status, status === "error" ? "boom" : "");
  assert.equal(projectAgentStatus(state), status, `${status} must round-trip`);
  assert.deepEqual(projectAgentStatus(state), projectAgentStatus(deriveAgentState(status, "")), `${status} is pure`);
}

// --- predicates are derived, not overlapping status sets --------------------
{
  const waiting = deriveAgentState("waiting");
  assert.equal(isActiveState(waiting), true, "a paused run is active for cancellation");
  assert.equal(isTerminalState(waiting), false, "a paused run is not terminal");

  const question = deriveAgentState("awaiting_user");
  assert.equal(isActiveState(question), true);
  assert.equal(isTerminalState(question), false);

  const error = deriveAgentState("error");
  assert.equal(isTerminalState(error), true);
  assert.equal(isActiveState(error), false);

  const completed = deriveAgentState("completed");
  assert.equal(isTerminalState(completed), false, "completed is settled, not a fault");
  assert.equal(isActiveState(completed), false);
}

// --- prepare → stream → pause → resume --------------------------------------
{
  let state = transition(INITIAL_AGENT_STATE, { type: "prepare" });
  assert.equal(state.lifecycle, "busy");
  assert.equal(state.run, "preparing");
  assert.equal(projectAgentStatus(state), "running");

  state = transition(state, { type: "stream-start" });
  assert.equal(projectAgentStatus(state), "running");

  state = transition(state, { type: "stream-chunk", stream: "thinking" });
  assert.equal(projectAgentStatus(state), "thinking");

  state = transition(state, { type: "stream-chunk", stream: "responding" });
  assert.equal(projectAgentStatus(state), "responding");

  state = transition(state, { type: "pause", wait: "approval" });
  assert.equal(projectAgentStatus(state), "waiting");

  state = transition(state, { type: "resume" });
  assert.equal(projectAgentStatus(state), "responding");
}

// --- a failed turn with an unanswered question projects awaiting_user ------
{
  let state = transition(INITIAL_AGENT_STATE, { type: "prepare" });
  state = transition(state, { type: "stream-start" });
  state = transition(state, { type: "pause", wait: "question" });
  state = transition(state, { type: "stream-end", result: "error", error: "provider down" });
  assert.equal(projectAgentStatus(state), "awaiting_user", "the question outranks the failure");
  assert.equal(state.errorMessage, "provider down", "the error text is retained");
  assert.equal(isTerminalState(state), true, "the run did fail even though the projection waits");
}

// --- interrupt with a pending question stays awaiting_user -----------------
{
  let state = transition(INITIAL_AGENT_STATE, { type: "prepare" });
  state = transition(state, { type: "pause", wait: "question" });
  state = transition(state, { type: "interrupt" });
  assert.equal(projectAgentStatus(state), "awaiting_user");
  assert.equal(state.outcome, "aborted");
}

// --- compaction is a run phase and restores the phase it interrupted -------
{
  let state = transition(INITIAL_AGENT_STATE, { type: "prepare" });
  state = transition(state, { type: "stream-start" });
  state = transition(state, { type: "compaction-start" });
  assert.equal(projectAgentStatus(state), "compacting");

  // A stream finish during compaction must not end the compaction phase.
  state = transition(state, { type: "stream-end", result: "completed" });
  assert.equal(state.run, "compacting");
  assert.equal(projectAgentStatus(state), "compacting");

  state = transition(state, { type: "compaction-end" });
  assert.equal(state.run, "finalizing", "the finish that landed during compaction is applied");
  assert.equal(projectAgentStatus(state), "completed");

  // Without a finish, the phase the compaction interrupted is restored.
  let resumed = transition(INITIAL_AGENT_STATE, { type: "prepare" });
  resumed = transition(resumed, { type: "stream-start" });
  resumed = transition(resumed, { type: "compaction-start" });
  resumed = transition(resumed, { type: "compaction-end" });
  assert.equal(resumed.run, "streaming", "the previous run phase is restored");
}

// --- completion / error / abort --------------------------------------------
{
  const completed = transition(
    transition(transition(INITIAL_AGENT_STATE, { type: "prepare" }), { type: "stream-start" }),
    { type: "stream-end", result: "completed" }
  );
  assert.equal(projectAgentStatus(completed), "completed");

  const failed = transition(
    transition(transition(INITIAL_AGENT_STATE, { type: "prepare" }), { type: "stream-start" }),
    { type: "stream-end", result: "error", error: "x" }
  );
  assert.equal(projectAgentStatus(failed), "error");
  assert.equal(failed.errorMessage, "x");

  const aborted = transition(transition(INITIAL_AGENT_STATE, { type: "prepare" }), { type: "interrupt" });
  assert.equal(projectAgentStatus(aborted), "aborted");
}

// --- illegal transitions: throw in strict, record without corruption otherwise
{
  const destroyed = transition(INITIAL_AGENT_STATE, { type: "teardown" });
  assert.equal(destroyed.lifecycle, "destroyed");
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
  assert.equal(same, destroyed, "a rejected event leaves the state untouched");
  assert.equal(rejected.length, 1);

  // A chunk implies a stream even if the caller missed `stream-start` (retry resumes mid-stream).
  const promoted = transition(deriveAgentState("idle"), { type: "stream-chunk", stream: "thinking" });
  assert.equal(projectAgentStatus(promoted), "thinking");
}

// --- the snapshot carries the axes next to the wire status -----------------
{
  const idle = deriveAgentState("idle");
  assert.deepEqual(idle, { ...INITIAL_AGENT_STATE, lifecycle: "ready" });
}

console.log("agent state axes validation passed");
