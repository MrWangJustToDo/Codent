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

console.log("event-log-bridge validation passed");
