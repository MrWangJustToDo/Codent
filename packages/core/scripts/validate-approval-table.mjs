/**
 * Approval table identity and resume replay.
 *
 * Provider tool-call ids are request-scoped and REUSED (`call_0`), so the table is keyed by
 * `approvalId`: an earlier answer must never shadow a later, different request for the same call
 * id. The failure this pins down: `upsert({status:"pending"})` returned the stale `approved` row,
 * the user's deny then hit first-decision-wins *before* `projectApproval`, and the session sat on
 * an unanswerable prompt.
 *
 * Run: pnpm --filter @codent/core run validate:approval-table
 */

import assert from "node:assert/strict";

import { ToolApprovalTable, approvalsToResumeMap, backfillApprovalsFromUIMessages } from "../dist/dev.mjs";

// ============================================================================
// 1. First decision wins PER APPROVAL
// ============================================================================

{
  const resolutions = [];
  const table = new ToolApprovalTable({ onResolved: (resolution) => resolutions.push(resolution) });

  assert.equal(table.upsert({ id: "ap_1", toolCallId: "call_0", status: "pending" }).status, "pending");
  assert.equal(table.upsert({ id: "ap_1", toolCallId: "call_0", status: "approved" }).status, "approved");
  // A late second answer for the SAME approval is inert (a client retry / racing auto-approval).
  assert.equal(table.upsert({ id: "ap_1", toolCallId: "call_0", status: "denied" }).status, "approved");
  // An answered row is never downgraded back to pending.
  assert.equal(table.upsert({ id: "ap_1", toolCallId: "call_0", status: "pending" }).status, "approved");

  assert.equal(resolutions.length, 1, "one pending → approved transition = one resolution event");
  assert.equal(resolutions[0].approvalId, "ap_1");
  assert.equal(resolutions[0].decision, "approved");
}

// ============================================================================
// 2. A reused tool-call id gets a fresh row (the session-unanswerable bug)
// ============================================================================

{
  const resolutions = [];
  const table = new ToolApprovalTable({ onResolved: (resolution) => resolutions.push(resolution) });

  table.upsert({ id: "ap_old", toolCallId: "call_0", status: "approved" });

  // New request, same provider call id, different approval identity.
  assert.equal(table.upsert({ id: "ap_new", toolCallId: "call_0", status: "pending" }).status, "pending");
  // The deny must be RECORDED, not refused by the old approval's answer.
  const denied = table.upsert({ id: "ap_new", toolCallId: "call_0", status: "denied", reason: "user said no" });
  assert.equal(denied.status, "denied");
  assert.equal(denied.reason, "user said no");

  assert.deepEqual(
    table.toArray().map((row) => [row.id, row.status]),
    [["ap_new", "denied"]],
    "the stale row for a different approval of the same call id is dropped"
  );
  assert.deepEqual(
    resolutions.map((resolution) => `${resolution.approvalId}:${resolution.decision}`),
    ["ap_old:approved", "ap_new:denied"],
    "each real resolution is reported exactly once"
  );
}

// ============================================================================
// 3. Forced deny (command-safety) still replaces an approval of the SAME approval
// ============================================================================

{
  const resolutions = [];
  const table = new ToolApprovalTable({ onResolved: (resolution) => resolutions.push(resolution) });
  table.upsert({ id: "ap_1", toolCallId: "call_0", status: "approved" });
  const forced = table.upsert({
    id: "ap_1",
    toolCallId: "call_0",
    status: "denied",
    reason: "destructive command",
    overwrite: "deny",
  });
  assert.equal(forced.status, "denied");
  // The forced transition is a real change of verdict: it must be visible to the timeline, not
  // silently overwrite an approval that was already published.
  assert.deepEqual(
    resolutions.map((resolution) => `${resolution.approvalId}:${resolution.decision}:${resolution.reason ?? ""}`),
    ["ap_1:approved:", "ap_1:denied:destructive command"]
  );
}

// ============================================================================
// 4. Restore is keyed by approval id
// ============================================================================

{
  const table = new ToolApprovalTable();
  table.restore([
    { id: "ap_a", toolCallId: "call_a", status: "approved", updatedAt: 1 },
    { id: "ap_b", toolCallId: "call_b", status: "denied", reason: "no", updatedAt: 2 },
  ]);
  assert.deepEqual(
    table
      .toArray()
      .map((row) => row.id)
      .sort(),
    ["ap_a", "ap_b"]
  );
  // The restored row is found by its own identity, so a second answer is inert.
  assert.equal(table.upsert({ id: "ap_a", toolCallId: "call_a", status: "denied" }).status, "approved");
}

// Restored rows for a REUSED call id are kept side by side (unlike `upsert`, which drops the stale
// one): `restore` only receives historical records, and the resume replay below selects by
// approval identity, so keeping both is what lets the correct decision answer the call.
{
  const table = new ToolApprovalTable();
  table.restore([
    { id: "ap_old", toolCallId: "call_0", status: "approved", updatedAt: 1 },
    { id: "ap_new", toolCallId: "call_0", status: "denied", reason: "no", updatedAt: 2 },
  ]);
  assert.deepEqual(
    table
      .toArray()
      .map((row) => row.id)
      .sort(),
    ["ap_new", "ap_old"]
  );
}

// ============================================================================
// 5. Backfill keeps only the newest request for a reused call id
// ============================================================================

function toolPart(id, approvalId, approved, extra = {}) {
  return {
    type: "tool-call",
    id,
    name: "run_command",
    arguments: "{}",
    state: "input-complete",
    approval: { id: approvalId, needsApproval: true, approved },
    ...extra,
  };
}

{
  const messages = [
    { id: "m1", role: "assistant", parts: [toolPart("call_0", "ap_old", true)] },
    { id: "m2", role: "assistant", parts: [toolPart("call_0", "ap_new", undefined)] },
  ];
  const records = backfillApprovalsFromUIMessages(messages);
  assert.deepEqual(
    records.map((row) => [row.id, row.status]),
    [["ap_new", "pending"]],
    "a later request reusing the call id replaces the earlier decision"
  );
}

// ============================================================================
// 6. Resume replay is scoped to the approval it was made for
// ============================================================================

{
  // Replay requires the part itself to carry the decision (pending rows are omitted) and the call
  // to be unresolved (a settled call is never executed again).
  const messages = [{ id: "m1", role: "assistant", parts: [toolPart("call_0", "ap_new", true)] }];

  // Matching identity + unresolved call → replayable.
  const live = approvalsToResumeMap(
    [{ id: "ap_new", toolCallId: "call_0", status: "approved", updatedAt: 1 }],
    messages
  );
  assert.equal(live.get("ap_new"), true);
  assert.equal(live.get("call_0"), true);

  // Stale row from an earlier approval of the same call id → must NOT answer the new call.
  const stale = approvalsToResumeMap(
    [{ id: "ap_old", toolCallId: "call_0", status: "approved", updatedAt: 1 }],
    messages
  );
  assert.equal(stale.size, 0, "a different approval id must not authorize the call");

  // Settled calls are never replayed, even with the right identity.
  const settledMessages = [
    { id: "m1", role: "assistant", parts: [toolPart("call_0", "ap_new", true, { state: "complete" })] },
  ];
  assert.equal(
    approvalsToResumeMap([{ id: "ap_new", toolCallId: "call_0", status: "approved", updatedAt: 1 }], settledMessages)
      .size,
    0
  );

  // A part that does not carry a decision yet is pending, not replayable.
  const pendingMessages = [{ id: "m1", role: "assistant", parts: [toolPart("call_0", "ap_new", undefined)] }];
  assert.equal(
    approvalsToResumeMap([{ id: "ap_new", toolCallId: "call_0", status: "approved", updatedAt: 1 }], pendingMessages)
      .size,
    0
  );
}

console.log("approval table validation passed");
