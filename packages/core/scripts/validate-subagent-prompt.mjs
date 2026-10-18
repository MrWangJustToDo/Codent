/**
 * Validates the explore subagent system prompt.
 *
 * Guards the subagent-prompt upgrade: the explore prompt must carry an explicit
 * read-only delegation boundary, a language-matching instruction, structured
 * result guidance, and must not balloon past a sane length cap.
 *
 * Run: pnpm --filter @codent/core run validate:subagent-prompt
 */

import assert from "node:assert/strict";

import { buildExploreSystemPrompt, createRunCommandTool, createSubagentTools, createTaskTool } from "../dist/dev.mjs";

{
  const prompt = buildExploreSystemPrompt(5);

  // Role + tools.
  assert.match(prompt, /read-only subagent/);
  assert.match(prompt, /begin_summary/);

  // Delegation boundary: read-only, no file modifications; only read-only
  // shell commands allowed inside the project (write/external denied).
  assert.match(prompt, /read-only: no file modifications/);
  assert.match(prompt, /read-only shell commands/);
  assert.match(prompt, /write, background, or external-path commands are denied/);
  assert.match(prompt, /report what needs to change back to the parent agent instead of acting/);
  assert.match(prompt, /Do not expand the task scope beyond what was asked/);
  assert.match(prompt, /5 steps/);

  // Guidelines: language matching + structured references.
  assert.match(prompt, /Match the parent conversation's language/);
  assert.match(prompt, /file_path:line_number/);

  // Length cap guard.
  assert.ok(prompt.length <= 3000, `explore prompt too long: ${prompt.length} chars (cap 3000)`);
}

// ============================================================================
// The parent-facing contract: the task description matches the tool set
// ============================================================================
//
// The description listed seven read-only tools and said the subagent "cannot run shell commands",
// while `subagent-tools.ts` registered `run_command` (read-only variant) and the explore prompt
// documented its denials. Each half was true of a different file, so nothing failed — but a parent
// reading the description does not delegate a command the subagent could have run.

{
  const description = createTaskTool({ parentAgentId: "a", manager: { getAgent: () => undefined } }).description;
  const subagentTools = createSubagentTools();
  // `begin_summary` is the subagent's own completion marker, not a capability the parent delegates.
  const registered = Object.keys(subagentTools).filter((name) => name !== "begin_summary");

  assert.ok(registered.length >= 8, `expected the subagent tool set, found ${registered.join(", ")}`);
  for (const name of registered) {
    assert.ok(description.includes(name), `the task description must name \`${name}\`, which the subagent does get`);
  }
  assert.ok(!/cannot .*run shell commands/i.test(description), "…and must not deny the shell access it has");
  assert.match(description, /read-only, project-internal commands/, "it states which commands are allowed");

  // The subagent's OWN run_command must not advertise background execution. It has no
  // get_command_output / kill_command, and `execute` denies `run_in_background` outright — so the
  // main-agent copy ("Set run_in_background=true … poll with … stop with …") was an offer the tool
  // could only refuse, naming two tools the subagent does not have.
  const subagentRun = subagentTools.run_command;
  assert.ok(subagentRun?.description, "the subagent tool set exposes run_command");
  assert.match(
    subagentRun.description,
    /Background commands are NOT available to subagents/,
    "the subagent run_command description says background is unavailable"
  );
  assert.ok(
    !/Set run_in_background=true/.test(subagentRun.description),
    "…and does not advertise the main-agent background flow"
  );
  assert.ok(!/discover them via/.test(subagentRun.description), "…nor the lazy discovery of tools it does not have");
  assert.match(
    subagentRun.inputSchema.shape.run_in_background.description,
    /Not available to subagents/,
    "the field description agrees with the tool description"
  );

  // The main agent keeps the capability — this is a subagent variant, not a removal.
  assert.match(
    createRunCommandTool().description,
    /Set run_in_background=true/,
    "the main-agent run_command still documents background execution"
  );
}

console.log("subagent-prompt validation passed");
