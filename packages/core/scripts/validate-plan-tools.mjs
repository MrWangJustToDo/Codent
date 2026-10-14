/**
 * Validation for plan-mode tool exclusions, planning prompts, and structured plans.
 *
 * Run: pnpm --filter @codent/core run validate:plan-tools
 */
import assert from "node:assert/strict";

import {
  PLAN_AUTHORING_TOOL_NAMES,
  PLAN_COMPLETION_TOOL_NAMES,
  PLAN_MODE_EXCLUDED_NON_EDIT_TOOL_NAMES,
  PlanModeController,
  buildPlanModePlanningPrompt,
  buildPlanModeReadyPrompt,
  buildPlanModeRetroPrompt,
  createAgentEventBus,
  createDeleteFileTool,
  createEditFileTool,
  createWriteFileTool,
  formatStructuredPlanMarkdown,
  isPlanModeForbiddenTool,
} from "../dist/dev.mjs";

// Plan mode withholds by DECLARATION now, and a declaration is registered when a tool is defined —
// so the tools have to exist before the boundary can be read. `validate:plan-tool-boundary` drives the
// derivation itself (including a tool that writes and is on no list).
createDeleteFileTool();
createEditFileTool();
createWriteFileTool();

assert.ok(!PLAN_MODE_EXCLUDED_NON_EDIT_TOOL_NAMES.has("task"), "task must remain available in plan mode");
assert.ok(
  !PLAN_MODE_EXCLUDED_NON_EDIT_TOOL_NAMES.has("write_file"),
  "editing tools are derived from their declaration, not listed here"
);
assert.ok(PLAN_MODE_EXCLUDED_NON_EDIT_TOOL_NAMES.has("kill_command"), "the non-editing exception stays named");
for (const name of ["write_file", "edit_file", "delete_file"]) {
  assert.equal(isPlanModeForbiddenTool(name), true, `${name} edits the workspace, so plan mode withholds it`);
}
assert.equal(isPlanModeForbiddenTool("task"), false, "subagents are already read-only");
assert.equal(isPlanModeForbiddenTool("run_command"), false, "the command allowlist governs run_command, not this set");
assert.equal(isPlanModeForbiddenTool("mcp__foo"), true, "an MCP tool's effects are unknown");
assert.ok(PLAN_AUTHORING_TOOL_NAMES.has("create_plan"));
assert.ok(PLAN_AUTHORING_TOOL_NAMES.has("update_plan"));
assert.ok(PLAN_COMPLETION_TOOL_NAMES.has("complete_plan"));

const planning = buildPlanModePlanningPrompt();
assert.ok(planning.includes("task"), "planning prompt must mention task exploration");
assert.ok(planning.includes("create_plan"), "planning prompt must mention create_plan");
assert.ok(planning.includes("ask_user"), "planning prompt must mention ask_user for clarifying questions");
assert.ok(/clarif/i.test(planning));
assert.ok(planning.includes(".agents/plans"), "planning prompt must mention plan file location");
assert.ok(/verification/i.test(planning), "planning prompt must require verification");
assert.ok(/task status/i.test(planning), "planning prompt must judge task results via status flags");
assert.ok(/trustworthy|extendable/i.test(planning), "planning prompt must mention trustworthy/extendable judgment");
assert.ok(!/static summary/i.test(planning), "planning prompt should not advertise tool-output static summary");

const ready = buildPlanModeReadyPrompt("## Plan\n1. Do thing", ".agents/plans/x.md");
assert.ok(ready.includes("task"));
assert.ok(ready.includes("update_plan"));
assert.ok(ready.includes("/mode execute"));
assert.ok(/review/i.test(ready));
// Review is where a plan gets read and revised, not where it gets audited: the audit belongs to
// the phase where there is a *result* to audit. So the ready block must stay free of the spawn
// machinery — otherwise a plain plan edit starts a subagent fleet before any code exists.
assert.ok(!/ask_user/i.test(ready), "ready must not gate on a spawn consent question");
assert.ok(!/spawn/i.test(ready), "ready must not ask the model to spawn audit subagents");

// ---------------------------------------------------------------------------
// Retro: the completed-work audit
// ---------------------------------------------------------------------------
const retro = buildPlanModeRetroPrompt("## Plan\n1. Do thing", ".agents/plans/x.md");
assert.ok(retro.includes("complete_plan"), "retro prompt must keep the completion gate");
assert.ok(/verification/i.test(retro), "retro prompt must require verification evidence");

// The audit hangs off the retro phase because that is where `task` is useful for more than
// reading the plan back — there is implemented work to examine by then. These pin the same three
// properties as any spawn instruction: consent, a size bound, and a non-blocking skip.
assert.ok(retro.includes("task"), "retro prompt must offer the subagent audit");
assert.ok(retro.includes("ask_user"), "retro prompt must route the audit through ask_user");
assert.ok(/ask before you spawn/i.test(retro), "retro prompt must require consent before spawning");
assert.ok(/with a skip option/i.test(retro), "the skip must be offered inside the consent question");
assert.ok(/do not ask again/i.test(retro), "a skip must be one-shot, not re-asked");
assert.ok(/do not block/i.test(retro), "an unanswered question must not stall completion");
assert.ok(/do not spawn audit subagents you did not ask about/i.test(retro), "consent gate must be explicit");
assert.ok(/one or two/i.test(retro), "retro prompt must bound the audit size (one or two by default)");
assert.ok(/skip the audit/i.test(retro), "retro prompt must allow skipping the audit for small changes");
assert.ok(/findings, not agreement/i.test(retro), "retro prompt must ask for findings rather than agreement");
assert.ok(/different angles/i.test(retro), "retro prompt must require distinct audit angles");
assert.ok(/do not become a second report/i.test(retro), "audit findings must not become a second artifact");
assert.ok(/changes nothing is a fine outcome/i.test(retro), "an audit may conclude the work is sound");
// The audit is prompted by "Verification passed" not being "the work is right" — that framing is
// the whole reason the phase needs it, so it is worth a guard of its own.
assert.ok(/not the same as the work being right/i.test(retro), "retro must state why verification is not enough");

const md = formatStructuredPlanMarkdown({
  goal: "Add worktree support",
  steps: ["Survey CoreEnv rootPath", "Design API", "Implement"],
  keyFiles: ["packages/core/src/env/index.ts"],
  risks: "Path confusion",
  verification: "pnpm build:core",
});
assert.ok(md.includes("## Plan"));
assert.ok(md.includes("**Goal:**"));
assert.ok(md.includes("1. Survey"));
assert.ok(md.includes("`packages/core/src/env/index.ts`"));

const deduped = formatStructuredPlanMarkdown({
  goal: "Dedup numbers",
  steps: ["1. First step text", "2) Second step text", "3. 3. Third already doubled"],
});
assert.match(deduped, /^1\. First step text$/m);
assert.match(deduped, /^2\. Second step text$/m);
assert.match(deduped, /^3\. Third already doubled$/m);
assert.doesNotMatch(deduped, /1\. 1\./);

const events = [];
const controller = new PlanModeController({ getTodoManager: () => null });
const bus = createAgentEventBus();
bus.on("*", (e) => events.push({ type: e.type, data: e.payload }));
controller.setEventBus(bus);
controller.enable();
const applied = await controller.applyStructuredPlan({
  goal: "Ship feature",
  steps: ["Explore", "Implement", "Verify"],
  keyFiles: ["a.ts"],
});
assert.equal(applied.ok, true);
assert.equal(controller.getPhase(), "ready");
assert.equal(controller.getState().steps.length, 3);
assert.ok(events.some((e) => e.type === "plan:ready"));

const rejected = await controller.applyStructuredPlan({ goal: "", steps: [] });
assert.equal(rejected.ok, false);

console.log("validate:plan-tools OK");
