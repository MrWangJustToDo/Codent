/**
 * Authorization matrix: tool class × mode × profile/path × annotations × persisted decision.
 *
 * This matrix drives the composer over the combinations a host can actually produce, including
 * the precedence cases (a terminal deny before auto, an extension deny over an analysis allow),
 * so a new gate cannot be added without a case here.
 *
 * Rules/env dimensions are not represented yet: the policy facts carry `env`, but no rule engine
 * evaluates it in core. When it lands, add the cases here rather than a second script.
 *
 * Run: pnpm --filter @codent/core run validate:authorize-matrix
 */

import assert from "node:assert/strict";

import { authorizeToolCall } from "../dist/dev.mjs";

const FREE = { requiresApproval: false, source: "declared" };
const GATED = { requiresApproval: true, source: "declared" };

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

const cases = [
  {
    name: "root / free tool",
    input: { toolName: "read_file", facts: facts(), approval: FREE },
    expect: { action: "allow", source: "declarative" },
  },
  {
    name: "root / declaratively gated",
    input: { toolName: "write_file", facts: facts(), approval: GATED },
    expect: { action: "ask", source: "declarative" },
  },
  {
    name: "auto / gated",
    input: { toolName: "write_file", facts: facts({ auto: true }), approval: GATED },
    expect: { action: "allow", source: "auto" },
  },
  {
    name: "plan executing + seeded / gated",
    input: {
      toolName: "write_file",
      facts: facts({ planPhase: "executing", todosSeeded: true, planExecutionAutoApprove: true }),
      approval: GATED,
    },
    expect: { action: "allow", source: "auto" },
  },
  {
    name: "plan ready / gated never inherits execution approval",
    input: {
      toolName: "write_file",
      facts: facts({ planPhase: "ready", todosSeeded: true }),
      approval: GATED,
    },
    expect: { action: "ask", source: "declarative" },
  },
  {
    name: "explore subagent / mutating tool unavailable (auto does not reopen it)",
    input: {
      toolName: "write_file",
      facts: facts({ profile: "explore", isSubagent: true, auto: true, unavailableTools: new Set(["write_file"]) }),
      approval: GATED,
    },
    expect: { action: "deny", source: "availability" },
  },
  {
    name: "subagent path rule / hard deny beats auto",
    input: {
      toolName: "run_command",
      facts: facts({ auto: true, isSubagent: true, profile: "explore" }),
      approval: GATED,
      hardPolicy: { action: "deny", source: "policy", reason: "subagent external path" },
    },
    expect: { action: "deny", source: "policy" },
  },
  {
    name: "MCP readOnlyHint / free",
    input: { toolName: "mcp__fs__read", facts: facts(), approval: FREE },
    expect: { action: "allow", source: "declarative" },
  },
  {
    name: "MCP no annotation / requires approval",
    input: { toolName: "mcp__fs__write", facts: facts(), approval: GATED },
    expect: { action: "ask", source: "declarative" },
  },
  {
    name: "persisted approved / executes once",
    input: { toolName: "write_file", facts: facts(), approval: GATED, persisted: "approved" },
    expect: { action: "allow", source: "persisted" },
  },
  {
    name: "persisted pending / keeps interrupting",
    input: { toolName: "write_file", facts: facts(), approval: GATED, persisted: "pending" },
    expect: { action: "ask", source: "persisted" },
  },
  {
    name: "persisted denied / terminal even in auto",
    input: { toolName: "write_file", facts: facts({ auto: true }), approval: GATED, persisted: "denied" },
    expect: { action: "deny", source: "persisted" },
  },
  {
    name: "run_command / read-only analysis allows the gated tool",
    input: {
      toolName: "run_command",
      facts: facts(),
      approval: GATED,
      analyzeCommand: async () => ({ action: "allow", source: "command-analysis" }),
    },
    expect: { action: "allow", source: "command-analysis" },
  },
  {
    name: "run_command / analysis denies an answered call",
    input: {
      toolName: "run_command",
      facts: facts(),
      approval: GATED,
      persisted: "approved",
      analyzeCommand: async () => ({ action: "deny", source: "command-analysis", reason: "unsafe" }),
    },
    expect: { action: "deny", source: "command-analysis" },
  },
  {
    name: "env rule / an override is a hard deny before auto",
    input: {
      toolName: "run_command",
      facts: facts({ auto: true, env: { CI: "1" } }),
      approval: GATED,
      hardPolicy: { action: "deny", source: "policy", reason: "env override changes the program" },
    },
    expect: { action: "deny", source: "policy" },
  },
  {
    name: "rules / destructive deny is not auto-approved",
    input: {
      toolName: "run_command",
      facts: facts({ auto: true }),
      approval: GATED,
      hardPolicy: { action: "deny", source: "policy", reason: "destructive rule" },
    },
    expect: { action: "deny", source: "policy" },
  },
  {
    name: "auto / extension skip still denies",
    input: {
      toolName: "run_command",
      facts: facts({ auto: true }),
      approval: GATED,
      extensionHooks: async () => ({ action: "deny", source: "extension", reason: "blocked" }),
    },
    expect: { action: "deny", source: "extension" },
  },
  {
    name: "run_command / analysis ask keeps the declarative ask",
    input: {
      toolName: "run_command",
      facts: facts(),
      approval: GATED,
      analyzeCommand: async () => ({ action: "ask", source: "command-analysis" }),
    },
    expect: { action: "ask", source: "command-analysis" },
  },
  {
    name: "root / free tool is allowed without a prompt",
    input: { toolName: "read_file", facts: facts(), approval: FREE },
    expect: { action: "allow", source: "declarative" },
  },
  {
    name: "extension skip / deny beats an analysis allow",
    input: {
      toolName: "run_command",
      facts: facts(),
      approval: GATED,
      analyzeCommand: async () => ({ action: "allow", source: "command-analysis" }),
      extensionHooks: async () => ({ action: "deny", source: "extension", reason: "blocked" }),
    },
    expect: { action: "deny", source: "extension" },
  },
];

for (const testCase of cases) {
  const decision = await authorizeToolCall(testCase.input);
  assert.equal(decision.action, testCase.expect.action, `${testCase.name}: action`);
  assert.equal(decision.source, testCase.expect.source, `${testCase.name}: source`);
}

console.log(`authorize matrix validation passed (${cases.length} cases)`);
