/**
 * The one authorization pipeline: stage order, deny precedence, and the declarative requirement.
 *
 * Run: pnpm --filter @codent/core run validate:authorize-pipeline
 */

import assert from "node:assert/strict";

import { authorizeToolCall, resolveApprovalRequirement } from "../dist/dev.mjs";

function facts(overrides = {}) {
  return {
    planPhase: "off",
    auto: false,
    todosSeeded: false,
    planExecutionAutoApprove: false,
    toolAvailability: { phase: "off", restrictsMutations: false, hiddenTools: new Set() },
    profile: "root",
    isSubagent: false,
    capabilities: null,
    unavailableTools: new Set(),
    env: {},
    ...overrides,
  };
}

const allow = { action: "allow", source: "command-analysis" };
const deny = { action: "deny", source: "command-analysis", reason: "unsafe" };
const ask = { action: "ask", source: "command-analysis" };

// Declarative requirement composition (fail closed only where a tool exists but cannot be read).
assert.deepEqual(resolveApprovalRequirement({ needsApproval: true }), {
  requiresApproval: true,
  source: "declared",
});
assert.equal(resolveApprovalRequirement({ needsApproval: false }).requiresApproval, false);
assert.equal(resolveApprovalRequirement({}).requiresApproval, false);
assert.equal(resolveApprovalRequirement(null).requiresApproval, true, "an unreadable tool fails closed");

// Availability denies before auto mode can approve.
{
  const decision = await authorizeToolCall({
    toolName: "write_file",
    args: {},
    facts: facts({ auto: true, unavailableTools: new Set(["write_file"]) }),
  });
  assert.equal(decision.action, "deny");
  assert.equal(decision.source, "availability");
}

// A hard-policy deny beats auto mode.
{
  const decision = await authorizeToolCall({
    toolName: "run_command",
    args: {},
    facts: facts({ auto: true }),
    hardPolicy: { action: "deny", source: "policy", reason: "subagent external path" },
  });
  assert.equal(decision.action, "deny");
  assert.equal(decision.source, "policy");
}

// A recorded denial is terminal even in auto mode.
{
  const decision = await authorizeToolCall({
    toolName: "run_command",
    args: {},
    facts: facts({ auto: true }),
    persisted: "denied",
  });
  assert.equal(decision.action, "deny");
  assert.equal(decision.source, "persisted");
}

// Auto mode allows a declaratively gated tool.
{
  const decision = await authorizeToolCall({
    toolName: "write_file",
    args: {},
    facts: facts({ auto: true }),
    approval: { requiresApproval: true, source: "declared" },
  });
  assert.equal(decision.action, "allow");
  assert.equal(decision.source, "auto");
}

// Plan execution (seeded) allows; review does not.
{
  const executing = await authorizeToolCall({
    toolName: "write_file",
    args: {},
    facts: facts({ planExecutionAutoApprove: true }),
    approval: { requiresApproval: true, source: "declared" },
  });
  assert.equal(executing.action, "allow");
  const review = await authorizeToolCall({
    toolName: "write_file",
    args: {},
    facts: facts({ planPhase: "ready" }),
    approval: { requiresApproval: true, source: "declared" },
  });
  assert.equal(review.action, "ask");
  assert.equal(review.source, "declarative");
}

// A free tool is allowed without a prompt.
{
  const decision = await authorizeToolCall({
    toolName: "read_file",
    args: {},
    facts: facts(),
    approval: { requiresApproval: false, source: "declared" },
  });
  assert.equal(decision.action, "allow");
  assert.equal(decision.source, "declarative");
}

// Command analysis can allow a read-only command that the tool gates by default.
{
  const decision = await authorizeToolCall({
    toolName: "run_command",
    args: { command: "git status" },
    facts: facts(),
    approval: { requiresApproval: true, source: "declared" },
    analyzeCommand: async () => allow,
  });
  assert.equal(decision.action, "allow");
  assert.equal(decision.source, "command-analysis");
}

// …but a deny wins over a recorded approval (the safety override).
{
  const decision = await authorizeToolCall({
    toolName: "run_command",
    args: { command: "rm -rf /" },
    facts: facts(),
    approval: { requiresApproval: true, source: "declared" },
    persisted: "approved",
    analyzeCommand: async () => deny,
  });
  assert.equal(decision.action, "deny");
  assert.equal(decision.source, "command-analysis");
}

// …and an extension deny wins over a command-analysis allow.
{
  const decision = await authorizeToolCall({
    toolName: "run_command",
    args: {},
    facts: facts(),
    analyzeCommand: async () => allow,
    extensionHooks: async () => ({ action: "deny", source: "extension", reason: "blocked by extension" }),
  });
  assert.equal(decision.action, "deny");
  assert.equal(decision.source, "extension");
}

// A recorded approval settles the declarative ask once no later stage denies.
{
  const decision = await authorizeToolCall({
    toolName: "write_file",
    args: {},
    facts: facts(),
    approval: { requiresApproval: true, source: "declared" },
    persisted: "approved",
  });
  assert.equal(decision.action, "allow");
  assert.equal(decision.source, "persisted");
}

// A pending answer keeps interrupting (omitted from the resume map by the caller).
{
  const decision = await authorizeToolCall({
    toolName: "write_file",
    args: {},
    facts: facts(),
    approval: { requiresApproval: true, source: "declared" },
    persisted: "pending",
  });
  assert.equal(decision.action, "ask");
  assert.equal(decision.source, "persisted");
}

// An analysis `ask` keeps the declarative ask, with the analysis as its source.
{
  const decision = await authorizeToolCall({
    toolName: "run_command",
    args: {},
    facts: facts(),
    approval: { requiresApproval: true, source: "declared" },
    analyzeCommand: async () => ask,
  });
  assert.equal(decision.action, "ask");
  assert.equal(decision.source, "command-analysis");
}

console.log("authorize pipeline validation passed");
