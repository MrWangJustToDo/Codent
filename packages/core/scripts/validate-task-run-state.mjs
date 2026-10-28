/**
 * Validates the per-task run-phase state machine (TaskRunState).
 *
 * Run: pnpm --filter @codent/core run validate:task-run-state
 */

import assert from "node:assert/strict";

import { TaskRunState } from "../dist/dev.mjs";

const {
  beginTaskRun,
  clearSubagentRuns,
  clearTaskRuns,
  countSubagentRuns,
  enterTaskLimitPhase,
  enterTaskSummaryPhase,
  getTaskRunState,
  peekTaskPreforkCoordinator,
  readTaskRunPhase,
} = await import("../dist/dev.mjs");

// --- defaults ---

const parent = {};
assert.equal(readTaskRunPhase(parent, "t1"), "running", "unknown tasks default to running");
assert.equal(readTaskRunPhase(parent, undefined), "running");
assert.equal(getTaskRunState(parent, "t1"), undefined);

// --- register + one-way transition ---

{
  const state = beginTaskRun(parent, "t1");
  assert.ok(state instanceof TaskRunState);
  assert.equal(state.phase, "running");
  assert.equal(getTaskRunState(parent, "t1"), state);

  assert.equal(enterTaskSummaryPhase(parent, "t1"), true, "first transition reports change");
  assert.equal(state.phase, "summary");
  assert.equal(enterTaskSummaryPhase(parent, "t1"), false, "transition is idempotent");
  assert.equal(state.phase, "summary", "one-way: summary never reverts to running");
}

// --- limit is a distinct terminal phase ---

{
  // Straight from running: either terminal phase is reachable.
  const p = {};
  assert.equal(enterTaskLimitPhase(p, "a"), true);
  assert.equal(readTaskRunPhase(p, "a"), "limit", "budget cutoff is its own phase, not summary");
  const p2 = {};
  assert.equal(enterTaskSummaryPhase(p2, "b"), true);
  assert.equal(readTaskRunPhase(p2, "b"), "summary");
}

{
  // A subagent can call `begin_summary` and STILL exhaust the budget before the run
  // closes — the more specific `limit` wins, and reports the change.
  const p = {};
  assert.equal(enterTaskSummaryPhase(p, "t"), true);
  assert.equal(enterTaskLimitPhase(p, "t"), true, "summary → limit is a real transition");
  assert.equal(readTaskRunPhase(p, "t"), "limit");
  assert.equal(enterTaskLimitPhase(p, "t"), false, "idempotent");
}

{
  // `limit` is terminal: it never falls back to the less specific `summary`.
  const p = {};
  enterTaskLimitPhase(p, "t");
  assert.equal(enterTaskSummaryPhase(p, "t"), false, "limit never downgrades to summary");
  assert.equal(readTaskRunPhase(p, "t"), "limit");
}

// --- registries are per-parent ---
{
  const parentA = {};
  const parentB = {};
  beginTaskRun(parentA, "shared");
  enterTaskSummaryPhase(parentA, "shared");
  assert.equal(readTaskRunPhase(parentB, "shared"), "running", "parents have isolated registries");
}

// --- unknown id transition is a safe no-op ---

assert.equal(enterTaskSummaryPhase(parent, ""), false);
assert.equal(enterTaskSummaryPhase(parent, "never-registered"), true, "auto-registers then transitions");
assert.equal(readTaskRunPhase(parent, "never-registered"), "summary");

// --- cleanup ---

clearTaskRuns(parent);
assert.equal(readTaskRunPhase(parent, "t1"), "running", "clear resets all tasks");
beginTaskRun(parent, "keep-me");
beginTaskRun(parent, "drop-me");
clearTaskRuns(parent, "drop-me");
assert.ok(getTaskRunState(parent, "keep-me"));
assert.equal(getTaskRunState(parent, "drop-me"), undefined);

// --- one owner: the task phase lives in the SAME per-parent registry as the pre-fork seats ---
//
// They used to be two independent WeakMaps, so nothing could clear "this parent's task state" in one
// call — and the phase map was never cleared at all: every task id stayed for the life of the agent,
// across `/new` and `/resume`.
{
  const parent = {};
  beginTaskRun(parent, "t-a");
  beginTaskRun(parent, "t-b");
  assert.equal(countSubagentRuns(parent), 2, "one record per task call");
  assert.ok(
    peekTaskPreforkCoordinator(parent),
    "the phase record and the pre-fork seats share one registry (a session clear drops both)"
  );

  clearSubagentRuns(parent);
  assert.equal(countSubagentRuns(parent), 0, "a session switch drops every task record");
  assert.equal(readTaskRunPhase(parent, "t-a"), "running", "and the phases are gone");

  // Non-creating: clearing an agent that never ran a task must not allocate a registry.
  const untouched = {};
  clearSubagentRuns(untouched);
  assert.equal(countSubagentRuns(untouched), 0);
  assert.equal(peekTaskPreforkCoordinator(untouched), undefined, "no registry is created just to clear it");
}

console.log("task-run-state validation passed");
