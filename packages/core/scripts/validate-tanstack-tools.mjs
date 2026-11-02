/**
 * Validates TanStack tool bridging and subagent read-only subsets.
 *
 * Run: pnpm --filter @codent/core run validate:tanstack-tools
 */

import assert from "node:assert/strict";

import {
  createExtensionsMiddleware,
  createSubagentTools,
  createTools,
  resolveToolsRecord,
  SUBAGENT_READ_ONLY_TOOL_NAMES,
  SUBAGENT_TOOL_NAMES,
} from "../dist/dev.mjs";

const subagentTools = resolveToolsRecord(createSubagentTools());
const subagentNames = subagentTools.map((tool) => tool.name).sort();
assert.deepEqual([...SUBAGENT_TOOL_NAMES].sort(), subagentNames, "the declared subagent set matches the tools built");
assert.deepEqual(
  [...SUBAGENT_READ_ONLY_TOOL_NAMES].sort(),
  subagentNames.filter((name) => name !== "begin_summary"),
  "the read-only projection is every built subagent tool except the begin_summary marker"
);
assert.ok(SUBAGENT_READ_ONLY_TOOL_NAMES.includes("run_command"), "the restricted read-only run_command is included");
assert.ok(!SUBAGENT_READ_ONLY_TOOL_NAMES.includes("begin_summary"), "the summary marker is not a read-only tool");

const baseTools = resolveToolsRecord(await createTools());
const baseNames = baseTools.map((t) => t.name).sort();
assert.ok(baseNames.includes("read_file"));
assert.ok(baseNames.includes("run_command"));
assert.ok(baseNames.includes("glob"));

const subagentNameSet = new Set(subagentNames);
for (const name of SUBAGENT_READ_ONLY_TOOL_NAMES) {
  assert.ok(subagentNameSet.has(name), `missing subagent tool: ${name}`);
}
assert.ok(subagentNameSet.has("webfetch"), "missing subagent tool: webfetch");
assert.ok(subagentNameSet.has("websearch"), "missing subagent tool: websearch");
// run_command is present for subagents but restricted to the read-only safety
// policy (subagentSafe => needsApproval false); write/edit/delete and task
// delegation remain excluded.
const subagentRunCommand = subagentTools.find((t) => t.name === "run_command");
assert.ok(subagentRunCommand, "missing subagent tool: run_command");
assert.equal(subagentRunCommand.needsApproval, false, "subagent run_command must be subagentSafe");
assert.ok(!subagentNameSet.has("write_file"));
assert.ok(!subagentNameSet.has("edit_file"));
assert.ok(!subagentNameSet.has("delete_file"));
assert.ok(!subagentNameSet.has("task"));

const runCommand = baseTools.find((t) => t.name === "run_command");
assert.ok(runCommand, "run_command tool missing");
assert.equal(runCommand.needsApproval, true);
assert.equal(runCommand.__toolSide, "server");

const extensions = createExtensionsMiddleware({
  getExtensionRunner: () => null,
  getSessionId: () => "session-1",
  log: null,
});
assert.equal(extensions.name, "extensions");
assert.equal(typeof extensions.onBeforeToolCall, "function");
assert.equal(typeof extensions.onAfterToolCall, "function");

console.log("tanstack-tools validation passed");
