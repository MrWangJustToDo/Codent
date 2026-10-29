/**
 * Validates the agent-log event-timeline contract:
 * 1. AgentLog is persistence-only — no query/emitter/serialization surface.
 * 2. Run scoping: entries during a run share the `run` id; outside runs omit it.
 * 3. Payload summarization bounds (via summarizePayload).
 * 4. Status transitions: the status controller threads trigger hints.
 * 5. Approval resolution: ToolApprovalTable emits resolved callbacks exactly
 *    once per pending → approved/denied transition (never on restore/downgrade).
 *
 * Run: pnpm --filter @codent/core run validate:agent-log-timeline
 */

import assert from "node:assert/strict";

import { AgentLog, ToolApprovalTable, createAgentStatusController, summarizePayload } from "../dist/dev.mjs";

import { createLogCapture, waitFor } from "./helpers/log-capture.mjs";

// ----------------------------------------------------------------------------
// 1. Persistence-only surface: query/emitter/serialization APIs are gone.
// ----------------------------------------------------------------------------
for (const method of [
  "getEntries",
  "getCount",
  "filter",
  "recent",
  "errors",
  "issues",
  "toConsole",
  "toJSON",
  "fromJSON",
  "clear",
  "setMaxEntries",
  "on",
]) {
  assert.equal(AgentLog.prototype[method], undefined, `AgentLog.${method} must not exist (persistence-only)`);
}
console.log("persistence-only surface: OK");

// ----------------------------------------------------------------------------
// 2. Run scoping + JSONL persistence.
// ----------------------------------------------------------------------------
{
  const capture = await createLogCapture("log-timeline-run");
  const { log: runLog, readEntries } = capture;

  runLog.info("system", "bootstrap entry"); // no run id
  // The seam keeps no run state: the id travels with the event (here simulated through `eventEntry`,
  // which is the only API that accepts one).
  runLog.eventEntry("info", "llm", "llm:response", "LLM response: ok", { costUsd: 0.01 }, undefined, "run00001");
  runLog.info("system", "post-run entry");

  // Poll rather than sleep: the sink flushes on an interval, so a fixed sleep is a race that
  // passed locally and failed on a loaded runner (observed as `0 !== 3`).
  const entries = await waitFor(readEntries, (e) => e.length >= 3);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].run, undefined, "bootstrap entry has no run id");
  assert.equal(entries[1].run, "run00001", "run entry stamped with run id");
  assert.equal(entries[2].run, undefined, "post-run entry has no run id");
  assert.equal(entries[1].data.costUsd, 0.01, "cost field persisted");
  capture.detach();
  console.log("run scoping + JSONL persistence: OK");
}

// ----------------------------------------------------------------------------
// 3. summarizePayload: large payloads → bytes + preview; scalars pass through.
// ----------------------------------------------------------------------------
{
  const out = summarizePayload({
    eventType: "agent:tool-end",
    tool_name: "read_file",
    tool_call_id: "call_1",
    duration_ms: 42,
    outputTokens: 120,
    tool_output: { content: "y".repeat(5000) },
    tool_input: { prompt: "z".repeat(300) },
  });

  assert.equal(out.eventType, undefined, "eventType dropped");
  assert.equal(out.tool_name, "read_file", "scalar name kept");
  assert.equal(out.tool_call_id, "call_1", "scalar id kept");
  assert.equal(out.duration_ms, 42, "scalar ms kept");
  assert.equal(out.outputTokens, 120, "token counts kept");
  assert.ok(out.outputBytes >= 5000, "outputBytes recorded");
  assert.ok(out.outputPreview.length <= 200, "output preview ≤200 chars");
  assert.ok(out.inputBytes >= 300, "inputBytes recorded");
  assert.ok(out.inputPreview.length <= 200, "input preview ≤200 chars");
  assert.equal(out.tool_output, undefined, "tool_output never inlined");
  console.log("payload summarization: OK");
}

// ----------------------------------------------------------------------------
// 4. Status transitions: controller threads trigger hints to setStatus.
// ----------------------------------------------------------------------------
{
  const transitions = [];
  const controller = createAgentStatusController({
    getStatus: () => transitions.at(-1)?.to ?? "idle",
    setStatus: (status, trigger) => transitions.push({ from: transitions.at(-1)?.to ?? "idle", to: status, trigger }),
    getError: () => "",
    setError: () => {},
    setPendingApprovalCount: () => {},
  });

  controller.onRunStart();
  controller.onRunAbort();
  controller.onRecoveryRetry();

  assert.deepEqual(transitions[0], { from: "idle", to: "running", trigger: "run-start" });
  assert.deepEqual(transitions[1], { from: "running", to: "aborted", trigger: "run-abort" });
  // onRecoveryRetry only fires from "error" — no-op here, no transition recorded.
  assert.equal(transitions.length, 2);
  console.log("status transition triggers: OK");
}

// ----------------------------------------------------------------------------
// 5. Approval resolution: exactly one callback per real resolution.
// ----------------------------------------------------------------------------
{
  const resolutions = [];
  const table = new ToolApprovalTable({
    onResolved: (resolution) => resolutions.push(resolution),
  });

  table.upsert({ id: "ap-1", toolCallId: "tc-1", status: "pending", toolName: "run_command" });
  assert.equal(resolutions.length, 0, "pending upsert does not resolve");

  table.upsert({ id: "ap-1", toolCallId: "tc-1", status: "approved", toolName: "run_command" });
  assert.equal(resolutions.length, 1, "approved fires once");
  assert.deepEqual(resolutions[0], {
    approvalId: "ap-1",
    toolCallId: "tc-1",
    decision: "approved",
    reason: undefined,
    toolName: "run_command",
  });

  // Downgrade guard: approving again must not re-resolve.
  table.upsert({ id: "ap-1", toolCallId: "tc-1", status: "approved" });
  assert.equal(resolutions.length, 1, "re-approval does not re-resolve");

  table.upsert({ id: "ap-2", toolCallId: "tc-2", status: "denied", reason: "unsafe" });
  assert.equal(resolutions.length, 2);
  assert.equal(resolutions[1].decision, "denied");
  assert.equal(resolutions[1].reason, "unsafe");

  // restore() must not fire resolutions.
  table.restore([{ id: "ap-3", toolCallId: "tc-3", status: "denied", updatedAt: Date.now() }]);
  assert.equal(resolutions.length, 2, "restore does not emit resolutions");
  console.log("approval resolution callbacks: OK");
}

console.log("agent-log-timeline validation passed");
