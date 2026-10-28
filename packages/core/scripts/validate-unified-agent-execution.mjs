/**
 * Unified execution contract.
 *
 * Guards the properties that are easy to erode while refactoring:
 * - one managed-span call site (root + child share it);
 * - profiles are configuration, not extra lifecycles;
 * - task stays explore-only with UI-only profile metadata;
 * - logs carry scope, and parent child-lifecycle records are index-only;
 * - child profiles do not acquire session persistence.
 *
 * Run: pnpm --filter @codent/core run validate:unified-agent-execution
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENT_PROFILE_IDS,
  AgentLog,
  logEntrySchema,
  logSubagentLifecycle,
  subagentResultToTaskOutput,
  taskOutputSchema,
} from "../dist/dev.mjs";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const read = (rel) => readFileSync(join(SRC, rel), "utf8");

// ---------------------------------------------------------------------------
// Agent kinds are a toolset/profile id, not a second execution layer
// ---------------------------------------------------------------------------
const factory = read("managers/agent-factory.ts");
assert.match(factory, /const toolsetProfile = config\.toolsetProfile/, "toolset is selected by config");
assert.match(factory, /buildToolset\(\{ profile: toolsetProfile/, "factory selects the toolset once");
assert.ok(!/execution\//.test(factory), "the factory does not depend on an execution layer");

const runSubagent = read("agent/subagent/run-subagent.ts");
assert.match(runSubagent, /profileId \?\? "explore"/, "children default to the explore profile id");
assert.match(runSubagent, /runManagedSpan/, "children reach the shared managed-span helper directly");
assert.match(
  runSubagent,
  /effectiveProfileId !== "internal" && Boolean\(parentTaskToolCallId\)/,
  "task-row projection is derived from profile + parent task id"
);
assert.ok(!/uiProjection/.test(runSubagent), "the removed uiProjection policy does not linger");

// ---------------------------------------------------------------------------
// One managed span: only the helper calls the run skeleton directly
// ---------------------------------------------------------------------------
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const directCalls = [];
for (const file of walk(SRC)) {
  const rel = relative(SRC, file).replaceAll("\\", "/");
  if (rel === "agent/run/run-agent-skeleton.ts" || rel === "agent/run/managed-span.ts") continue;
  if (/\brunAgentOnce\s*\(/.test(readFileSync(file, "utf8"))) directCalls.push(rel);
}
assert.deepEqual(directCalls, [], `only the managed span may call runAgentOnce; found: ${directCalls.join(", ")}`);
assert.match(read("agent/run/managed-span.ts"), /\brunAgentOnce\s*\(/, "the helper owns the run call");
assert.match(read("agent/run/managed-span.ts"), /abortErrorAsCancel/, "the helper parameterizes abort-shaped errors");
assert.match(
  read("managers/controllers/agent-chat-controller.ts"),
  /abortErrorAsCancel: false/,
  "root keeps abort-shaped errors as errors"
);
assert.match(
  read("managers/controllers/agent-chat-controller.ts"),
  /onExternalError\(message\)/,
  "the root's abort-shaped error is terminal (status error), not text-only"
);
assert.match(
  read("agent/subagent/run-subagent.ts"),
  /abortErrorAsCancel: true/,
  "child keeps abort-shaped errors as cancels"
);
assert.ok(
  !/from\s+["'][^"']*managers\//.test(read("agent/run/managed-span.ts")),
  "the helper does not import managers"
);

// ---------------------------------------------------------------------------
// task adapter: explore-only, UI-only profile metadata
// ---------------------------------------------------------------------------
assert.match(read("agent/subagent/task-tool.ts"), /profile: z\.enum\(AGENT_PROFILE_IDS\)\.optional\(\)/);
const taskInput = read("agent/subagent/task-tool.ts").split("inputSchema:")[1]?.split("outputSchema:")[0] ?? "";
assert.ok(!/\bagent\b/.test(taskInput), "task input must not expose a profile/agent selector");

const profileOnly = subagentResultToTaskOutput({
  subagentId: "s1",
  profile: "explore",
  output: "ok",
  truncated: false,
  iterations: 1,
  maxIterations: 2,
  durationMs: 3,
  usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, billedInputTokens: 1 },
  reachedLimit: false,
  incomplete: false,
  aborted: false,
});
assert.equal(profileOnly.profile, "explore");
assert.equal(taskOutputSchema.parse({ ...profileOnly, cachedOutputPath: null }).profile, "explore");
const taskSource = read("agent/subagent/task-tool.ts");
const modelOutput = taskSource.split("toModelOutput")[1];
assert.ok(modelOutput, "toModelOutput still exists");
assert.ok(!/output\.profile/.test(modelOutput), "profile stays out of model output");

// ---------------------------------------------------------------------------
// Task-row projection is derived; there is no separate uiProjection policy
// ---------------------------------------------------------------------------
assert.ok(!/uiProjection/.test(runSubagent), "the uiProjection policy is gone");
assert.match(
  runSubagent,
  /effectiveProfileId !== "internal" && Boolean\(parentTaskToolCallId\)/,
  "non-internal children with a task id project; internal workers never do"
);
assert.ok(!/bridgeUI/.test(runSubagent), "bridgeUI is gone");

// ---------------------------------------------------------------------------
// Scoped logging + parent index
// ---------------------------------------------------------------------------
const entries = [];
const log = new AgentLog({ scope: { profile: "explore", taskCallId: "tc1" } });
log.attachSink({ handleEntry: (entry) => entries.push(entry) });
log.info("tool", "scoped child entry");
assert.equal(entries.length, 1);
assert.deepEqual(entries[0].scope, { profile: "explore", taskCallId: "tc1" });
assert.equal(logEntrySchema.safeParse(entries[0]).success, true);
assert.equal(
  logEntrySchema.safeParse({ id: "x", timestamp: 1, level: "info", category: "tool", message: "no scope" }).success,
  false,
  "scope is required by the persisted schema"
);
for (const profile of AGENT_PROFILE_IDS) {
  assert.equal(
    logEntrySchema.safeParse({
      scope: { profile },
      id: "x",
      timestamp: 1,
      level: "info",
      category: "tool",
      message: "profile scope",
    }).success,
    true,
    `log schema accepts profile ${profile}`
  );
}
assert.equal(
  logEntrySchema.safeParse({
    scope: { profile: "root" },
    id: "x",
    timestamp: 1,
    level: "info",
    category: "tool",
    message: "extra",
    unexpected: true,
  }).success,
  false,
  "the persisted schema rejects unknown top-level fields"
);
assert.equal(
  logEntrySchema.safeParse({
    scope: { profile: "root", unexpected: true },
    id: "x",
    timestamp: 1,
    level: "info",
    category: "tool",
    message: "extra scope",
  }).success,
  false,
  "the persisted schema rejects unknown scope fields"
);

const parentEntries = [];
const parentLog = new AgentLog({ scope: { profile: "root" } });
parentLog.attachSink({ handleEntry: (entry) => parentEntries.push(entry) });
logSubagentLifecycle(parentLog, "completed", {
  subagentId: "s1",
  parentTaskToolCallId: "tc1",
  iterations: 2,
  maxIterations: 50,
  durationMs: 10,
  usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
});
assert.equal(parentEntries.length, 1);
assert.equal(parentEntries[0].data?.indexOnly, true);
assert.equal(parentEntries[0].scope.profile, "root");
assert.deepEqual(parentEntries[0].data?.usage, { inputTokens: 4, outputTokens: 2, totalTokens: 6 });

console.log("unified-agent-execution validation passed");
