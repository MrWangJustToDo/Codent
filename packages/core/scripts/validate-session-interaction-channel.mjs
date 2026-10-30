/**
 * Validates the retained `interaction` channel derivation:
 * `collectPendingApprovals` / `collectPendingAskUser` (in the order they were ASKED —
 * conversation order — with terminal/approved calls excluded) plus the channel/meta wiring so
 * hosts can stop re-scanning messages for pending approvals / `ask_user`.
 *
 * Run: pnpm --filter @codent/core run validate:session-interaction-channel
 */

import assert from "node:assert/strict";

import {
  AGENT_EVENT_META,
  DEFAULT_AGENT_SESSION_CHANNELS,
  collectPendingApprovals,
  collectPendingAskUser,
  collectPendingInteractions,
  firstPendingInteraction,
  resolvePendingInteractions,
} from "../dist/dev.mjs";

function assistant(id, parts) {
  return { id, role: "assistant", parts, createdAt: new Date() };
}
function user(id, parts) {
  return { id, role: "user", parts, createdAt: new Date() };
}
function toolCall(overrides) {
  return { type: "tool-call", state: "input-available", ...overrides };
}

// --- channel / meta wiring ---------------------------------------------------

assert.equal(AGENT_EVENT_META["session:interaction"]?.channel, "interaction", "event maps to the interaction channel");
assert.equal(AGENT_EVENT_META["session:interaction"]?.retained, true, "interaction channel is retained");
assert.equal(DEFAULT_AGENT_SESSION_CHANNELS.includes("interaction"), true, "interaction is a default channel");
assert.equal(DEFAULT_AGENT_SESSION_CHANNELS.includes("mcp"), true, "mcp is a default channel");

// --- pending approvals -------------------------------------------------------

{
  const messages = [
    user("u1", [{ type: "text", content: "go" }]),
    assistant("a1", [
      // Awaiting approval.
      toolCall({
        id: "tc-pending",
        name: "run_command",
        arguments: '{"command":"ls"}',
        approval: { id: "ap-1", needsApproval: true },
      }),
      // Already approved → not pending.
      toolCall({
        id: "tc-approved",
        name: "write_file",
        arguments: "{}",
        approval: { id: "ap-2", needsApproval: true, approved: true },
      }),
      // No approval gate → not pending.
      toolCall({ id: "tc-plain", name: "read_file", arguments: "{}" }),
    ]),
  ];

  assert.deepEqual(collectPendingApprovals(messages), [
    { approvalId: "ap-1", toolName: "run_command", toolCallId: "tc-pending" },
  ]);
}

// Ask order: the oldest unanswered call comes first, because a host takes `[0]` as the question
// on screen and must answer a batch first-come-first-served. Newest-first made the UI answer in
// reverse and disagreed with the status rule (`firstPendingInteraction`).
{
  const messages = [
    assistant("a1", [
      toolCall({ id: "tc-old", name: "run_command", arguments: "{}", approval: { id: "ap-old", needsApproval: true } }),
    ]),
    user("u2", [{ type: "text", content: "again" }]),
    assistant("a2", [
      toolCall({ id: "tc-new", name: "run_command", arguments: "{}", approval: { id: "ap-new", needsApproval: true } }),
    ]),
  ];
  assert.deepEqual(
    collectPendingApprovals(messages).map((a) => a.approvalId),
    ["ap-old", "ap-new"]
  );
}

// Within one assistant message the part order is the ask order.
{
  const messages = [
    assistant("a1", [
      toolCall({ id: "tc-1", name: "run_command", arguments: "{}", approval: { id: "ap-1", needsApproval: true } }),
      toolCall({ id: "tc-2", name: "write_file", arguments: "{}", approval: { id: "ap-2", needsApproval: true } }),
    ]),
  ];
  assert.deepEqual(
    collectPendingApprovals(messages).map((a) => a.approvalId),
    ["ap-1", "ap-2"]
  );
}

// The ordered union is the ONE projection: the typed lists are filters of it, so `pending[0]`,
// `approvals[0]` and the status rule (`firstPendingInteraction`) name the same interaction.
{
  const messages = [
    user("u1", [{ type: "text", content: "go" }]),
    assistant("a1", [
      toolCall({
        id: "tc-approval",
        name: "run_command",
        arguments: "{}",
        approval: { id: "ap-1", needsApproval: true },
      }),
    ]),
    user("u2", [{ type: "text", content: "next" }]),
    assistant("a2", [
      toolCall({
        id: "tc-ask",
        name: "ask_user",
        arguments: JSON.stringify({ question: "Which?", options: ["a", "b"] }),
        state: "input-complete",
      }),
      // Answering the question leaves the approval — order is conversation order, not kind.
      toolCall({
        id: "tc-answer",
        name: "ask_user",
        arguments: JSON.stringify({ question: "older" }),
        state: "complete",
        output: { answer: "x" },
      }),
    ]),
  ];

  const pending = collectPendingInteractions(messages);
  assert.deepEqual(
    pending.map((entry) => entry.kind),
    ["approval", "clientTool"],
    "one order, mixed kinds"
  );
  assert.equal(pending[0].approvalId, "ap-1");
  assert.equal(pending[1].question, "Which?");
  assert.deepEqual(pending[1].options, ["a", "b"]);

  // The typed views are exactly the filtered union, in the same order.
  assert.deepEqual(collectPendingApprovals(messages), [
    { approvalId: "ap-1", toolName: "run_command", toolCallId: "tc-approval" },
  ]);
  assert.deepEqual(collectPendingAskUser(messages), [
    { toolCallId: "tc-ask", question: "Which?", options: ["a", "b"] },
  ]);

  // The status rule reads the same first entry, so `waiting` always names `pending[0]`.
  assert.equal(firstPendingInteraction(messages)?.kind, pending[0].kind);

  // An approval part with no id cannot be answered, so it never reaches a host's queue.
  const idless = [
    assistant("a3", [
      toolCall({ id: "tc-idless", name: "run_command", arguments: "{}", approval: { needsApproval: true } }),
    ]),
  ];
  assert.deepEqual(collectPendingInteractions(idless), []);
  assert.equal(firstPendingInteraction(idless)?.kind, "approval", "the status still treats it as a wait");
}

// The queue a host presents: a snapshot WITH `pending` is authoritative even when it is empty;
// only a publisher that predates the field is re-joined from the typed lists. Both hosts call this
// one function, so they cannot disagree about the fallback precedence.
{
  const approval = { approvalId: "ap-1", toolName: "run_command", toolCallId: "tc-1" };
  const ask = { toolCallId: "ask-1", question: "Q?" };
  const ordered = [
    { kind: "clientTool", toolCallId: "ask-1", question: "Q?" },
    { kind: "approval", ...approval },
  ];
  assert.deepEqual(
    resolvePendingInteractions({ pending: ordered, approvals: [approval], askUser: [ask] }),
    ordered,
    "`pending` is used as-is, in its published order"
  );
  assert.deepEqual(
    resolvePendingInteractions({ pending: [], approvals: [approval], askUser: [ask] }),
    [],
    "an EMPTY `pending` is authoritative: nothing is pending, not a fallback to the typed lists"
  );
  assert.deepEqual(
    resolvePendingInteractions({ approvals: [approval], askUser: [ask] }).map((entry) => entry.kind),
    ["approval", "clientTool"],
    "a publisher without `pending` falls back to approvals-then-questions"
  );
}

// --- pending ask_user --------------------------------------------------------

{
  const messages = [
    assistant("a1", [
      toolCall({
        id: "ask-1",
        name: "ask_user",
        arguments: JSON.stringify({ question: "Which?", options: ["a", "b"], multiSelect: true }),
        state: "input-complete",
      }),
      // Already answered → excluded.
      toolCall({
        id: "ask-2",
        name: "ask_user",
        arguments: JSON.stringify({ question: "done" }),
        state: "input-complete",
        output: { answer: "x" },
      }),
      // Still streaming input → excluded.
      toolCall({
        id: "ask-3",
        name: "ask_user",
        arguments: JSON.stringify({ question: "partial" }),
        state: "input-streaming",
      }),
    ]),
  ];

  assert.deepEqual(collectPendingAskUser(messages), [
    { toolCallId: "ask-1", question: "Which?", options: ["a", "b"], multiSelect: true },
  ]);
}

// Malformed arguments → question falls back to "" and no options are emitted.
{
  const messages = [
    assistant("a1", [toolCall({ id: "ask-bad", name: "ask_user", arguments: "not-json", state: "input-complete" })]),
  ];
  assert.deepEqual(collectPendingAskUser(messages), [{ toolCallId: "ask-bad", question: "" }]);
}

// Empty conversation → empty snapshot parts.
{
  assert.deepEqual(collectPendingApprovals([]), []);
  assert.deepEqual(collectPendingAskUser([]), []);
}

console.log("session-interaction-channel validation passed");
