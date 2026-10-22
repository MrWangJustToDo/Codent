import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runManagedSpan } from "../dist/dev.mjs";

// The projection is derived from the caller's task id; there is no separate policy value.
const runSubagent = readFileSync(
  join(fileURLToPath(new URL("../src/", import.meta.url)), "agent/subagent/run-subagent.ts"),
  "utf8"
);
assert.match(
  runSubagent,
  /effectiveProfileId !== "internal" && Boolean\(parentTaskToolCallId\)/,
  "a non-internal child projects only when its caller supplied a task id"
);
assert.ok(!/uiProjection/.test(runSubagent), "the uiProjection policy is gone");

let seen;
const channel = {
  async consumeRun(options) {
    seen = options;
    return [];
  },
  getMessages() {
    return [];
  },
};
const managed = { getStatus: () => "idle", getAbortSignal: () => undefined, getUI: () => channel };
const manager = {
  getAgent: () => managed,
  runAgentStream: () =>
    (async function* () {
      yield { type: "RUN_FINISHED" };
    })(),
};

await runManagedSpan({
  manager,
  agentId: "agent_task_projection",
  messages: [],
  channel,
  parentTaskToolCallId: "tc_1",
  flagEmptyStream: false,
});
assert.equal(seen.parentTaskToolCallId, "tc_1", "the managed span forwards the caller's task id");

await runManagedSpan({
  manager,
  agentId: "agent_no_task_projection",
  messages: [],
  channel,
  flagEmptyStream: false,
});
assert.equal(seen.parentTaskToolCallId, undefined, "a run without a task id has no parent-row projection");

console.log("subagent-task-projection validation passed");
