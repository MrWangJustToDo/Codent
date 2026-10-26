/**
 * Validates Event→Log bridge policy and routing under the timeline contract:
 * bridged entries land in the JSONL sink, large payloads are summarized to
 * size + preview (never inlined), memory debug streams are silent, and
 * approval resolution events are bridged.
 *
 * Run: pnpm --filter @codent/core run validate:event-log-bridge
 */

import assert from "node:assert/strict";

import {
  bridgeTelemetryToAgentLog,
  createAgentEventBus,
  DEFAULT_EVENT_LOG_RULES,
  SPECIALIZED_EVENT_LOG,
  SPECIALIZED_EVENT_LOG_TYPES,
} from "../dist/dev.mjs";

import { createLogCapture, waitFor } from "./helpers/log-capture.mjs";

const capture = await createLogCapture("event-log-bridge");
const { log, readEntries } = capture;
const bus = createAgentEventBus();

bridgeTelemetryToAgentLog(bus, () => log);

async function emitAndRead(event) {
  const before = (await readEntries()).length;
  bus.emit(event.type, event.payload, {
    agentId: event.agentId,
    ...(event.parentId !== undefined ? { parentId: event.parentId } : {}),
  });
  // Wait for a NEW entry, not merely a non-empty file: the sink is append-only and this
  // helper is called repeatedly, so `length > 0` is satisfied by the previous event's
  // entry and would hand back a stale snapshot.
  await waitFor(readEntries, (entries) => entries.length > before);
  return readEntries();
}

let entries = await emitAndRead({
  type: "session:doc",
  ts: Date.now(),
  agentId: "agent-1",
  payload: { message: "Loaded instructions from AGENTS.md (1.0 KB)" },
});
const docEntry = entries.find((entry) => entry.category === "system");
assert.ok(docEntry);
assert.match(docEntry.message, /AGENTS\.md/);
assert.equal(docEntry.event, "session:doc", "bridged entries are stamped with the originating event type");

entries = await emitAndRead({
  type: "agent:tool-start",
  ts: Date.now(),
  agentId: "agent-1",
  payload: {
    tool_name: "read_file",
    tool_call_id: "tc-1",
    // Large payload must be summarized, not inlined.
    tool_input: { path: "big.txt", content: "x".repeat(5000) },
    eventType: "ignored",
  },
});
const toolEntry = entries.find((entry) => entry.category === "tool");
assert.ok(toolEntry);
assert.match(toolEntry.message, /read_file/);
assert.ok(toolEntry.data.inputBytes >= 5000, `inputBytes recorded, got ${JSON.stringify(toolEntry.data)}`);
assert.ok(toolEntry.data.inputPreview.length <= 200, "preview is truncated to 200 chars");
assert.equal(toolEntry.data.tool_input, undefined, "tool_input never inlined");
assert.equal(toolEntry.data.eventType, undefined, "redundant eventType dropped");
assert.equal(toolEntry.event, "agent:tool-start", "event type stamped on tool entries");

// memory:prefetch success/empty outcomes are silent (only errors log).
entries = await emitAndRead({
  type: "memory:prefetch",
  ts: Date.now(),
  agentId: "agent-1",
  payload: { status: "injected", count: 2, filenames: ["a.md", "b.md"] },
});
assert.ok(
  !entries.some((entry) => entry.category === "memory" && entry.level === "debug"),
  "memory prefetch success must be silent"
);

entries = await emitAndRead({
  type: "subagent:completed",
  ts: Date.now(),
  agentId: "sub-1",
  parentId: "agent-1",
  payload: { subagentId: "sub-1", summary: "Found the test framework", iterations: 3, durationMs: 12000 },
});
const subagentEntry = entries.find((entry) => entry.message.includes("Subagent completed"));
assert.ok(subagentEntry);
assert.match(subagentEntry.message, /Found the test framework/);
assert.ok(!subagentEntry.message.includes("(no summary)"));
assert.equal(subagentEntry.data.iterations, 3, "subagent iterations carried in data");
assert.equal(subagentEntry.data.durationMs, 12000, "subagent durationMs carried in data");

entries = await emitAndRead({
  type: "agent:tool-approval-request",
  ts: Date.now(),
  agentId: "agent-1",
  payload: { tool_name: "run_command", tool_call_id: "tc-1", approval_id: "ap-1" },
});
const approvalRequestEntry = entries.find((entry) => entry.message.startsWith("Approval requested"));
assert.ok(approvalRequestEntry);
assert.match(approvalRequestEntry.message, /run_command/);

entries = await emitAndRead({
  type: "agent:tool-approval-resolved",
  ts: Date.now(),
  agentId: "agent-1",
  payload: { tool_name: "run_command", tool_call_id: "tc-1", decision: "denied", reason: "unsafe rm -rf" },
});
const approvalResolvedEntry = entries.find((entry) => entry.message.startsWith("Approval resolved"));
assert.ok(approvalResolvedEntry, "approval-resolved event is bridged");
assert.match(approvalResolvedEntry.message, /run_command/);
assert.match(approvalResolvedEntry.message, /denied/);
assert.equal(approvalResolvedEntry.data.decision, "denied");

entries = await emitAndRead({
  type: "compaction:reactive-complete",
  ts: Date.now(),
  agentId: "agent-1",
  payload: { originalCount: 40, compactedCount: 12, tokensBefore: 9000, tokensAfter: 2100 },
});
const reactiveEntry = entries.find((entry) => entry.message.includes("Reactive compact:"));
assert.ok(reactiveEntry);
assert.match(reactiveEntry.message, /40→12 messages/);
assert.match(reactiveEntry.message, /9000→2100 tokens/);
assert.ok(!reactiveEntry.message.includes("?→?"));

// ---------------------------------------------------------------------------
// A cancel must not read as a fault in the log.
//
// Two events carry a user-cancel verdict on a payload whose `error` field holds
// something that is not an error: `agent:tool-end` for a tool that caught its own
// abort (it carries the partial output), and `subagent:error` for a cancelled
// subagent (it carries the partial narration). The second used to be written through
// the error path, which attached that whole paragraph as a stack-bearing exception.
// ---------------------------------------------------------------------------

entries = await emitAndRead({
  type: "agent:tool-end",
  ts: Date.now(),
  agentId: "agent-1",
  payload: { tool_name: "run_command", tool_call_id: "tc-cancel", duration_ms: 4552, cancelled: true },
});
const cancelEndEntry = entries.find(
  (entry) => entry.event === "agent:tool-end" && entry.data?.tool_call_id === "tc-cancel"
);
assert.ok(cancelEndEntry, "a cancelled tool-end is bridged");
assert.match(cancelEndEntry.message, /^Tool cancelled: run_command/, "and is worded as a cancel, not a success");
assert.ok(cancelEndEntry.message.includes("4552ms"), "while keeping the duration the row still shows");

entries = await emitAndRead({
  type: "agent:tool-end",
  ts: Date.now(),
  agentId: "agent-1",
  payload: { tool_name: "read_file", tool_call_id: "tc-ok", duration_ms: 12, cancelled: false },
});
const okEndEntry = entries.find((entry) => entry.event === "agent:tool-end" && entry.data?.tool_call_id === "tc-ok");
assert.ok(okEndEntry, "a clean tool-end is bridged");
assert.match(okEndEntry.message, /^Tool end: read_file/, "a clean call keeps the success wording");

entries = await emitAndRead({
  type: "subagent:error",
  ts: Date.now(),
  agentId: "agent-1",
  payload: {
    subagentId: "subagent-1",
    error: "Let me check the builtin-table.ts… [Task cancelled by user.]",
    cancelled: true,
    stopReason: "user",
  },
});
const cancelSubEntry = entries.find((entry) => entry.event === "subagent:error");
assert.ok(cancelSubEntry);
assert.match(cancelSubEntry.message, /^Subagent cancelled:/, "a cancelled subagent is not worded as a failure");
assert.ok(
  !cancelSubEntry.message.includes("builtin-table"),
  "and its partial narration is not rendered as the error message"
);
assert.equal(
  cancelSubEntry.error,
  undefined,
  "nor attached as a synthesized Error — a cancel is not a fault with a stack"
);

// The other two ways a run stops are NOT written as a user cancel. This is the misattribution
// the reason field exists to end: a run the parent discarded was logged as "cancelled by user".
for (const [stopReason, wording] of [
  ["parent-run", /^Subagent stopped \(parent run moved on\):/],
  ["parent-stop", /^Subagent stopped \(parent agent stopped\):/],
]) {
  entries = await emitAndRead({
    type: "subagent:error",
    ts: Date.now(),
    agentId: "agent-1",
    payload: { subagentId: `subagent-${stopReason}`, error: "partial", cancelled: true, stopReason },
  });
  const entry = entries.find(
    (candidate) => candidate.event === "subagent:error" && candidate.data?.subagentId === `subagent-${stopReason}`
  );
  assert.ok(entry, `subagent:error bridged for stopReason=${stopReason}`);
  assert.match(entry.message, wording, `stopReason=${stopReason} has its own wording`);
  assert.ok(!entry.message.includes("cancelled"), "and none of them claims the user cancelled it");
}

// A payload from before the field existed still classifies — as "unknown", not as a user cancel.
entries = await emitAndRead({
  type: "subagent:error",
  ts: Date.now(),
  agentId: "agent-1",
  payload: { subagentId: "subagent-legacy", error: "partial", cancelled: true },
});
const legacyEntry = entries.find(
  (candidate) => candidate.event === "subagent:error" && candidate.data?.subagentId === "subagent-legacy"
);
assert.match(
  legacyEntry.message,
  /^Subagent aborted \(no reason recorded\):/,
  "an unknown reason is admitted, not guessed"
);

// The real failure path is untouched: a subagent that actually failed still reports one.
entries = await emitAndRead({
  type: "subagent:error",
  ts: Date.now(),
  agentId: "agent-1",
  payload: { subagentId: "subagent-2", error: "429 after retries" },
});
const realSubEntry = entries.find(
  (entry) => entry.event === "subagent:error" && entry.data?.subagentId === "subagent-2"
);
assert.match(realSubEntry.message, /^Subagent error: 429 after retries/, "a genuine failure keeps its wording");
assert.equal(realSubEntry.error?.message, "429 after retries", "and still carries the fault");

// --- the parent `task` call binding ---
//
// A subagent line is attributable to the `task` call that spawned it. Without the binding a
// discarded eager pre-fork and the real subagent spawned afterwards for the SAME call id
// read as two unrelated subagents, and the pairing can only be reconstructed by timestamp.
entries = await emitAndRead({
  type: "subagent:completed",
  ts: Date.now(),
  agentId: "agent-1",
  payload: { subagentId: "subagent-3", summary: "done", parentTaskToolCallId: "call-01" },
});
const boundEntry = entries.find(
  (entry) => entry.event === "subagent:completed" && entry.data?.subagentId === "subagent-3"
);
assert.ok(boundEntry, "subagent:completed is bridged");
assert.ok(boundEntry.message.includes("[task call-01]"), "the line names its parent task call");

// --- a discarded pre-fork is recorded, with the orphan it created ---
//
// This is the line that turns an unexplained aborted subagent into a stated cause: the
// eager run was thrown away (and its already-spawned subagent aborted), while the tool
// phase will spawn a second subagent for the same call id.
entries = await emitAndRead({
  type: "subagent:prefork-discarded",
  ts: Date.now(),
  agentId: "agent-1",
  payload: { toolCallId: "call-01", cause: "run-finish", subagentIds: ["subagent-orphan"] },
});
const discardEntry = entries.find(
  (entry) => entry.event === "subagent:prefork-discarded" && entry.data?.toolCallId === "call-01"
);
assert.ok(discardEntry, "subagent:prefork-discarded is bridged");
assert.match(discardEntry.message, /^Pre-fork discarded \(run-finish\)/, "the cause is in the wording");
assert.ok(discardEntry.message.includes("call-01"), "and so is the tool call id");
assert.ok(discardEntry.message.includes("subagent-orphan"), "naming the orphan it aborted");
assert.equal(discardEntry.level, "warn", "a discard is a warning, not routine info");

// A discard with nothing spawned yet still records the discard, and says so — the pending
// pre-fork is just as discardable as a started one.
entries = await emitAndRead({
  type: "subagent:prefork-discarded",
  ts: Date.now(),
  agentId: "agent-1",
  payload: { toolCallId: "call-02", cause: "new-attempt", subagentIds: [] },
});
const pendingDiscard = entries.find(
  (entry) => entry.event === "subagent:prefork-discarded" && entry.data?.toolCallId === "call-02"
);
assert.match(pendingDiscard.message, /no subagent spawned yet/, "an unspawned discard says nothing was orphaned");

// --- the eager pre-fork start is labelled apart from the tool-phase start ---
//
// Both carry the same tool_call_id; without the label the two lines are byte-identical and
// a discarded-then-respawned pair reads as one doubled line.
entries = await emitAndRead({
  type: "agent:tool-start",
  ts: Date.now(),
  agentId: "agent-1",
  payload: { tool_name: "task", tool_call_id: "call-03", source: "prefork" },
});
const preforkStart = entries.find(
  (entry) => entry.event === "agent:tool-start" && entry.data?.tool_call_id === "call-03"
);
assert.match(preforkStart.message, /^Tool start: task \(pre-fork\)/, "the eager start is labelled");

console.log("bridged entries persisted to JSONL sink: OK");
console.log("payload summarization (bytes+preview, no eventType): OK");
console.log("memory debug streams silent: OK");
console.log("approval request + resolution bridged: OK");
// Policy overrides reach the specialized MCP/memory/compaction handlers too. Their
// default rules are false (the custom handlers decide whether to log), so an explicit
// `false` must suppress the custom path as well.
{
  const policyCapture = await createLogCapture("event-log-bridge-policy");
  const policyBus = createAgentEventBus();
  bridgeTelemetryToAgentLog(policyBus, () => policyCapture.log, {
    events: {
      "session:mcp": false,
      "memory:prefetch": false,
      "compaction:auto-complete": false,
    },
  });
  const before = (await policyCapture.readEntries()).length;
  policyBus.emit("session:mcp", { servers: [{ name: "hidden", status: "connected" }] });
  policyBus.emit("memory:prefetch", { status: "error", error: "hidden" });
  policyBus.emit("compaction:auto-complete", { tokensBefore: 1, tokensAfter: 0 });
  policyCapture.log.flushSync();
  assert.equal((await policyCapture.readEntries()).length, before, "explicit false suppresses custom-handler events");
}

// The rule table's `"specialized"` marker and the handler map are one fact stated twice (the table
// is static and typed by every payload key; the map holds the functions). A marker with no handler
// would silently drop rows, and a handler with no marker would be invisible to readers.
{
  const marked = Object.entries(DEFAULT_EVENT_LOG_RULES)
    .filter(([, rule]) => rule === SPECIALIZED_EVENT_LOG)
    .map(([type]) => type)
    .sort();
  const handled = [...SPECIALIZED_EVENT_LOG_TYPES].sort();
  assert.deepEqual(marked, handled, "every specialized log rule has a handler and vice versa");
  // A `false` cell means "never logged"; none of the specialized events may also claim suppression.
  for (const type of handled) {
    assert.notEqual(DEFAULT_EVENT_LOG_RULES[type], false, `${type}: not both specialized and suppressed`);
  }
  console.log("specialized-rule table matches the handler map — ok");
}

console.log("event-log-bridge validation passed");
