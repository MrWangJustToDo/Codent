/**
 * Validates cancelIncompleteToolCalls cleanup used after abort.
 *
 * Run: pnpm --filter @codent/core run validate:incomplete-tool-calls
 */

import assert from "node:assert/strict";

import {
  INTERRUPTED_RUN_MESSAGE,
  TOOL_CANCELLED_MESSAGE,
  TOOL_RUN_ENDED_MESSAGE,
  TRUNCATED_TOOL_CALL_MESSAGE,
  cancelIncompleteToolCalls,
  cancelInFlightToolCalls,
  settleChatToolCalls,
  settleInterruptedToolCalls,
  settleToolCalls,
  describeToolCallBatch,
  hasCancellableIncompleteToolCalls,
  hasInFlightToolCalls,
  hasTruncatedToolArguments,
  hasTruncatedToolCalls,
  hasValidToolArguments,
  isCancellableIncompleteToolCall,
  isInFlightToolCall,
  isInterruptedToolOutput,
  isTruncatedToolCall,
  toolSchemaRequiresArguments,
} from "../dist/dev.mjs";

const streaming = {
  type: "tool-call",
  id: "call_1",
  name: "task",
  arguments: '{"description": "分析 Core',
  state: "input-streaming",
};

// A payload the stream stopped inside is truncated, not cancellable work: the incomplete pass must
// not claim it (it gets its own settlement text, not "Cancelled by user.").
assert.equal(isCancellableIncompleteToolCall(streaming), false);
assert.equal(isTruncatedToolCall(streaming), true);
assert.equal(hasValidToolArguments(streaming), false);

assert.equal(
  isCancellableIncompleteToolCall({
    ...streaming,
    state: "input-complete",
    arguments: '{"ok":true}',
  }),
  false,
  "valid input-complete must wait for tool-phase, not cancel"
);

assert.equal(
  isCancellableIncompleteToolCall({
    ...streaming,
    state: "input-complete",
    arguments: '{"description": "分析 Core',
  }),
  false,
  "a truncated input-complete payload is settled as truncated, not cancelled"
);
assert.equal(
  isTruncatedToolCall({ ...streaming, state: "input-complete", arguments: '{"description": "分析 Core' }),
  true
);

assert.equal(
  isCancellableIncompleteToolCall({
    type: "tool-call",
    id: "call_run",
    name: "run_command",
    arguments: '{"command":"git status"}',
    state: "approval-responded",
    approval: { id: "a1", needsApproval: true, approved: true },
  }),
  false,
  "approved tools (user pressed y) must not be cancelled"
);

assert.equal(
  isCancellableIncompleteToolCall({
    ...streaming,
    state: "approval-requested",
    approval: { id: "a1", needsApproval: true },
  }),
  false
);

assert.equal(
  isCancellableIncompleteToolCall({
    ...streaming,
    state: "complete",
    output: { ok: true },
  }),
  false
);

// The incomplete pass still owns a finalize-promoted payload that is not JSON at all (the abort
// left the engine to settle it); a payload that merely stopped mid-object is the truncated case.
const brokenJson = {
  type: "tool-call",
  id: "call_1",
  name: "task",
  arguments: "not json",
  state: "input-complete",
};
const messages = [
  {
    id: "a1",
    role: "assistant",
    parts: [brokenJson],
  },
];

assert.equal(hasCancellableIncompleteToolCalls(messages), true);

const cancelled = cancelIncompleteToolCalls(messages);
assert.equal(hasCancellableIncompleteToolCalls(cancelled), false);
const part = cancelled[0].parts[0];
assert.equal(part.state, "error");
assert.equal(part.output.error, TOOL_CANCELLED_MESSAGE);
assert.equal(cancelled[0].parts[1].type, "tool-result");
assert.equal(cancelled[0].parts[1].toolCallId, "call_1");

const again = cancelIncompleteToolCalls(cancelled);
assert.equal(again, cancelled);

// ===== in-flight (currently executing) tool calls =====
const inFlight = {
  type: "tool-call",
  id: "call_run",
  name: "run_command",
  arguments: '{"command":"git status"}',
  state: "input-complete",
};

assert.equal(isInFlightToolCall(inFlight), true, "valid input-complete executing tool is in-flight");
assert.equal(
  isInFlightToolCall({ ...inFlight, state: "input-streaming", arguments: '{"com' }),
  false,
  "truncated streams are incomplete, not in-flight"
);
assert.equal(
  isInFlightToolCall({
    ...inFlight,
    state: "approval-responded",
    approval: { id: "a1", needsApproval: true, approved: true },
  }),
  true,
  "approved-but-not-yet-resolved tool is in-flight on abort"
);
assert.equal(
  isInFlightToolCall({ ...inFlight, state: "approval-requested", approval: { id: "a1", needsApproval: true } }),
  false,
  "pending approval is not in-flight"
);
assert.equal(
  isInFlightToolCall({ ...inFlight, state: "complete", output: { ok: true } }),
  false,
  "already-complete tool is not in-flight"
);

const inFlightMessages = [
  {
    id: "a2",
    role: "assistant",
    parts: [inFlight],
  },
];
assert.equal(hasInFlightToolCalls(inFlightMessages), true);

const cancelledInFlight = cancelInFlightToolCalls(inFlightMessages);
assert.equal(hasInFlightToolCalls(cancelledInFlight), false);
const inFlightPart = cancelledInFlight[0].parts[0];
assert.equal(inFlightPart.state, "complete");
assert.equal(inFlightPart.output.error, TOOL_CANCELLED_MESSAGE);
assert.equal(cancelledInFlight[0].parts[1].type, "tool-result");
const inFlightResult = JSON.parse(cancelledInFlight[0].parts[1].content);
assert.equal(inFlightResult.cancelled, true);
assert.equal(inFlightResult.error, TOOL_CANCELLED_MESSAGE);

// Restore must settle both shapes, while leaving a pending approval as a legitimate
// resume/interaction state instead of marking it as an interrupted run.
const restoredMessages = settleInterruptedToolCalls([
  messages[0],
  inFlightMessages[0],
  {
    id: "a3",
    role: "assistant",
    parts: [
      {
        ...inFlight,
        id: "call_approval",
        state: "approval-requested",
        approval: { id: "approval-1", needsApproval: true },
      },
    ],
  },
  {
    id: "a4",
    role: "assistant",
    parts: [
      {
        ...inFlight,
        id: "call_ask",
        name: "ask_user",
        arguments: '{"question":"which file?"}',
      },
    ],
  },
]);
assert.equal(hasCancellableIncompleteToolCalls(restoredMessages), false);
assert.equal(hasInFlightToolCalls(restoredMessages), true, "only the pending ask_user remains in-flight after restore");
assert.equal(restoredMessages[0].parts[0].output.error, INTERRUPTED_RUN_MESSAGE);
assert.equal(restoredMessages[1].parts[0].output.error, INTERRUPTED_RUN_MESSAGE);
assert.equal(restoredMessages[2].parts[0].state, "approval-requested");
assert.equal(restoredMessages[2].parts[0].output, undefined);
assert.equal(restoredMessages[3].parts[0].state, "input-complete");
assert.equal(restoredMessages[3].parts[0].output, undefined, "pending ask_user survives restore");
assert.equal(settleInterruptedToolCalls(restoredMessages), restoredMessages, "a second settle pass is a no-op");

// ===== the settle reports exactly what it changed =====
// The `tool:settle` timeline row is built from this callback, not from a second predicate copy:
// a copy decided against the pre-mutation snapshot and drifted from `settleToolCalls` (the abort
// path settled truncated calls the copy had filtered out).
{
  const mixed = [
    { ...messages[0] },
    { ...inFlightMessages[0] },
    {
      id: "a5",
      role: "assistant",
      parts: [
        {
          ...inFlight,
          id: "call_approval",
          state: "approval-requested",
          approval: { id: "approval-1", needsApproval: true },
        },
        { ...inFlight, id: "call_ask", name: "ask_user", arguments: '{"question":"which file?"}' },
      ],
    },
  ];

  const reportedIncompleteOnly = [];
  settleToolCalls(mixed, {
    includeInFlight: false,
    onSettled: (part) => reportedIncompleteOnly.push(part.id),
  });
  assert.deepEqual(
    reportedIncompleteOnly,
    ["call_1"],
    "includeInFlight:false reports the truncated call only — not the in-flight one it leaves alone"
  );

  const reportedAll = [];
  settleToolCalls(mixed, {
    includeInFlight: true,
    preservePendingAskUser: true,
    onSettled: (part) => reportedAll.push(part.id),
  });
  assert.deepEqual(
    reportedAll,
    ["call_1", "call_run"],
    "the full pass reports both shapes and neither the pending approval nor the answerable ask_user"
  );

  const settledOnce = settleToolCalls(mixed, { includeInFlight: true, preservePendingAskUser: true });
  const reportedAgain = [];
  settleToolCalls(settledOnce, {
    includeInFlight: true,
    preservePendingAskUser: true,
    onSettled: (part) => reportedAgain.push(part.id),
  });
  assert.deepEqual(reportedAgain, [], "a second pass over the same snapshot has nothing to settle and reports nothing");
}

// ===== truncated (zero-byte / required-arguments) calls =====
// A response can announce tool calls and never stream their arguments. Those calls are not
// cancellable work: `""`/whitespace is always truncated, and `{}` is truncated only when the tool's
// schema requires a property (so a legitimate no-argument call is unaffected).
{
  const requires = (name) => (name === "todo" ? true : undefined);
  const schema = { safeParse: (value) => ({ success: Object.keys(value ?? {}).length > 0 }) };
  assert.equal(toolSchemaRequiresArguments(schema), true);
  assert.equal(toolSchemaRequiresArguments({ safeParse: () => ({ success: true }) }), false);
  assert.equal(toolSchemaRequiresArguments(undefined), undefined, "unknown schema is not a guess");

  const zero = { type: "tool-call", id: "z1", name: "todo", arguments: "", state: "awaiting-input" };
  const zeroComplete = { ...zero, id: "z2", state: "input-complete" };
  const whitespace = { ...zero, id: "z3", arguments: "   " };
  const requiredEmpty = { ...zero, id: "z4", arguments: "{}" };
  const optionalEmpty = { ...zero, id: "z5", name: "list_file", arguments: "{}", state: "input-complete" };
  const partial = {
    type: "tool-call",
    id: "z6",
    name: "run_command",
    arguments: '{"command":',
    state: "input-streaming",
  };
  const normalCall = {
    type: "tool-call",
    id: "z7",
    name: "read_file",
    arguments: '{"path":"a.ts"}',
    state: "input-complete",
  };

  for (const [label, part] of [
    ["zero-byte awaiting-input", zero],
    ["zero-byte input-complete", zeroComplete],
    ["whitespace", whitespace],
    ["empty object with a required schema", requiredEmpty],
  ]) {
    assert.equal(hasTruncatedToolArguments(part, requires), true, `${label} is truncated`);
    assert.equal(isInFlightToolCall(part, requires), false, `${label} is not in-flight`);
    assert.equal(isTruncatedToolCall(part, requires), true, `${label} is a truncated call`);
  }
  assert.equal(hasTruncatedToolArguments(optionalEmpty, requires), false, "{} is valid when nothing is required");
  assert.equal(isInFlightToolCall(optionalEmpty, requires), true, "a no-argument call stays executable");
  assert.equal(isTruncatedToolCall(optionalEmpty, requires), false);
  assert.equal(
    hasTruncatedToolArguments(partial, requires),
    true,
    "an opened-but-unclosed argument payload is the same failure as zero bytes"
  );
  assert.equal(isTruncatedToolCall(partial, requires), true);
  assert.equal(isTruncatedToolCall(normalCall, requires), false);
  assert.equal(
    isTruncatedToolCall({ ...zero, approval: { id: "a1", needsApproval: true } }, requires),
    false,
    "a pending approval owns its own call"
  );
  assert.equal(isTruncatedToolCall({ ...zero, state: "complete", output: { ok: true } }, requires), false);

  const truncatedMessages = [{ id: "t1", role: "assistant", parts: [zeroComplete, requiredEmpty, optionalEmpty] }];
  assert.equal(hasTruncatedToolCalls(truncatedMessages, requires), true);
  assert.equal(
    hasCancellableIncompleteToolCalls(truncatedMessages, requires),
    false,
    "the incomplete pass must not claim truncated calls"
  );

  const settled = settleChatToolCalls(truncatedMessages, { includeInFlight: true, requiresArguments: requires });
  assert.deepEqual(
    settled.truncated.map((part) => part.id).sort(),
    ["z2", "z4"],
    "zero-byte and required-empty calls are the truncation group"
  );
  assert.deepEqual(
    settled.cancelled.map((part) => part.id),
    ["z5"],
    "the valid no-argument call is the only one settled as a cancellation"
  );
  for (const part of settled.messages[0].parts.filter((entry) => entry.type === "tool-call" && entry.output)) {
    if (part.id === "z5") continue;
    assert.equal(part.output.interrupted, true, `${part.id} carries the interruption marker`);
    assert.equal(part.output.argumentsIncomplete, true, `${part.id} names the argument failure`);
    assert.equal(part.output.cancelled, undefined, `${part.id} is not a user cancel`);
    assert.equal(part.output.error, TRUNCATED_TOOL_CALL_MESSAGE, `${part.id} names the truncation`);
  }
  assert.equal(
    settled.messages[0].parts.find((entry) => entry.type === "tool-call" && entry.id === "z5").output.cancelled,
    true
  );

  // An answered approval must reach its tool phase: the next pump's truncated pass cannot claim a
  // call the user just approved (its schema error belongs to the engine, not to "arguments missing").
  const approvedEmpty = {
    ...requiredEmpty,
    id: "z8",
    state: "approval-responded",
    approval: { id: "a2", needsApproval: true, approved: true },
  };
  assert.equal(isTruncatedToolCall(approvedEmpty, requires), false, "an approved call is not truncated");
  const approvedSettled = settleChatToolCalls([{ id: "t3", role: "assistant", parts: [approvedEmpty] }], {
    includeInFlight: false,
    requiresArguments: requires,
  });
  assert.deepEqual(approvedSettled.truncated, [], "the truncated pass leaves it alone");

  // Restore uses the same split: a zero-byte call is truncated, not "session interrupted". The
  // schema lookup travels too (a restored `{}` for a required-args tool reads as truncated, not as
  // an interrupted run), which is why the restore host exposes `getToolInputSchema`.
  const restored = settleInterruptedToolCalls([{ id: "t2", role: "assistant", parts: [zeroComplete] }]);
  assert.equal(restored[0].parts[0].output.interrupted, true);
  assert.equal(restored[0].parts[0].output.argumentsIncomplete, true);
  assert.equal(restored[0].parts[0].output.error, TRUNCATED_TOOL_CALL_MESSAGE);
  const restoredRequiredEmpty = settleInterruptedToolCalls(
    [{ id: "t4", role: "assistant", parts: [requiredEmpty] }],
    undefined,
    (name) => (name === "todo" ? true : undefined)
  );
  assert.equal(restoredRequiredEmpty[0].parts[0].output.argumentsIncomplete, true);
  assert.equal(restoredRequiredEmpty[0].parts[0].output.cancelled, undefined);
}

// ===== a run failure settles the remainder as interrupted, never as a cancel =====
// This is the user-visible half of the fix: a stall / terminal-less stream ends the turn as a
// failure, and the rows it left behind must not read as work the user cancelled.
{
  const inFlight = {
    type: "tool-call",
    id: "i1",
    name: "run_command",
    arguments: '{"command":"npm test"}',
    state: "input-complete",
  };
  const pendingApproval = {
    type: "tool-call",
    id: "i2",
    name: "task",
    arguments: '{"prompt":"x"}',
    state: "input-complete",
    approval: { id: "a1", needsApproval: true },
  };
  const failed = settleChatToolCalls([{ id: "m-fail", role: "assistant", parts: [inFlight, pendingApproval] }], {
    interrupted: true,
    includeInFlight: true,
    reason: TOOL_RUN_ENDED_MESSAGE,
  });
  assert.deepEqual(failed.cancelled, [], "a failed run cancels nothing");
  assert.deepEqual(
    failed.truncated.map((part) => part.id),
    ["i1"],
    "the in-flight call is reported in the did-not-run group"
  );
  const output = failed.messages[0].parts.find((part) => part.type === "tool-call" && part.id === "i1").output;
  assert.equal(output.cancelled, undefined, "the interrupted marker is not a user cancel");
  assert.equal(output.interrupted, true);
  assert.equal(output.error, TOOL_RUN_ENDED_MESSAGE);
  assert.equal(output.argumentsIncomplete, undefined, "a run-level interruption is not a truncation");
  assert.equal(isInterruptedToolOutput(output), true);
  const stillPending = failed.messages[0].parts.find((part) => part.type === "tool-call" && part.id === "i2");
  assert.equal(stillPending.output, undefined, "a pending approval keeps its own owner");
}

// ===== malformed-batch shape for the diagnostic =====
{
  const repeat = Array.from({ length: 9 }, (_, index) => ({
    type: "tool-call",
    id: `r${index}`,
    name: "run_command",
    arguments: "",
    state: "awaiting-input",
  }));
  const shape = describeToolCallBatch([{ id: "b1", role: "assistant", parts: repeat }]);
  assert.equal(shape.toolCalls, 9);
  assert.equal(shape.emptyArgs, 9);
  assert.equal(shape.repeated, true);
  assert.equal(shape.malformed, true);
  assert.deepEqual(shape.names, ["run_command"]);
  assert.equal(
    describeToolCallBatch([{ id: "b2", role: "assistant", parts: [normalCallPlaceholder()] }]).malformed,
    false
  );

  // Already-settled calls are history, not this response's shape: re-describing them on every later
  // turn is what wrote one warn row per turn for a single broken response.
  const settledBatch = settleChatToolCalls([{ id: "b3", role: "assistant", parts: repeat }]);
  const after = describeToolCallBatch(settledBatch.messages);
  assert.equal(after.toolCalls, 0);
  assert.equal(after.emptyArgs, 0);
  assert.equal(after.malformed, false, "a settled batch is not reported again");
  assert.equal(describeToolCallBatch([{ id: "b4", role: "assistant", parts: repeat }]).messageId, "b4");
}

function normalCallPlaceholder() {
  return {
    type: "tool-call",
    id: "ok1",
    name: "read_file",
    arguments: '{"path":"a.ts"}',
    state: "input-complete",
  };
}

console.log("incomplete-tool-calls validation passed");
