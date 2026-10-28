/**
 * Plan retro hand-off gate.
 *
 * Entering `retro` used to enqueue a follow-up chat message
 * (`buildPlanRetroSteerMessage`) so that `complete_plan` — excluded from the tool
 * set while `executing` — would be available on a fresh run. That workaround is
 * obsolete, and the reason is structural, not incidental:
 *
 * 1. `runnerConfigKey` includes `planMode.getPhase()`, and `onPhaseChange` calls
 *    `invalidateRunner()`. So the phase flip to `retro` **invalidates the cached
 *    runner**.
 * 2. `AgentChatController.pumpToolPhases` loops `MAX_TOOL_PHASES` times, each
 *    iteration resolving the runner through `ensureAgentRunner`. The next iteration
 *    therefore rebuilds with the retro tool set, where `complete_plan` is present.
 * 3. `notifyChange()` (called by `maybeEnterRetro`) already fires `onPhaseChange`,
 *    so the invalidation happens without any extra hook.
 *
 * The steering message itself was harmless-but-redundant: it landed after the pump
 * had already driven `retro → complete_plan → off` inside the same run, and the model
 * spent a turn replying "the retrospective is already complete". This gate asserts the
 * structural property that makes the message unnecessary, so that removing it is
 * load-bearing rather than incidental.
 *
 * Three invariants:
 *
 * 1. **Phase flip invalidates the runner.** Without this, the continuation pump
 *    reuses a runner built for the `executing` tool set and `complete_plan` is
 *    genuinely unreachable — the exact regression the deleted workaround masked.
 * 2. **The retro runner exposes `complete_plan`.** The invalidation above is only
 *    useful if the rebuilt tool set actually contains the completion tool.
 * 3. **The controller no longer offers the retro hook.** `onEnterRetro` existed to
 *    send that one message; a re-added callback with the same name would reinstate
 *    the duplicate delivery. Guards against the workaround creeping back.
 *
 * Run: pnpm --filter @codent/core run validate:plan-retro-continuation
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AgentStreamHub,
  PLAN_TODO_TITLE,
  PlanModeController,
  TodoManager,
  buildAgentRunner,
  createAgentEventBus,
  registerCoreEnv,
} from "../dist/dev.mjs";

registerCoreEnv({
  rootPath: "/tmp",
  fs: {},
  path: {},
  runCommand: async () => ({}),
  exec: async () => ({}),
  fetch: async () => new Response(""),
  getPlatform: async () => "linux",
  getArch: async () => "x64",
  getEnv: async () => ({}),
  homedir: async () => "/tmp",
});

const scriptDir = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(scriptDir, "../src");

// ---------------------------------------------------------------------------
// Fixture: drive a plan all the way to retro.
//
// Mirrors validate-plan-lifecycle's setup (the controller's own phase machine),
// but stays at the *controller* level — what this gate asserts is the interaction
// between the phase machine and the runner cache, not plan authoring.
// ---------------------------------------------------------------------------
async function driveToRetro() {
  const todoManager = new TodoManager();
  const invalidations = [];
  const controller = new PlanModeController({
    getTodoManager: () => todoManager,
    // Recorded exactly as ManagedAgent wires it (managed-agent.ts).
    onPhaseChange: () => invalidations.push(controller.getPhase()),
  });
  const bus = createAgentEventBus();
  todoManager.setEventBus(bus);
  controller.setEventBus(bus);

  controller.enable();
  await controller.applyStructuredPlan({
    goal: "Continuation demo",
    steps: ["One", "Two"],
    keyFiles: ["src/index.ts"],
  });
  controller.beginExecution();
  assert.equal(controller.getPhase(), "executing", "fixture: plan is executing");

  const beforeRetro = invalidations.length;
  todoManager.update(
    todoManager.getItems().map((item) => ({ ...item, status: "completed" })),
    PLAN_TODO_TITLE
  );

  return { controller, todoManager, invalidations, beforeRetro };
}

// ---------------------------------------------------------------------------
// 0. Canary — the fixture must actually reach retro, and the stub below must be
// able to build a runner. Both failing open would make every assertion vacuous.
// ---------------------------------------------------------------------------
function makeManagedStub(controller) {
  const noop = () => {};
  return {
    id: "validation-agent",
    parentId: undefined,
    config: {},
    run: {},
    tools: {
      // The completion tool exists in the agent's registry; whether the *runner*
      // exposes it is exactly what `resolveTanStackTools` decides per phase.
      complete_plan: { name: "complete_plan", description: "", inputSchema: {} },
      read_file: { name: "read_file", description: "", inputSchema: {} },
    },
    statusController: {},
    getApprovals: () => ({ toArray: () => [], upsert: noop }),
    usageHistory: { record: noop },
    usage: {},
    session: { getSessionData: () => ({ id: "validation-session" }) },
    getTodoManager: () => undefined,
    getExtensionRunner: () => undefined,
    getStreamHub: () => new AgentStreamHub(),
    getLog: () => ({
      warn: noop,
      info: noop,
      error: noop,
      debug: noop,
      child: () => ({ warn: noop, info: noop, error: noop, debug: noop }),
    }),
    getWireProjectionCache: () => ({}),
    planMode: controller,
    getSystemPrompt: () => "",
    getFrozenSystemPrompt: () => "",
    getCompactionConfig: () => ({}),
    getModelInfo: () => undefined,
    getConfig: () => ({}),
    getToolCompactCache: () => undefined,
    getDynamicTurnContextSections: () => [],
    maybeSaveSessionUIMessages: noop,
    setIterationProgress: noop,
    getUI: () => undefined,
  };
}

/** Tool names the runner would send to the model in the current plan phase. */
function runnerToolNames(controller) {
  const runner = buildAgentRunner(makeManagedStub(controller), { adapter: {}, model: "validation-model" }, {});
  return (runner.config.tools ?? []).map((tool) => tool.name);
}

{
  const { controller } = await driveToRetro();
  assert.equal(controller.getPhase(), "retro", "canary: the fixture must reach retro");
  assert.ok(
    runnerToolNames(controller).length > 0,
    "canary: the runner stub produced no tools — tool resolution probe is looking at nothing"
  );
  console.log("canary: fixture reaches retro and the runner stub resolves tools");
}

// ---------------------------------------------------------------------------
// 1. The executing → retro flip invalidates the cached runner
// ---------------------------------------------------------------------------
{
  const { invalidations, beforeRetro } = await driveToRetro();

  const duringRetro = invalidations.slice(beforeRetro);
  assert.ok(
    duringRetro.includes("retro"),
    "entering retro must fire onPhaseChange (via notifyChange) so the cached runner is " +
      "invalidated. Without it the continuation pump reuses the `executing` runner, where " +
      "complete_plan is excluded. Recorded phases: " +
      JSON.stringify(duringRetro)
  );

  console.log("invalidation: entering retro fires onPhaseChange → invalidateRunner");
}

// ---------------------------------------------------------------------------
// 2. The retro runner exposes complete_plan (and executing does not)
// ---------------------------------------------------------------------------
{
  const { controller } = await driveToRetro();
  assert.equal(controller.getPhase(), "retro");

  const retroTools = runnerToolNames(controller);
  assert.ok(
    retroTools.includes("complete_plan"),
    "the rebuilt retro runner must expose complete_plan — its absence is precisely what the " +
      "deleted follow-up workaround existed to paper over. Tools: " +
      JSON.stringify(retroTools)
  );

  // Counter-check on the other side of the same branch: the tool must NOT leak into
  // `executing`, or invariant 1 would pass for the wrong reason (available in both).
  const executingTools = runnerToolNames({ getPhase: () => "executing", isRestrictingTools: () => false });
  assert.ok(
    !executingTools.includes("complete_plan"),
    "complete_plan must stay excluded while executing, otherwise the phase-gated tool set " +
      "is not actually phase-gated"
  );

  console.log("tool set: complete_plan present in retro, absent while executing");
}

// ---------------------------------------------------------------------------
// 3. The retro hook stays gone
// ---------------------------------------------------------------------------
{
  const controllerSource = readFileSync(join(srcRoot, "agent/plan/plan-mode-controller.ts"), "utf8");
  const managedSource = readFileSync(join(srcRoot, "managers/managed-agent.ts"), "utf8");
  const restoreSource = readFileSync(join(srcRoot, "managers/managed-agent-session.ts"), "utf8");

  assert.ok(
    !controllerSource.includes("onEnterRetro"),
    "PlanModeControllerDeps must not declare `onEnterRetro` again — it existed only to send the " +
      "retro steer message, and its return would reinstate the duplicate delivery."
  );
  assert.ok(
    !managedSource.includes("buildPlanRetroSteerMessage"),
    "managed-agent.ts must not re-enqueue a retro steer message; the in-run continuation already " +
      "delivers complete_plan in the same run."
  );

  // Wiring pin: the repair only works if it runs AFTER the adoption (which is what overwrote it).
  const adoptAt = restoreSource.indexOf("adoptRestoredSession(restored");
  const reapplyAt = restoreSource.indexOf("reapplyTodoBinding?.()");
  assert.ok(adoptAt >= 0, "fixture: the restore path still adopts the session");
  assert.ok(reapplyAt > adoptAt, "managed-agent-session must re-assert the plan binding after adoption");

  console.log("removal: no retro steer hook or message remains");
}

// ---------------------------------------------------------------------------
// 3b. A restore re-asserts the plan binding AFTER the todo list is adopted
// ---------------------------------------------------------------------------
//
// `mode.restore` runs before `adoptRestoredSession` (the commit must be last), so its
// `setPlanBound(true)` was overwritten by `restoreTodos(planBound: session.todoPlanBound)`. An
// `executing` session whose persisted flag was false (the legacy mismatch the repair exists for)
// then never reached `retro`, and `complete_plan` stayed hidden.
{
  const todoManager = new TodoManager();
  const controller = new PlanModeController({ getTodoManager: () => todoManager });
  controller.enable();
  await controller.applyStructuredPlan({
    goal: "Restore binding",
    steps: ["One", "Two"],
    keyFiles: ["src/index.ts"],
  });
  controller.beginExecution();

  const items = todoManager.getItems().map((item) => ({ ...item, status: "completed" }));
  // Exactly what adoption does: the persisted flag wins over the repair `restoreState` made.
  todoManager.restoreTodos(items, { planBound: false });
  assert.equal(todoManager.getSource(), "agent", "fixture: adoption overwrote the plan binding");
  assert.equal(controller.getPhase(), "executing", "fixture: the session is still executing");

  controller.reapplyTodoBinding();
  assert.equal(todoManager.getSource(), "plan", "reapply restores plan ownership of the adopted list");
  assert.equal(
    controller.getPhase(),
    "retro",
    "a completed plan must reach retro after a restore — otherwise complete_plan is unreachable"
  );

  console.log("restore: plan binding re-applied after adoption, retro reachable");
}

console.log("\nplan retro continuation validation passed");
