/**
 * Validation for plan-mode session restore + approval auto-approve gating.
 *
 * Run: pnpm --filter @codent/core run validate:plan-session
 */

import assert from "node:assert/strict";

import { PLAN_TODO_TITLE, PlanModeController, TodoManager, createAgentEventBus, createTodoTool } from "../dist/dev.mjs";

const todoManager = new TodoManager();
const controller = new PlanModeController({
  getTodoManager: () => todoManager,
});
const bus = createAgentEventBus();
todoManager.setEventBus(bus);
controller.setEventBus(bus);

assert.equal(controller.shouldAutoApproveTools(), false);

controller.enable();
assert.equal(controller.shouldAutoApproveTools(), false);

await controller.applyStructuredPlan({
  goal: "Session restore demo",
  steps: ["Explore", "Implement", "Verify"],
  keyFiles: ["src/index.ts"],
});
assert.equal(controller.getPhase(), "ready");
assert.equal(controller.shouldAutoApproveTools(), false);

const began = controller.beginExecution();
assert.equal(began.ok, true);
assert.equal(controller.getPhase(), "executing");
assert.equal(controller.shouldAutoApproveTools(), true);
assert.equal(todoManager.isPlanBound(), true);
assert.equal(todoManager.isAutoClearEnabled(), false);

// Simulate persist → restore on a fresh controller (todos restored separately).
const snapshot = controller.getState();
const todos = todoManager.getItems();
const title = todoManager.getTitle();
const planBound = todoManager.isPlanBound();

const restoredTodos = new TodoManager();
restoredTodos.restoreTodos(todos, { title, planBound });
restoredTodos.setAutoClearEnabled(true); // would be dangerous without plan restore

const restored = new PlanModeController({
  getTodoManager: () => restoredTodos,
});
const restoredBus = createAgentEventBus();
restoredTodos.setEventBus(restoredBus);
restored.setEventBus(restoredBus);
assert.equal(restored.shouldAutoApproveTools(), false);

restored.restoreState(snapshot);
assert.equal(restored.getPhase(), "executing");
assert.equal(restored.shouldAutoApproveTools(), true);
assert.equal(restoredTodos.isPlanBound(), true);
assert.equal(restoredTodos.isAutoClearEnabled(), false);
assert.equal(restoredTodos.getTitle(), PLAN_TODO_TITLE);

// Completing all todos after restore should still enter retro.
restoredTodos.update(
  restoredTodos.getItems().map((item) => ({
    content: item.content,
    status: "completed",
    priority: item.priority,
  })),
  PLAN_TODO_TITLE
);
assert.equal(restored.getPhase(), "retro");
// Retro auto-approves too: it is the same run of the same approved plan, and it is where the
// plan's Verification checklist is executed. This expectation used to be `false`, which meant
// the identical commands ran unprompted in `executing` and then prompted again in `retro`.
assert.equal(restored.shouldAutoApproveTools(), true);

// Retro WITHOUT seeded todos must not auto-approve — the seeded guard is what stops a phase
// alone from bypassing approval, and it applies to retro exactly as it does to executing.
const retroUnseeded = new PlanModeController({ getTodoManager: () => new TodoManager() });
retroUnseeded.restoreState({
  phase: "retro",
  planMarkdown: "## Plan\n1. x",
  steps: [{ step: 1, text: "x" }],
  enabledAt: Date.now(),
  todosSeeded: false,
  preservedExistingTodos: false,
  planFilePath: null,
});
assert.equal(retroUnseeded.getPhase(), "retro");
assert.equal(retroUnseeded.shouldAutoApproveTools(), false);

// Off snapshot clears phase without wiping unrelated todos.
const otherTodos = new TodoManager();
otherTodos.update([{ content: "Keep me", status: "pending", priority: "medium" }], "Other");
const clearCtrl = new PlanModeController({
  getTodoManager: () => otherTodos,
});
clearCtrl.restoreState(null);
assert.equal(clearCtrl.getPhase(), "off");
assert.equal(otherTodos.getItems().length, 1);

// ---------------------------------------------------------------------------
// Todo ownership is planBound alone — the title never confers plan ownership, and the binding
// does not outlive the plan phase it was minted in.
// ---------------------------------------------------------------------------

// An agent list merely *named* "Plan" is agent-owned.
const titledTodos = new TodoManager();
titledTodos.update([{ content: "step", status: "pending", priority: "medium" }], PLAN_TODO_TITLE);
assert.equal(titledTodos.isPlanBound(), false);
assert.equal(
  titledTodos.getSource(),
  "agent",
  'a title of "Plan" must not make an agent list plan-owned — the title is authorable, so '
);

// A stale persisted binding is released once no plan phase is live. This is the latch that used
// to keep EVERY later agent list rendering as plan steps until /new.
const staleTodos = new TodoManager();
staleTodos.restoreTodos(
  [
    {
      id: "a",
      content: "Compaction timing + abort",
      status: "pending",
      priority: "medium",
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  { title: "Compaction timing + abort", planBound: true }
);
assert.equal(staleTodos.getSource(), "plan", "restoring a plan-bound list is plan-owned on its face");
const staleCtrl = new PlanModeController({ getTodoManager: () => staleTodos });
staleCtrl.enable();
staleCtrl.disable();
assert.equal(staleTodos.isPlanBound(), false, "leaving plan mode must release the binding");
staleTodos.update(
  [{ content: "propose fix-workspace-diff-untracked-dir", status: "pending", priority: "medium" }],
  "propose fix-workspace-diff-untracked-dir"
);
assert.equal(
  staleTodos.getSource(),
  "agent",
  "an agent list written after plan mode ended must not inherit plan ownership"
);

// The `todo` tool must not be able to MINT a plan binding at all. The model authorises every
// title it sends, so a title check here was a second, weaker authority for a decision the plan
// seed path already owns (and the weaker one is what made an agent list named "Plan" render as
// plan steps for the rest of the session). No `getPlanMode` is passed — the tool has no phase
// input, and both halves of the invariant are asserted: a plan title cannot bind, and the tool
// cannot RELEASE a binding the seed path minted either.
const toolTodos = new TodoManager();
const tool = createTodoTool({ todoManager: toolTodos });
await tool.execute({ todos: [{ content: "s", status: "pending", priority: "medium" }], title: PLAN_TODO_TITLE });
assert.equal(toolTodos.isPlanBound(), false, "no phase input → the tool never binds");
assert.equal(toolTodos.getSource(), "agent", 'a todo tool call titled "Plan" is agent-owned');

toolTodos.setPlanBound(true);
await tool.execute({ todos: [{ content: "s", status: "pending", priority: "medium" }], title: "My own list" });
assert.equal(toolTodos.isPlanBound(), true, "the tool must not release a seed-path binding either");
assert.equal(toolTodos.getSource(), "plan", "ownership survives an ordinary tool update");

// Stuck executing without seeded todos must not auto-approve.
const stuck = new PlanModeController({
  getTodoManager: () => new TodoManager(),
});
stuck.restoreState({
  phase: "executing",
  planMarkdown: "## Plan\n1. x",
  steps: [{ step: 1, text: "x" }],
  enabledAt: Date.now(),
  todosSeeded: false,
  preservedExistingTodos: false,
  planFilePath: null,
});
assert.equal(stuck.getPhase(), "executing");
assert.equal(stuck.shouldAutoApproveTools(), false);

// Every phase transition is session state: quitting right after `/mode done` used to restore
// `retro` + `todosSeeded` (auto-approving tools the user had left). A restore must NOT write.
{
  let persists = 0;
  const transitional = new PlanModeController({
    getTodoManager: () => new TodoManager(),
    persist: () => {
      persists += 1;
    },
  });

  transitional.enable();
  const afterEnable = persists;
  assert.ok(afterEnable > 0, "entering planning persists");

  await transitional.applyStructuredPlan({
    goal: "persist phases",
    steps: ["one", "two"],
    keyFiles: ["src/index.ts"],
  });
  const afterReady = persists;
  assert.ok(afterReady > afterEnable, "planning → ready persists");

  transitional.beginExecution();
  const afterExecuting = persists;
  assert.ok(afterExecuting > afterReady, "review → building persists");

  transitional.cancelExecution();
  assert.ok(persists > afterExecuting, "building → review persists");

  const beforeRestore = persists;
  transitional.restoreState(transitional.getState());
  assert.equal(persists, beforeRestore, "hydrating from disk must not write its own partial state");
}

console.log("validate:plan-session OK");
