/**
 * Validates that a client-tool answer lands on the LIVE call when the provider reuses its id.
 *
 * Provider tool-call ids are request-scoped and reused (`call_0`), so a session that asks two
 * questions holds two parts with the same id. The SDK's `addToolResult` matches the FIRST part in
 * EVERY message: answering the second question used to overwrite the first turn's answer and attach a
 * second result to it, while the live call stayed unanswered (the controller's guard, which looked up
 * the first part too, rejected the answer outright).
 *
 * Run: pnpm --filter @codent/core run validate:client-tool-answer
 */

import { uiMessageToModelMessages } from "@tanstack/ai";
import assert from "node:assert/strict";

import { AgentUIChannel, findLastToolCallPart, isSettledToolCallPart } from "../dist/dev.mjs";

const toolCall = (id, output) => ({
  type: "tool-call",
  id,
  name: "ask_user",
  arguments: '{"question":"which?"}',
  state: output === undefined ? "input-complete" : "complete",
  input: { question: "which?" },
  ...(output === undefined ? {} : { output }),
});

// Two turns, one reused id.
const channel = new AgentUIChannel({
  initialMessages: [
    {
      id: "assistant-1",
      role: "assistant",
      parts: [
        toolCall("call_0", { answer: "first" }),
        { type: "tool-result", toolCallId: "call_0", content: '{"answer":"first"}', state: "complete" },
      ],
    },
    { id: "user-1", role: "user", parts: [{ type: "text", content: "again" }] },
    { id: "assistant-2", role: "assistant", parts: [toolCall("call_0")] },
  ],
});

channel.addToolResult("call_0", { answer: "second" });
const messages = channel.getMessages();

const firstCall = messages[0].parts.find((part) => part.type === "tool-call");
assert.deepEqual(firstCall?.output, { answer: "first" }, "the previous turn's answer is untouched");
assert.equal(
  messages[0].parts.filter((part) => part.type === "tool-result").length,
  1,
  "no second result is attached to the old message"
);

const liveCall = messages[2].parts.find((part) => part.type === "tool-call");
assert.deepEqual(liveCall?.output, { answer: "second" }, "the live call gets the answer");
assert.equal(isSettledToolCallPart(liveCall), true, "…and is settled");

const liveResult = messages[2].parts.find((part) => part.type === "tool-result");
assert.ok(liveResult, "a tool-result part is added to the live message — the model wire reads that part");

// The DISPLAY follows the same target. Patching every part carrying the reused id gave the previous
// turn's completed row the new call's summary (output from turn 1, display from turn 2) — and the
// channel is what gets persisted, so the mismatched pair outlived the session.
channel.attachToolDisplay("call_0", { summary: "second-display" });
const displayed = channel.getMessages();
assert.equal(
  displayed[0].parts.find((part) => part.type === "tool-call")?.display,
  undefined,
  "the previous turn's row keeps its own display"
);
assert.deepEqual(
  displayed[2].parts.find((part) => part.type === "tool-call")?.display,
  { summary: "second-display" },
  "the live call gets the display, exactly as it got the result"
);
assert.equal(liveResult.toolCallId, "call_0");
assert.equal(liveResult.state, "complete");

// The model wire must carry BOTH results, each in the turn that asked. A call-only patch would have
// settled the UI and left the model without an answer.
const wire1 = uiMessageToModelMessages(messages[0]);
const wire2 = uiMessageToModelMessages(messages[2]);
const toolResults = [...wire1, ...wire2].filter((message) => message.role === "tool");
assert.equal(toolResults.length, 2, "one result per asked call");
assert.equal(String(toolResults[0].content).includes("first"), true, "the first turn's answer survives");
assert.equal(String(toolResults[1].content).includes("second"), true, "the second turn's answer reaches the wire");

// The predicate the controller now uses resolves the same part.
const last = findLastToolCallPart(messages, "call_0");
assert.deepEqual(last?.output, { answer: "second" }, "last-part resolution agrees with the write");
assert.equal(findLastToolCallPart(messages, "call_missing"), undefined);

// An `undefined` answer still settles the part, which is why "answered" is decided by state, not by
// `output !== undefined` — the old test let the same call be answered repeatedly.
const single = new AgentUIChannel({
  initialMessages: [{ id: "assistant-3", role: "assistant", parts: [toolCall("call_9")] }],
});
single.addToolResult("call_9", undefined);
const settled = single.getMessages()[0].parts.find((part) => part.type === "tool-call");
assert.equal(settled?.state, "complete", "an undefined answer settles the part");
assert.equal(isSettledToolCallPart(settled), true, "…so a second answer is refused by state, not by `output`");

console.log("client tool answer validation passed");
