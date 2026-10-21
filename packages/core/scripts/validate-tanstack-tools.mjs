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
  getReadOnlyTanStackToolNames,
  resolveToolsRecord,
} from "../dist/dev.mjs";

const readOnlyNames = getReadOnlyTanStackToolNames();
assert.deepEqual(readOnlyNames, ["read_file", "glob", "grep", "list_file", "tree", "webfetch", "websearch"]);

const baseTools = resolveToolsRecord(await createTools());
const baseNames = baseTools.map((t) => t.name).sort();
assert.ok(baseNames.includes("read_file"));
assert.ok(baseNames.includes("run_command"));
assert.ok(baseNames.includes("glob"));

const subagentTools = resolveToolsRecord(createSubagentTools());
const subagentNames = new Set(subagentTools.map((t) => t.name));
for (const name of readOnlyNames) {
  assert.ok(subagentNames.has(name), `missing subagent tool: ${name}`);
}
assert.ok(subagentNames.has("webfetch"), "missing subagent tool: webfetch");
assert.ok(subagentNames.has("websearch"), "missing subagent tool: websearch");
// run_command is present for subagents but restricted to the read-only safety
// policy (subagentSafe => needsApproval false); write/edit/delete and task
// delegation remain excluded.
const subagentRunCommand = subagentTools.find((t) => t.name === "run_command");
assert.ok(subagentRunCommand, "missing subagent tool: run_command");
assert.equal(subagentRunCommand.needsApproval, false, "subagent run_command must be subagentSafe");
assert.ok(!subagentNames.has("write_file"));
assert.ok(!subagentNames.has("edit_file"));
assert.ok(!subagentNames.has("delete_file"));
assert.ok(!subagentNames.has("task"));

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
