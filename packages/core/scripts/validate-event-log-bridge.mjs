/* eslint-disable max-lines -- the bridge suite keeps policy, routing, redaction and specialized-handler cases on one log-capture/sink harness; splitting it would duplicate that fixture (same reason as validate-command-job-registry.mjs). */
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
  AGENT_EVENT_META,
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
// A manual `/compact` must not read as the loop compacting itself.
//
// Both paths went through `beginCompaction`, whose default kind was `auto`, so the user's own
// command wrote "Auto-compacting context..." — indistinguishable in the timeline from the agent
// compacting itself. The kind now owns its events, and the wording follows the event.
// ---------------------------------------------------------------------------

entries = await emitAndRead({
  type: "compaction:manual-start",
  ts: Date.now(),
  agentId: "agent-1",
  payload: {},
});
const manualStartEntry = entries.find((entry) => entry.event === "compaction:manual-start");
assert.ok(manualStartEntry, "manual-start is bridged");
assert.equal(manualStartEntry.level, "info");
assert.match(manualStartEntry.message, /manual/i, "the line says the user asked for it");
assert.doesNotMatch(manualStartEntry.message, /^Auto-/, "and is not mistaken for the automatic path");

entries = await emitAndRead({
  type: "compaction:manual-complete",
  ts: Date.now(),
  agentId: "agent-1",
  payload: { tokensBefore: 12_000, tokensAfter: 3_000 },
});
const manualCompleteEntry = entries.find((entry) => entry.event === "compaction:manual-complete");
assert.ok(manualCompleteEntry, "manual-complete is bridged");
assert.match(manualCompleteEntry.message, /Manual compact:/);
assert.match(manualCompleteEntry.message, /12000→3000 tokens/);

entries = await emitAndRead({
  type: "compaction:manual-error",
  ts: Date.now(),
  agentId: "agent-1",
  payload: { error: "summarizer returned nothing" },
});
const manualErrorEntry = entries.find((entry) => entry.event === "compaction:manual-error");
assert.ok(manualErrorEntry, "manual-error is bridged");
assert.equal(manualErrorEntry.level, "error");
assert.match(manualErrorEntry.message, /Manual compact failed: summarizer returned nothing/);

// The automatic wording is unchanged — the two must stay distinguishable in both directions.
entries = await emitAndRead({
  type: "compaction:auto-complete",
  ts: Date.now(),
  agentId: "agent-1",
  payload: { tokensBefore: 5_000, tokensAfter: 1_000 },
});
const autoCompleteEntry = entries.find(
  (entry) => entry.event === "compaction:auto-complete" && entry.message.includes("5000→1000")
);
assert.ok(autoCompleteEntry);
assert.match(autoCompleteEntry.message, /^Auto-compact:/, "the automatic path keeps its own wording");

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

// An extension refusal RETURNS (TanStack reports `ok: true`), so it reaches the same event. Without
// the `denied` marker the timeline claimed the call ran.
entries = await emitAndRead({
  type: "agent:tool-end",
  ts: Date.now(),
  agentId: "agent-1",
  payload: { tool_name: "read_file", tool_call_id: "tc-denied", duration_ms: 0, denied: true, cancelled: false },
});
const deniedEndEntry = entries.find(
  (entry) => entry.event === "agent:tool-end" && entry.data?.tool_call_id === "tc-denied"
);
assert.ok(deniedEndEntry, "a refused call is bridged");
assert.match(deniedEndEntry.message, /^Tool denied: read_file/, "and is worded as a refusal, not an execution");

// `session:save-error.target` names the failed writer; the old wording prefixed every row with
// "save session", so a failed agent-log write read as a failed session save.
entries = await emitAndRead({
  type: "session:save-error",
  ts: Date.now(),
  agentId: "agent-1",
  payload: { target: "agent log", error: "ENOSPC" },
});
const saveErrorEntry = entries.find((entry) => entry.event === "session:save-error");
assert.ok(saveErrorEntry);
assert.match(saveErrorEntry.message, /^Failed to save agent log: ENOSPC/, "the message names the target that failed");

// `agent:extension-state` is append-only for RUNTIME transitions; startup-load rows carry
// `bootstrap: true` and are suppressed (the bootstrap summary already lists them).
entries = await emitAndRead({
  type: "agent:extension-state",
  ts: Date.now(),
  agentId: "agent-1",
  payload: { extensionId: "codent-lsp", enabled: true, state: "active" },
});
const extStateEntry = entries.find((entry) => entry.event === "agent:extension-state");
assert.ok(extStateEntry, "a runtime extension transition is recorded");
assert.match(extStateEntry.message, /^Extension enabled: "codent-lsp"/);

const suppressedBefore = (await readEntries()).length;
bus.emit(
  "agent:extension-state",
  { extensionId: "codent-skills", enabled: true, state: "active", bootstrap: true },
  { agentId: "agent-1" }
);
await new Promise((resolve) => setTimeout(resolve, 100));
assert.equal(
  (await readEntries()).length,
  suppressedBefore,
  "a bootstrap-load row is suppressed (the bootstrap summary already lists it)"
);

// A failed activation reads as unavailable, not as a user disable.
entries = await emitAndRead({
  type: "agent:extension-state",
  ts: Date.now(),
  agentId: "agent-1",
  payload: { extensionId: "broken-ext", enabled: false, state: "error" },
});
const failedExtEntry = entries.find(
  (entry) => entry.event === "agent:extension-state" && entry.data?.extensionId === "broken-ext"
);
assert.ok(failedExtEntry);
assert.match(failedExtEntry.message, /^Extension unavailable: "broken-ext"/, "an error state is not 'disabled'");

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

// Every event type has a decision. `AGENT_EVENT_META` is exhaustive over `AgentEventType` at compile
// time, which makes it the runtime list to check the merged table against: a new event without a
// rule is "unlogged because nobody listed it", the state this change replaced with an explicit
// decision (a formatter, a handler marker, or `false`).
{
  const undecided = Object.keys(AGENT_EVENT_META).filter((type) => DEFAULT_EVENT_LOG_RULES[type] === undefined);
  assert.deepEqual(undecided, [], `every event type has a rule (missing: ${undecided.join(", ")})`);
  console.log("every event type has an explicit log decision — ok");
}

// ---------------------------------------------------------------------------
// Run scope comes from the envelope, not from seam state.
//
// The seam used to own the run id (`setRun`), which meant two consumers could disagree and a late
// entry could lose its run. The producer stamps it once on the envelope; the bridge must copy it.
// ---------------------------------------------------------------------------
{
  const before = (await readEntries()).length;
  bus.emit(
    "agent:tool-start",
    { tool_name: "read_file", tool_call_id: "tc-run-1" },
    { agentId: "agent-1", runId: "runone01" }
  );
  await waitFor(readEntries, (snapshot) => snapshot.length > before);
  bus.emit(
    "agent:tool-start",
    { tool_name: "read_file", tool_call_id: "tc-run-2" },
    { agentId: "agent-1", runId: "runtwo02" }
  );
  await waitFor(readEntries, (snapshot) => snapshot.length > before + 1);
  bus.emit("session:start", { cwd: "/w" }, { agentId: "agent-1" });
  const scoped = await waitFor(readEntries, (snapshot) => snapshot.length > before + 2);

  const runEntries = scoped.filter((entry) => entry.data?.tool_call_id?.startsWith?.("tc-run-"));
  assert.deepEqual(
    runEntries.map((entry) => entry.run),
    ["runone01", "runtwo02"],
    "each entry carries its own event's run id, so two runs never share a slice"
  );
  const startEntry = scoped.find((entry) => entry.event === "session:start");
  assert.equal(startEntry?.run, undefined, "an event emitted outside a run carries no run id");
  console.log("run scope comes from the envelope — ok");
}

// ---------------------------------------------------------------------------
// Content of the events this change introduced.
//
// "Every event has a rule" says a decision exists, not that it is the right one: the level,
// category and wording are what a reader filters on, and they were previously picked at each call
// site. These assertions pin the policy side of the convergence.
// ---------------------------------------------------------------------------
{
  const cases = [
    {
      label: "session:title (ok)",
      emit: () => bus.emit("session:title", { ok: true, name: "Named" }, { agentId: "agent-1" }),
      event: "session:title",
      level: "info",
      category: "system",
      match: /^Session title: Named$/,
    },
    {
      label: "session:title (failed)",
      emit: () => bus.emit("session:title", { ok: false, error: "nope" }, { agentId: "agent-1" }),
      event: "session:title",
      level: "warn",
      category: "system",
      match: /^Session title failed: nope$/,
    },
    {
      label: "model:change",
      emit: () => bus.emit("model:change", { from: "a", to: "b", style: "openai" }, { agentId: "agent-1" }),
      event: "model:change",
      level: "info",
      category: "agent",
      match: /a → b/,
    },
    {
      label: "side-query:mode",
      emit: () =>
        bus.emit(
          "side-query:mode",
          { purpose: "title", mode: "text", reason: "no structured output" },
          { agentId: "agent-1" }
        ),
      event: "side-query:mode",
      level: "debug",
      category: "side-query",
      match: /using text mode: no structured output/,
    },
    {
      label: "agent:event-handler-error",
      emit: () =>
        bus.emit(
          "agent:event-handler-error",
          { pattern: "tool:before:*", event: "tool:before:read_file", kind: "interceptor", error: "boom" },
          { agentId: "agent-1" }
        ),
      event: "agent:event-handler-error",
      level: "warn",
      category: "hooks",
      match: /interceptor threw.*tool:before:\*/,
    },
    {
      label: "turn:summary (paused)",
      emit: () => bus.emit("turn:summary", { paused: true, phases: 1, toolCalls: 0 }, { agentId: "agent-1" }),
      event: "turn:summary",
      level: "info",
      category: "chat",
      match: /^Turn paused/,
    },
    {
      label: "agent:extension-error without an id",
      emit: () => bus.emit("agent:extension-error", { phase: "disk", error: "import failed" }, { agentId: "agent-1" }),
      event: "agent:extension-error",
      level: "error",
      category: "system",
      match: /^Extension disk failed: import failed$/,
    },
    {
      label: "tool:phase (held sibling)",
      emit: () =>
        bus.emit(
          "tool:phase",
          {
            phase: 1,
            pending: [
              { id: "call_tree", name: "tree" },
              { id: "call_run", name: "run_command" },
            ],
            pendingCount: 2,
            executed: [],
            executedCount: 0,
            held: [{ id: "call_tree", name: "tree" }],
            heldCount: 1,
            approved: [],
            approvedCount: 0,
            needsApproval: [{ id: "call_run", name: "run_command" }],
            needsApprovalCount: 1,
            needsClient: [],
            needsClientCount: 0,
          },
          { agentId: "agent-1" }
        ),
      event: "tool:phase",
      level: "debug",
      category: "tool",
      match: /^Tool phase 1: 2 pending, 0 executed, 1 held \(tree\), 1 awaiting approval \(run_command\)$/,
    },
    {
      label: "tool:settle",
      emit: () =>
        bus.emit(
          "tool:settle",
          { cause: "turn-end", includeInFlight: true, calls: [{ id: "call_tree", name: "tree" }], count: 1 },
          { agentId: "agent-1" }
        ),
      event: "tool:settle",
      level: "info",
      category: "tool",
      match: /^Tool settle \(turn-end, in-flight\): tree$/,
    },
    {
      label: "tool:resume",
      emit: () =>
        bus.emit("tool:resume", { calls: [{ id: "call_tree", name: "tree" }], count: 1 }, { agentId: "agent-1" }),
      event: "tool:resume",
      level: "debug",
      category: "tool",
      match: /^Tool resume after approval: tree$/,
    },
    {
      label: "context:inject",
      emit: () =>
        bus.emit(
          "context:inject",
          { source: "turn-context", kinds: ["current_date"], bytes: 123, reason: "changed" },
          { agentId: "agent-1" }
        ),
      event: "context:inject",
      level: "debug",
      category: "system",
      match: /^Context injected \(turn-context\) \(changed\): current_date, 123 bytes$/,
    },
    {
      label: "session:persist",
      emit: () =>
        bus.emit(
          "session:persist",
          { reason: "pump-complete", messages: 42, written: true, durationMs: 3 },
          { agentId: "agent-1" }
        ),
      event: "session:persist",
      level: "debug",
      category: "system",
      match: /^Session persist \(pump-complete\): 42 msgs, written, 3ms$/,
    },
    {
      label: "session:persist (skipped)",
      emit: () =>
        bus.emit(
          "session:persist",
          { reason: "user-message", messages: 7, written: false, skipped: true, durationMs: 0 },
          { agentId: "agent-1" }
        ),
      event: "session:persist",
      level: "debug",
      category: "system",
      match: /^Session persist \(user-message\): 7 msgs, skipped \(unchanged\), 0ms$/,
    },
    {
      label: "session:persist (not written)",
      emit: () =>
        bus.emit(
          "session:persist",
          { reason: "force", messages: 9, written: false, durationMs: 12 },
          { agentId: "agent-1" }
        ),
      event: "session:persist",
      level: "debug",
      category: "system",
      match: /^Session persist \(force\): 9 msgs, not written, 12ms$/,
    },
  ];
  for (const testCase of cases) {
    const before = (await readEntries()).length;
    testCase.emit();
    await waitFor(readEntries, (snapshot) => snapshot.length > before);
    const entry = (await readEntries()).at(-1);
    assert.equal(entry.event, testCase.event, `${testCase.label}: event stamp`);
    assert.equal(entry.level, testCase.level, `${testCase.label}: level`);
    assert.equal(entry.category, testCase.category, `${testCase.label}: category`);
    assert.match(entry.message, testCase.match, `${testCase.label}: message, got ${entry.message}`);
  }

  // A diagnostic's `details` are summarized like any payload: an array becomes bytes+preview, so a
  // nested value can no longer bypass the size cap (the handler used to write it verbatim).
  {
    const before = (await readEntries()).length;
    bus.emit(
      "session:diagnostic",
      { area: "compaction", message: "cut plan", level: "debug", details: { segmentTokens: [10, 20, 30] } },
      { agentId: "agent-1" }
    );
    await waitFor(readEntries, (snapshot) => snapshot.length > before);
    const entry = (await readEntries()).at(-1);
    assert.equal(entry.category, "compaction", "diagnostic area → category");
    assert.match(entry.message, /^\[compaction\] cut plan$/);
    assert.ok(
      typeof entry.data.segmentTokensBytes === "number",
      "details are summarized (bytes+preview), not written verbatim"
    );
  }
  console.log("new event families keep their level/category/wording — ok");
}

// ---------------------------------------------------------------------------
// Per-instance suppression (approvals nobody was asked about) + the rows that replaced
// the two biggest noise sources in a real session: auto approvals (22% of 6,034 lines) and
// `Model reasoning started` with no payload (280 empty rows).
// ---------------------------------------------------------------------------
{
  const settle = () => new Promise((resolve) => setTimeout(resolve, 400));
  const rowsFor = async (type) => (await readEntries()).filter((entry) => entry.event === type);

  // An auto-approved call: both rows are suppressed, even though both events are emitted.
  const autoRequestBefore = (await rowsFor("agent:tool-approval-request")).length;
  const autoResolvedBefore = (await rowsFor("agent:tool-approval-resolved")).length;
  bus.emit(
    "agent:tool-approval-request",
    { tool_name: "run_command", tool_call_id: "tc-auto", approval_id: "ap-auto", auto: true },
    { agentId: "agent-1" }
  );
  bus.emit(
    "agent:tool-approval-resolved",
    { tool_name: "run_command", tool_call_id: "tc-auto", approval_id: "ap-auto", decision: "approved", source: "auto" },
    { agentId: "agent-1" }
  );
  await settle();
  assert.equal(
    (await rowsFor("agent:tool-approval-request")).length,
    autoRequestBefore,
    "an auto-mode request writes no row (nobody was asked)"
  );
  assert.equal(
    (await rowsFor("agent:tool-approval-resolved")).length,
    autoResolvedBefore,
    "an auto-mode resolution writes no row"
  );

  // A human answer keeps both, and the resolution names the source.
  let before = (await rowsFor("agent:tool-approval-request")).length;
  bus.emit(
    "agent:tool-approval-request",
    { tool_name: "run_command", tool_call_id: "tc-user", approval_id: "ap-user" },
    { agentId: "agent-1" }
  );
  await waitFor(rowsFor.bind(null, "agent:tool-approval-request"), (rows) => rows.length > before);

  before = (await rowsFor("agent:tool-approval-resolved")).length;
  bus.emit(
    "agent:tool-approval-resolved",
    {
      tool_name: "run_command",
      tool_call_id: "tc-user",
      approval_id: "ap-user",
      decision: "denied",
      reason: "not this file",
      source: "user",
    },
    { agentId: "agent-1" }
  );
  await waitFor(rowsFor.bind(null, "agent:tool-approval-resolved"), (rows) => rows.length > before);
  const humanRow = (await rowsFor("agent:tool-approval-resolved")).at(-1);
  assert.equal(humanRow.level, "info", "a human decision stays visible");
  assert.match(humanRow.message, /denied/, "the decision is readable");
  assert.match(humanRow.message, /not this file/, "the reason survives");
  assert.equal(humanRow.data.source, "user", "the source is on the row");

  // A policy verdict is visible AND labelled (it was invisible before the source existed).
  before = (await rowsFor("agent:tool-approval-resolved")).length;
  bus.emit(
    "agent:tool-approval-resolved",
    {
      tool_name: "run_command",
      tool_call_id: "tc-policy",
      approval_id: "ap-policy",
      decision: "approved",
      source: "policy",
    },
    { agentId: "agent-1" }
  );
  await waitFor(rowsFor.bind(null, "agent:tool-approval-resolved"), (rows) => rows.length > before);
  assert.match((await rowsFor("agent:tool-approval-resolved")).at(-1).message, /by policy/);

  // `mode:change` is the append-only counterpart of the suppressed `session:mode` projection.
  before = (await rowsFor("mode:change")).length;
  bus.emit("mode:change", { field: "auto", auto: true }, { agentId: "agent-1" });
  await waitFor(rowsFor.bind(null, "mode:change"), (rows) => rows.length > before);
  assert.equal((await rowsFor("mode:change")).at(-1).message, "Auto mode on");
  assert.equal((await readEntries()).filter((e) => e.event === "session:mode").length, 0, "the projection stays out");

  // The thinking row now carries the turn + model it belongs to (it used to be empty).
  before = (await rowsFor("agent:thinking")).length;
  bus.emit("agent:thinking", { iteration: 7, model: "deepseek/deepseek-v4.1-flash" }, { agentId: "agent-1" });
  await waitFor(rowsFor.bind(null, "agent:thinking"), (rows) => rows.length > before);
  assert.match((await rowsFor("agent:thinking")).at(-1).message, /\[iter 7\].*deepseek/);

  // A delegated run's billing is visible on the only row it can appear on.
  before = (await rowsFor("subagent:completed")).length;
  bus.emit(
    "subagent:completed",
    { subagentId: "sub-1", summary: "done", costUsd: 0.1234, inputTokens: 10, outputTokens: 5 },
    { agentId: "agent-1" }
  );
  await waitFor(rowsFor.bind(null, "subagent:completed"), (rows) => rows.length > before);
  assert.match((await rowsFor("subagent:completed")).at(-1).message, /\$0\.1234/);
  console.log("policy suppression + mode/thinking/subagent rows — ok");
}

// ---------------------------------------------------------------------------
// Every row is length-bounded, including the specialized handlers
//
// The bridge's generic path truncated its message; the specialized handlers (extension logs,
// diagnostics, memory) wrote through a shared helper that did not, so `ctx.logger.info(<provider
// body>)` produced a single JSONL line of any size. The bound now lives in the seam
// (`AgentLog.log`), which is the one builder every writer passes through.
// ---------------------------------------------------------------------------
{
  const before = (await readEntries()).length;
  bus.emit(
    "extension:log",
    { extensionId: "noisy", level: "info", message: "x".repeat(20_000) },
    { agentId: "agent-1" }
  );
  await waitFor(readEntries, (rows) => rows.length > before);
  const row = (await readEntries()).find((entry) => entry.event === "extension:log");
  assert.ok(row, "the specialized extension row is written");
  assert.ok(
    row.message.length <= 400,
    `a specialized row is truncated like any other (got ${row.message.length} chars)`
  );
  console.log("specialized rows are length-bounded — ok");
}

// ---------------------------------------------------------------------------
// The error body is bounded too, and the envelope session is recorded
//
// `entry.error.message` is not the seam's `message`: it came straight from the payload's `error`
// (a provider body can be the whole response), so one failed request wrote a multi-megabyte line.
// The same row also keeps the session it was emitted for — an async producer (title / memory /
// side query) can resolve after a switch and land in the target file, where the sink path alone
// cannot tell the reader which session the row describes.
// ---------------------------------------------------------------------------
{
  const before = (await readEntries()).length;
  bus.emit("agent:stream-error", { error: "E".repeat(20_000) }, { agentId: "agent-1", sessionId: "ses_late_row" });
  const rows = await waitFor(readEntries, (snapshot) => snapshot.length > before);
  const row = rows.find((entry) => entry.event === "agent:stream-error");
  assert.ok(row, "the stream-error row is written");
  assert.equal(row.sessionId, "ses_late_row", "the envelope session is recorded on the row");
  assert.ok(
    row.error?.message.length <= 400,
    `entry.error.message is bounded like every other text field (got ${row.error?.message.length} chars)`
  );
  // A specialized handler (`compaction:auto-error`) does not pass through the generic `writeLog`
  // path; the bound must live in the seam, not in one bridge branch.
  const beforeCompact = (await readEntries()).length;
  bus.emit("compaction:auto-error", { error: "C".repeat(20_000) }, { agentId: "agent-1" });
  const compactRows = await waitFor(readEntries, (snapshot) => snapshot.length > beforeCompact);
  const compactRow = compactRows.find((entry) => entry.event === "compaction:auto-error");
  assert.ok(compactRow, "the compaction error row is written");
  assert.ok(
    compactRow.error?.message.length <= 400,
    `a specialized error body is bounded at the seam (got ${compactRow.error?.message.length} chars)`
  );
  console.log("error bodies are bounded and rows carry their session — ok");
}

console.log("event-log-bridge validation passed");
