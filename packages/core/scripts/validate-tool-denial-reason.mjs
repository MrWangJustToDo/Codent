/**
 * Validates tool denial reason attachment for approval responses.
 *
 * Run: pnpm --filter @codent/core run validate:tool-denial-reason
 */

import { uiMessageToModelMessages } from "@tanstack/ai";
import assert from "node:assert/strict";

import {
  AgentUIChannel,
  applyToolDenialReason,
  isExtensionDeniedOutput,
  needsAgentResponseAfterTools,
} from "../dist/dev.mjs";

const approvalId = "approval_call_cmd";
const initialMessages = [
  {
    id: "assistant-1",
    role: "assistant",
    parts: [
      {
        type: "tool-call",
        id: "call_cmd",
        name: "run_command",
        arguments: '{"command":"rm -rf /"}',
        state: "approval-requested",
        approval: { id: approvalId, needsApproval: true },
      },
    ],
  },
];

const channel = new AgentUIChannel({ initialMessages });
const decidedAt = channel.addToolApprovalResponse(approvalId, false, "Too destructive for this workspace");

// The decision time is core-owned: returned to the caller (the approval table) and
// carried on the part (the session log), from one value.
assert.ok(decidedAt > 0, "addToolApprovalResponse returns the decision time");

const messages = channel.getMessages();
const assistant = messages[0];
const toolCall = assistant.parts.find((part) => part.type === "tool-call");
const denialResult = assistant.parts.find((part) => part.type === "tool-result");

assert.equal(toolCall?.approval?.approved, false);
assert.equal(toolCall?.approval?.reason, "Too destructive for this workspace");
// The engine's part updaters merge (`{ ...part.approval, approved }`), so a core
// field living on the approval object survives the round-trip through the
// StreamProcessor. If a TanStack upgrade ever rebuilds parts instead of merging,
// this assertion fails loudly here instead of silently dropping the time.
assert.equal(toolCall?.approval?.updatedAt, decidedAt, "the decision time survives the engine round-trip");
assert.ok(denialResult, "expected tool-result part for denial");
assert.equal(denialResult.toolCallId, "call_cmd");
assert.deepEqual(JSON.parse(denialResult.content), {
  approved: false,
  message: "Too destructive for this workspace",
});

assert.equal(needsAgentResponseAfterTools(messages), true);

const modelMessages = uiMessageToModelMessages(assistant);
const toolMessage = modelMessages.find((message) => message.role === "tool");
assert.ok(toolMessage, "expected model tool message for denial");
assert.deepEqual(JSON.parse(toolMessage.content), {
  approved: false,
  message: "Too destructive for this workspace",
});

const reapplied = applyToolDenialReason(messages, approvalId, "duplicate");
assert.equal(reapplied[0].parts.filter((part) => part.type === "tool-result").length, 1);

// Re-answering the same approval is idempotent and keeps the first time.
const second = channel.addToolApprovalResponse(approvalId, false, "later reason");
assert.equal(second, decidedAt, "a re-answer keeps the original decision time");
assert.equal(
  channel.getMessages()[0].parts.find((part) => part.type === "tool-call")?.approval?.updatedAt,
  decidedAt,
  "the part keeps the original decision time"
);
assert.equal(
  channel.getMessages()[0].parts.filter((part) => part.type === "tool-result").length,
  1,
  "no duplicate denial result on a re-answer"
);

// ---------------------------------------------------------------------------
// The denial marker's key set is EXCLUSIVE, like the cancel and interruption markers.
//
// `denied: true` alone is not evidence that a payload is the framework's refusal: a tool whose own
// output carries that word was replaced wholesale with `Denied: …` on the model wire, so its real
// result disappeared with no diagnostic. The three markers must classify the same way.
// ---------------------------------------------------------------------------
{
  assert.equal(
    isExtensionDeniedOutput({ success: false, cancelled: false, denied: true, error: "blocked by plan" }),
    true,
    "the framework's refusal shape is recognized"
  );
  assert.equal(isExtensionDeniedOutput({ denied: true }), true, "a reason-less refusal is still the marker");
  assert.equal(
    isExtensionDeniedOutput({ denied: true, path: "a.txt", bytes: 12 }),
    false,
    "a business output that happens to carry `denied` is not the marker"
  );
  assert.equal(isExtensionDeniedOutput({ denied: "true" }), false, "only a literal true is the marker");
  assert.equal(isExtensionDeniedOutput(null), false);
  assert.equal(isExtensionDeniedOutput("denied"), false);
}

console.log("tool-denial-reason validation passed");
