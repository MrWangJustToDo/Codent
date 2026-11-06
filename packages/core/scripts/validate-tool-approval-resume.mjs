/**
 * Validates session-backed tool-approval resume (table → resumeToolState).
 *
 * Run: pnpm --filter @codent/core run validate:tool-approval-resume
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ToolApprovalTable,
  approvalsToResumeMap,
  backfillApprovalsFromUIMessages,
  createApprovalResumeMiddleware,
  normalizeSessionApprovals,
} from "../dist/dev.mjs";

const records = [
  {
    id: "approval_call_run_1",
    toolCallId: "run_1",
    status: "pending",
    updatedAt: 1,
  },
  {
    id: "approval_call_edit_1",
    toolCallId: "edit_1",
    status: "approved",
    updatedAt: 2,
  },
  {
    id: "approval_call_rm_1",
    toolCallId: "rm_1",
    status: "denied",
    reason: "do not delete that",
    updatedAt: 3,
  },
];

const resumeMessages = [
  {
    id: "m-resume",
    role: "assistant",
    parts: [
      {
        id: "run_1",
        type: "tool-call",
        name: "run_command",
        arguments: "{}",
        state: "approval-requested",
        approval: { id: "approval_call_run_1", needsApproval: true },
      },
      {
        id: "edit_1",
        type: "tool-call",
        name: "edit_file",
        arguments: "{}",
        state: "input-complete",
        approval: { id: "approval_call_edit_1", needsApproval: true, approved: true },
      },
      {
        id: "rm_1",
        type: "tool-call",
        name: "run_command",
        arguments: "{}",
        state: "input-complete",
        approval: { id: "approval_call_rm_1", needsApproval: true, approved: false },
      },
    ],
  },
];

const resume = approvalsToResumeMap(records, resumeMessages);
assert.equal(resume.has("approval_call_run_1"), false, "pending must be omitted");
assert.equal(resume.has("run_1"), false, "pending toolCallId must be omitted");

assert.equal(resume.get("edit_1"), true);
assert.equal(resume.get("approval_call_edit_1"), true);
assert.equal(resume.get("approval_edit_1"), true, "SDK lookup alias approval_${toolCallId}");

const denied = resume.get("rm_1");
assert.deepEqual(denied, { approved: false, payload: { reason: "do not delete that" } });
assert.deepEqual(resume.get("approval_call_rm_1"), denied);

const table = new ToolApprovalTable();
table.upsert({ id: "approval_call_run_1", toolCallId: "run_1", status: "pending" });
table.upsert({ id: "approval_call_run_1", toolCallId: "run_1", status: "approved" });
table.upsert({ id: "approval_call_run_1", toolCallId: "run_1", status: "pending" });
assert.equal(table.toArray()[0].status, "approved", "pending must not downgrade an answered row");

const oldFile = normalizeSessionApprovals({});
assert.deepEqual(oldFile, [], "missing approvals field is empty");

const uiMessages = [
  {
    id: "a1",
    role: "assistant",
    parts: [
      {
        type: "tool-call",
        id: "call_old",
        name: "run_command",
        arguments: "{}",
        state: "approval-responded",
        approval: { id: "approval_call_call_old", needsApproval: true, approved: true },
      },
    ],
  },
];
const backfilled = backfillApprovalsFromUIMessages(uiMessages);
assert.equal(backfilled.length, 1);
assert.equal(backfilled[0].status, "approved");
assert.equal(backfilled[0].toolCallId, "call_old");

const fromOldSession = normalizeSessionApprovals({ uiMessages });
assert.equal(fromOldSession[0].toolCallId, "call_old");

// Approval state is derived from the message log; `approvalTimes` carries the
// real decision timestamp recorded in the log instead of `now`.
const withTimes = normalizeSessionApprovals({ uiMessages, approvalTimes: { approval_call_call_old: 1234 } });
assert.equal(withTimes.length, 1);
assert.equal(withTimes[0].status, "approved");
assert.equal(withTimes[0].updatedAt, 1234, "approvalTimes carries the real decision timestamp");

const middleware = createApprovalResumeMiddleware({
  getApprovals: () => records,
  getMessages: () => resumeMessages,
});
const projectedMessages = [{ role: "user", content: "wire" }];
let config = {
  messages: [],
  systemPrompts: [],
  tools: [],
};
config = { ...config, ...(await middleware.onConfig?.(undefined, config)) };
config = { ...config, messages: projectedMessages };

assert.equal(config.messages, projectedMessages, "compaction messages still apply");
assert.equal(config.resumeToolState.approvals.get("edit_1"), true, "resumeToolState survives messages merge");
assert.equal(config.resumeToolState.approvals.has("run_1"), false, "pending omitted from resumeToolState");

const pkg = JSON.parse(
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")
);
assert.equal(pkg.dependencies?.["@tanstack/ai-persistence"], undefined, "must not add @tanstack/ai-persistence");

console.log("tool-approval-resume validation passed");
