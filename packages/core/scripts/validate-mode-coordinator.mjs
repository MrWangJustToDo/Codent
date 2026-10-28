/**
 * Validates plan/auto arbitration:
 * - mutual exclusion in both directions;
 * - plan wins on restore, and the persisted auto flag never says true during a plan phase;
 * - `setAuto(true)` disables plan BEFORE the AutoModeController change (so the persist callback
 *   observes `plan off + auto on`, not the impossible pair);
 * - cycle order normal → auto → plan → normal.
 *
 * Run: pnpm --filter @codent/core run validate:mode-coordinator
 */

import assert from "node:assert/strict";

import { AutoModeController, ModeCoordinator, PlanModeController, loadPlanFromWorkspace } from "../dist/dev.mjs";

const plan = new PlanModeController({ getTodoManager: () => null, getCoreEnv: () => ({}) });
const snapshots = [];
let persistCalls = 0;
const record = () => {
  persistCalls += 1;
  snapshots.push({ phase: plan.getPhase(), auto: auto.isEnabled() });
};
const auto = new AutoModeController(record);
const mode = new ModeCoordinator({
  planMode: plan,
  autoMode: auto,
  persist: record,
});

const persisted = () => ({ phase: plan.getPhase(), auto: mode.getPersistedAutoMode() });

// ---------------------------------------------------------------------------
// 1. Auto on: plan off, one auto-change persist
// ---------------------------------------------------------------------------
mode.setAuto(true);
assert.equal(mode.getMode(), "auto");
assert.deepEqual(persisted(), { phase: "off", auto: true });
assert.equal(persistCalls, 1);
assert.deepEqual(snapshots.at(-1), { phase: "off", auto: true });

// ---------------------------------------------------------------------------
// 2. Plan on: auto off, plan state persisted
// ---------------------------------------------------------------------------
mode.enablePlan();
assert.equal(mode.getMode(), "plan");
assert.equal(mode.isAutoEnabled(), false, "entering plan exits auto");
assert.deepEqual(persisted(), { phase: "planning", auto: false });
assert.ok(persistCalls >= 2);
assert.deepEqual(snapshots.at(-1), { phase: "planning", auto: false });

// ---------------------------------------------------------------------------
// 3. Auto on while plan is active: plan leaves FIRST, then auto changes
// ---------------------------------------------------------------------------
mode.setAuto(true);
assert.equal(mode.getMode(), "auto");
assert.equal(plan.getPhase(), "off");
assert.deepEqual(persisted(), { phase: "off", auto: true });
assert.deepEqual(snapshots.at(-1), { phase: "off", auto: true }, "the persist callback must not see plan-on + auto-on");

// ---------------------------------------------------------------------------
// 4. Back to normal: both off
// ---------------------------------------------------------------------------
mode.setMode("normal");
assert.equal(mode.getMode(), "normal");
assert.deepEqual(persisted(), { phase: "off", auto: false });

// ---------------------------------------------------------------------------
// 5. Restore precedence: plan wins over a persisted auto flag
// ---------------------------------------------------------------------------
const executing = {
  phase: "executing",
  planMarkdown: "# plan",
  steps: [],
  enabledAt: 1,
  todosSeeded: true,
  preservedExistingTodos: false,
  planFilePath: null,
};
mode.restore(executing, true);
assert.equal(mode.getMode(), "plan");
assert.equal(mode.isAutoEnabled(), false, "plan wins on restore");
assert.equal(mode.getPersistedAutoMode(), false);
assert.equal(mode.shouldAutoApprove(), true, "seeded executing plan auto-approves tools");

mode.restore(null, true);
assert.equal(mode.getMode(), "auto");
assert.equal(mode.isAutoEnabled(), true);

// ---------------------------------------------------------------------------
// 6. Cycle order
// ---------------------------------------------------------------------------
mode.setMode("normal");
assert.equal(mode.cycle(), "auto");
assert.equal(mode.cycle(), "plan");
assert.equal(mode.cycle(), "normal");

// ---------------------------------------------------------------------------
// 7. Reset exits both; the auto change persists, with no extra explicit write
// ---------------------------------------------------------------------------
mode.setAuto(true);
const beforeReset = persistCalls;
mode.reset();
assert.equal(mode.getMode(), "normal");
assert.equal(persistCalls, beforeReset + 1, "only the auto onChange persist fires");

// ---------------------------------------------------------------------------
// 8. `/mode load` goes through the coordinator
//
// `loadPlanMarkdown` used to enable the phase itself, bypassing `ModeCoordinator.enablePlan()` —
// the only writer that turns auto off. Auto then stayed on through `planning`/`ready`, where
// `shouldAutoApprove()` bypasses every approval prompt. Entering is the coordinator's job; the
// controller refuses to start from `off`.
// ---------------------------------------------------------------------------
mode.setMode("normal");

const refusedLoad = await plan.loadPlanMarkdown("# Plan\n\n1. Explore\n");
assert.equal(refusedLoad.ok, false, "loading cannot start a plan phase on its own");
assert.equal(plan.getPhase(), "off", "the phase is untouched");

const planMarkdown = "# Plan\n\n1. Explore the code\n2. Verify\n";
const fakeEnv = {
  rootPath: "/tmp/plan-load-test",
  fs: {
    readFile: async () => planMarkdown,
    writeFile: async () => {},
    mkdir: async () => {},
  },
};
const host = {
  planMode: plan,
  mode,
  getStatus: () => "idle",
  getChatController: () => undefined,
  getCoreEnv: () => fakeEnv,
};

mode.setAuto(true);
assert.equal(mode.isAutoEnabled(), true);
const loaded = await loadPlanFromWorkspace(host, "demo");
assert.equal(loaded.ok, true);
assert.equal(mode.getMode(), "plan");
assert.equal(mode.isAutoEnabled(), false, "loading a plan turns auto off, it does not leave it on");
assert.deepEqual(persisted(), { phase: "ready", auto: false });

// A failed load must leave the session exactly as it was — including the user's auto mode.
mode.setMode("normal");
mode.setAuto(true);
const badEnv = { ...fakeEnv, fs: { ...fakeEnv.fs, readFile: async () => "no plan here" } };
const badLoad = await loadPlanFromWorkspace({ ...host, getCoreEnv: () => badEnv }, "broken");
assert.equal(badLoad.ok, false, "a file without a ## Plan section is rejected");
assert.equal(plan.getPhase(), "off", "and the phase is untouched");
assert.equal(mode.isAutoEnabled(), true, "and auto is not consumed by the attempt");

// Leaving plan persists: `planMode.complete()` exits the phase but fires no auto-change callback.
assert.equal((await loadPlanFromWorkspace(host, "demo")).ok, true);
const beforeComplete = persistCalls;
assert.equal(mode.completePlan().ok, true);
assert.equal(plan.getPhase(), "off");
assert.equal(persistCalls, beforeComplete + 1, "leaving plan mode writes the session");
assert.equal(mode.shouldAutoApprove(), false);

console.log("mode-coordinator validation passed");
