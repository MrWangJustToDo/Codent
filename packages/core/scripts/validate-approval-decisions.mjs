/**
 * Validates the approval decision transaction:
 * - channel decision time is reused by the approval table;
 * - N decisions settle once and join ONE pump;
 * - auto-mode approvals do not schedule a pump;
 * - the command-safety policy handles allow / deny / ask, and only pending run_command calls.
 *
 * Run: pnpm --filter @codent/core run validate:approval-decisions
 */

import assert from "node:assert/strict";

import { ApprovalDecisionCoordinator, ToolApprovalTable } from "../dist/dev.mjs";

function toolCall(id, name, command, approvalId, extra = {}) {
  return {
    type: "tool-call",
    id,
    name,
    arguments: JSON.stringify({ command }),
    state: "input-complete",
    approval: { id: approvalId, needsApproval: true, approved: undefined },
    ...extra,
  };
}

const messages = [
  {
    id: "a1",
    role: "assistant",
    parts: [
      toolCall("call_a", "run_command", "git status", "ap_a"),
      toolCall("call_b", "run_command", "rm -rf x", "ap_b"),
    ],
  },
];

function makeCoordinator({ messages: initial = messages, auto = false, evaluate } = {}) {
  const decisions = [];
  const upserts = [];
  let reconciles = 0;
  let persists = 0;
  let pumps = 0;
  const coordinator = new ApprovalDecisionCoordinator({
    getMessages: () => initial,
    addToolApprovalResponse: (approvalId, approved, reason) => {
      const at = 100 + decisions.length;
      decisions.push({ approvalId, approved, reason, at });
      return at;
    },
    upsertApproval: (input) => upserts.push(input),
    shouldAutoApprove: () => auto,
    reconcile: () => {
      reconciles += 1;
    },
    persist: () => {
      persists += 1;
    },
    enqueueRun: async () => {
      pumps += 1;
    },
    isSessionSwitching: () => false,
    getCoreEnv: () => ({}),
    ...(evaluate ? { evaluateCommandSafety: evaluate } : {}),
  });
  return {
    coordinator,
    decisions,
    upserts,
    stats: () => ({ reconciles, persists, pumps }),
  };
}

// ---------------------------------------------------------------------------
// 1. Explicit answer: one write to channel + table, one settle, one pump
// ---------------------------------------------------------------------------
{
  const ctrl = makeCoordinator();
  await ctrl.coordinator.respondToToolApproval("ap_a", true);
  assert.deepEqual(ctrl.decisions, [{ approvalId: "ap_a", approved: true, reason: undefined, at: 100 }]);
  assert.equal(ctrl.upserts.length, 1);
  assert.equal(ctrl.upserts[0].toolCallId, "call_a");
  assert.equal(ctrl.upserts[0].toolName, "run_command");
  assert.equal(ctrl.upserts[0].status, "approved");
  assert.equal(ctrl.upserts[0].updatedAt, 100, "the table reuses the channel timestamp");
  assert.deepEqual(ctrl.stats(), { reconciles: 1, persists: 1, pumps: 1 });
}

{
  const ctrl = makeCoordinator();
  await ctrl.coordinator.respondToToolApproval("ap_b", false, "dangerous");
  assert.equal(ctrl.upserts[0].status, "denied");
  assert.equal(ctrl.upserts[0].reason, "dangerous");
  assert.equal(ctrl.upserts[0].updatedAt, 100);
}

// ---------------------------------------------------------------------------
// 2. Approve-all joins ONE pump; no pending decisions does nothing
// ---------------------------------------------------------------------------
{
  const ctrl = makeCoordinator();
  await ctrl.coordinator.approvePendingApprovals();
  assert.equal(ctrl.decisions.length, 2);
  assert.equal(ctrl.upserts.length, 2);
  assert.deepEqual(ctrl.stats(), { reconciles: 1, persists: 1, pumps: 1 }, "N decisions → one pump");
}

{
  const ctrl = makeCoordinator({ messages: [{ id: "u", role: "user", parts: [] }] });
  await ctrl.coordinator.approvePendingApprovals();
  assert.equal(ctrl.decisions.length, 0);
  assert.deepEqual(ctrl.stats(), { reconciles: 0, persists: 0, pumps: 0 });
}

// ---------------------------------------------------------------------------
// 3. Auto-mode approval: settle once, never schedule a pump
// ---------------------------------------------------------------------------
{
  const ctrl = makeCoordinator({ auto: true });
  ctrl.coordinator.autoApprovePending();
  assert.equal(ctrl.decisions.length, 2);
  assert.deepEqual(ctrl.stats(), { reconciles: 1, persists: 1, pumps: 0 });
}

{
  const ctrl = makeCoordinator({ auto: false });
  ctrl.coordinator.autoApprovePending();
  assert.equal(ctrl.decisions.length, 0);
  assert.deepEqual(ctrl.stats(), { reconciles: 0, persists: 0, pumps: 0 });
}

// ---------------------------------------------------------------------------
// 4. Command-safety policy: allow / deny / ask, run_command only, pending only
// ---------------------------------------------------------------------------
{
  const ctrl = makeCoordinator({ evaluate: async () => ({ action: "allow" }) });
  await ctrl.coordinator.applyCommandSafetyPolicy();
  assert.equal(ctrl.decisions.length, 2, "both pending run_command calls are evaluated");
  assert.equal(ctrl.upserts[0].status, "approved");
  assert.deepEqual(ctrl.stats(), { reconciles: 1, persists: 1, pumps: 0 });
}

{
  const ctrl = makeCoordinator({
    messages: [{ id: "a", role: "assistant", parts: [toolCall("call", "run_command", "rm -rf x", "ap")] }],
    evaluate: async () => ({ action: "deny", reason: "blocked" }),
  });
  await ctrl.coordinator.applyCommandSafetyPolicy();
  assert.equal(ctrl.upserts[0].status, "denied");
  assert.equal(ctrl.upserts[0].reason, "blocked");
  assert.deepEqual(ctrl.stats(), { reconciles: 1, persists: 1, pumps: 0 });
}

{
  const ctrl = makeCoordinator({
    messages: [{ id: "a", role: "assistant", parts: [toolCall("call", "run_command", "rm -rf x", "ap")] }],
    evaluate: async () => ({ action: "ask" }),
  });
  await ctrl.coordinator.applyCommandSafetyPolicy();
  assert.equal(ctrl.decisions.length, 0, "ask stays pending for the user");
  assert.deepEqual(ctrl.stats(), { reconciles: 0, persists: 0, pumps: 0 });
}

{
  let evaluated = 0;
  const ctrl = makeCoordinator({
    messages: [
      {
        id: "a",
        role: "assistant",
        parts: [
          toolCall("call_read", "read_file", "x", "ap_read"),
          toolCall("call_done", "run_command", "git status", "ap_done", {
            approval: { id: "ap_done", needsApproval: true, approved: true },
          }),
        ],
      },
    ],
    evaluate: async () => {
      evaluated += 1;
      return { action: "allow" };
    },
  });
  await ctrl.coordinator.applyCommandSafetyPolicy();
  assert.equal(evaluated, 0, "only pending run_command calls are evaluated");
  assert.equal(ctrl.decisions.length, 0);
}

{
  const ctrl = makeCoordinator({
    messages: [{ id: "a", role: "assistant", parts: [toolCall("call", "run_command", "git status", "ap")] }],
    auto: true,
    evaluate: async () => {
      throw new Error("auto mode must not evaluate the policy");
    },
  });
  await ctrl.coordinator.applyCommandSafetyPolicy();
  assert.equal(ctrl.decisions.length, 0);
}

// ---------------------------------------------------------------------------
// 5. First decision wins: a repeated / late answer is inert
//
// The channel used to apply a second decision (approved and denied rank equally), so a deny
// followed by a late allow flipped `resumeToolState` and executed the tool the user refused.
// The coordinator must not write, settle, or pump for an approval that is no longer pending,
// and must not invent a row for an id no part carries.
// ---------------------------------------------------------------------------
{
  let current = messages;
  const calls = [];
  let pumps = 0;
  const coordinator = new ApprovalDecisionCoordinator({
    getMessages: () => current,
    addToolApprovalResponse: (approvalId, approved, reason) => {
      calls.push({ approvalId, approved });
      // Model the channel: the decision becomes part of the transcript.
      current = current.map((message) => ({
        ...message,
        parts: message.parts.map((part) =>
          part.approval?.id === approvalId
            ? { ...part, approval: { ...part.approval, approved, ...(reason ? { reason } : {}) } }
            : part
        ),
      }));
      return calls.length;
    },
    upsertApproval: () => {},
    shouldAutoApprove: () => false,
    reconcile: () => {},
    persist: () => {},
    enqueueRun: async () => {
      pumps += 1;
    },
    isSessionSwitching: () => false,
    getCoreEnv: () => ({}),
  });

  await coordinator.respondToToolApproval("ap_a", false, "no");
  await coordinator.respondToToolApproval("ap_a", true); // late allow — must be ignored
  assert.equal(calls.length, 1, "a second answer must not reach the channel");
  assert.deepEqual(calls[0], { approvalId: "ap_a", approved: false });
  assert.equal(pumps, 1, "a second answer must not schedule a pump");

  await coordinator.respondToToolApproval("ap_unknown", true); // no part carries this id
  assert.equal(calls.length, 1, "an unknown approval id must not invent a decision");
  assert.equal(pumps, 1, "an unknown approval id must not schedule a pump");
}

// ---------------------------------------------------------------------------
// 6. The approval table itself is first-wins (approved and denied rank equally)
// ---------------------------------------------------------------------------
{
  const table = new ToolApprovalTable();
  table.upsert({ id: "ap", toolCallId: "call", status: "pending" });
  const decided = table.upsert({ id: "ap", toolCallId: "call", status: "denied", reason: "no" });
  assert.equal(decided.status, "denied", "pending → denied is applied");
  const late = table.upsert({ id: "ap", toolCallId: "call", status: "approved" });
  assert.equal(late.status, "denied", "an answered row must not flip to the other answer");
  assert.equal(late.reason, "no", "the first decision's reason is kept");
}

console.log("approval-decisions validation passed");
