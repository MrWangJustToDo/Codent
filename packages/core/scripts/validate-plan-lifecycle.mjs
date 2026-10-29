/**
 * Validation for plan summary helper + plan lifecycle phase transitions
 * (ready → execute → all todos done → retro → complete → off).
 * Auto-persist path is covered when CoreEnv is available via applyStructuredPlan;
 * this script focuses on pure helpers + controller phase machine with a mock todo manager.
 *
 * Run: pnpm --filter @codent/core run validate:plan-lifecycle
 */
import assert from "node:assert/strict";

import {
  PLAN_COMPLETION_TOOL_NAMES,
  PLAN_TODO_TITLE,
  PlanModeController,
  TodoManager,
  buildPlanModeRetroPrompt,
  createAgentEventBus,
  extractGoalFromPlanMarkdown,
  formatPlanSummary,
} from "../dist/dev.mjs";

assert.ok(PLAN_COMPLETION_TOOL_NAMES.has("complete_plan"));

const summary = formatPlanSummary({
  path: ".agents/plans/demo.md",
  goal: "Ship feature",
  steps: [
    { step: 1, text: "Explore" },
    { step: 2, text: "Implement" },
    { step: 3, text: "Verify" },
  ],
});
assert.match(summary, /Plan file:/);
assert.match(summary, /Goal: Ship feature/);
assert.match(summary, /1\. Explore/);
assert.match(summary, /3\. Verify/);

const longSteps = Array.from({ length: 20 }, (_, i) => ({ step: i + 1, text: `Step ${i + 1}` }));
const truncated = formatPlanSummary({ goal: "Big", steps: longSteps, maxSteps: 5 });
assert.match(truncated, /\+15 more/);

assert.equal(extractGoalFromPlanMarkdown("## Plan\n\n**Goal:** Do the thing\n\n1. A"), "Do the thing");

const retro = buildPlanModeRetroPrompt("## Plan\n1. x", ".agents/plans/x.md");
assert.match(retro, /retro/i);
assert.match(retro, /complete_plan/);
assert.match(retro, /\.agents\/plans\/x\.md/);

const events = [];
const todoManager = new TodoManager();
const bus = createAgentEventBus();
bus.on("*", (e) => events.push({ type: e.type, data: e.payload }));
const controller = new PlanModeController({
  getTodoManager: () => todoManager,
  // Plan transitions are domain events: the controller emits through the funnel, and the funnel
  // ends at the bus. A controller built without one emits nothing (see the PlanModeController doc).
  emitEvent: (type, payload) => bus.emit(type, payload),
});
todoManager.setEventBus(bus);
controller.setEventBus(bus);

controller.enable();
assert.equal(controller.getPhase(), "planning");

// Without CoreEnv, persist may fail non-fatally — still transitions to ready
await controller.applyStructuredPlan({
  goal: "Lifecycle demo",
  steps: ["One", "Two", "Three"],
  keyFiles: ["src/index.ts"],
});
assert.equal(controller.getPhase(), "ready");
assert.equal(controller.getState().steps.length, 3);
assert.ok(events.some((e) => e.type === "plan:ready"));

const began = controller.beginExecution();
assert.equal(began.ok, true);
assert.equal(controller.getPhase(), "executing");
assert.ok(todoManager.getTitle() === PLAN_TODO_TITLE);
assert.equal(todoManager.getItems().length, 3);

todoManager.update(
  todoManager.getItems().map((item) => ({
    content: item.content,
    status: "completed",
    priority: item.priority,
  })),
  PLAN_TODO_TITLE
);

assert.equal(controller.getPhase(), "retro");
assert.ok(events.some((e) => e.type === "plan:retro"));

const completed = controller.complete();
assert.equal(completed.ok, true);
assert.equal(controller.getPhase(), "off");
assert.ok(events.some((e) => e.type === "plan:complete"));
assert.ok(events.some((e) => e.type === "plan:exit"));

// Fresh controller: plan-bound source after seed
const todo2 = new TodoManager();
const c2 = new PlanModeController({ getTodoManager: () => todo2 });
const bus2 = createAgentEventBus();
todo2.setEventBus(bus2);
c2.setEventBus(bus2);
c2.enable();
await c2.applyStructuredPlan({
  goal: "Source check",
  steps: ["A step here", "B step here"],
  keyFiles: ["src/index.ts"],
});
c2.beginExecution();
assert.equal(todo2.isPlanBound(), true);
assert.equal(todo2.getSource(), "plan");

// --- Regression: title drift but still plan-bound -> all complete -> retro ---
// The agent may update the todo list under a descriptive (non-"Plan") title while
// still executing. Plan identity must be tracked via plan-bound/source, NOT the
// title string, or the lifecycle is stuck on `building n/m` forever.
const todo3 = new TodoManager();
const c3 = new PlanModeController({ getTodoManager: () => todo3 });
const bus3 = createAgentEventBus();
todo3.setEventBus(bus3);
c3.setEventBus(bus3);
c3.enable();
await c3.applyStructuredPlan({
  goal: "Title drift",
  steps: ["One", "Two"],
  keyFiles: ["src/index.ts"],
});
c3.beginExecution();
assert.equal(todo3.getSource(), "plan");
// Drift the title away from "Plan" but keep plan binding (as the todo tool does).
todo3.update(
  todo3.getItems().map((item) => ({
    content: item.content,
    status: "completed",
    priority: item.priority,
  })),
  "Describe the work"
);
// Still plan-bound despite the drifted title.
assert.equal(todo3.isPlanBound(), true);
assert.equal(todo3.getTitle(), "Describe the work");
// All complete under a drifted title must still advance to retro.
assert.equal(c3.getPhase(), "retro", "title drift must not block executing -> retro");

console.log("validate:plan-lifecycle OK");
