/**
 * Validates AgentUIChannel stream → UIMessage[] conversion (text, tool-call, tool-result).
 *
 * Run: pnpm --filter @codent/core run validate:agent-ui-channel
 */

import { EventType } from "@tanstack/ai/client";
import assert from "node:assert/strict";

import { AgentUIChannel, AgentStreamHub, createAgentEventBus, agentStreamKey } from "../dist/dev.mjs";

const threadId = "thread-ui";
const runId = "run-ui";
const messageId = "assistant-ui-1";
const toolCallId = "tool-call-1";

function mockRunStream() {
  return (async function* () {
    yield {
      type: EventType.RUN_STARTED,
      threadId,
      runId,
      timestamp: Date.now(),
    };
    yield {
      type: EventType.CUSTOM,
      name: "subagent-progress",
      value: { pct: 25 },
      threadId,
      runId,
    };
    yield {
      type: EventType.TEXT_MESSAGE_START,
      messageId,
      role: "assistant",
      threadId,
      runId,
    };
    yield {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId,
      delta: "Checking files...",
      threadId,
      runId,
    };
    yield {
      type: EventType.TEXT_MESSAGE_END,
      messageId,
      threadId,
      runId,
    };
    yield {
      type: EventType.TOOL_CALL_START,
      toolCallId,
      toolName: "read_file",
      messageId,
      threadId,
      runId,
    };
    yield {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId,
      delta: '{"path":"README.md"}',
      threadId,
      runId,
    };
    yield {
      type: EventType.TOOL_CALL_END,
      toolCallId,
      threadId,
      runId,
    };
    yield {
      type: EventType.TOOL_CALL_RESULT,
      toolCallId,
      content: "# Project",
      threadId,
      runId,
    };
    yield {
      type: EventType.RUN_FINISHED,
      threadId,
      runId,
      timestamp: Date.now(),
      finishReason: "stop",
      model: "mock",
    };
  })();
}

const customEvents = [];
const channel = new AgentUIChannel({
  onCustomEvent: (eventType, data) => {
    customEvents.push({ eventType, data });
  },
});

const channelBus = createAgentEventBus();
channel.setEventBus(channelBus);
let updateCount = 0;
const unsubscribe = channelBus.on("session:messages", () => {
  updateCount++;
});

const messages = await channel.consumeRun({ stream: mockRunStream() });
assert.ok(updateCount >= 1, "session:messages bus events should fire on message updates");

unsubscribe();

assert.equal(messages.length, 1);
const assistant = messages[0];
assert.equal(assistant.role, "assistant");

const partTypes = assistant.parts.map((p) => p.type);
assert.ok(partTypes.includes("text"), "expected text part");
assert.ok(partTypes.includes("tool-call"), "expected tool-call part");
assert.ok(partTypes.includes("tool-result"), "expected tool-result part");

const text = assistant.parts
  .filter((p) => p.type === "text")
  .map((p) => p.content)
  .join("");
assert.ok(text.includes("Checking files"), `unexpected text: ${text}`);

const toolCall = assistant.parts.find((p) => p.type === "tool-call");
assert.equal(toolCall?.name, "read_file");

assert.equal(customEvents.length, 1);
assert.equal(customEvents[0].eventType, "subagent-progress");

const emptyChannel = new AgentUIChannel({
  initialMessages: [
    {
      id: "assistant-deny",
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: "call_cmd",
          name: "run_command",
          arguments: "{}",
          state: "approval-responded",
          approval: { id: "approval_1", needsApproval: true, approved: false },
        },
        {
          type: "tool-result",
          toolCallId: "call_cmd",
          content: JSON.stringify({ approved: false, message: "no" }),
          state: "complete",
        },
      ],
    },
  ],
});

await emptyChannel.consumeRun({
  stream: (async function* () {
    yield {
      type: EventType.RUN_STARTED,
      threadId: "thread-empty",
      runId: "run-empty",
      timestamp: Date.now(),
    };
    yield {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "assistant-empty",
      role: "assistant",
      threadId: "thread-empty",
      runId: "run-empty",
    };
    yield {
      type: EventType.RUN_FINISHED,
      threadId: "thread-empty",
      runId: "run-empty",
      timestamp: Date.now(),
      finishReason: "stop",
      model: "mock",
    };
  })(),
});

assert.equal(emptyChannel.getMessages().length, 1);
assert.equal(emptyChannel.getMessages()[0].id, "assistant-deny");

// ============================================================================
// Summary stream via AgentStreamHub (no UIMessage diff / command stream sink).
// ============================================================================

const summaryStreamId = "task-1";
const summaryMsgId = "assistant-summary";
const longText = "x".repeat(200);

const summaryHub = new AgentStreamHub();
const summaryBus = createAgentEventBus();
summaryHub.setEventBus(summaryBus);
/** @type {import("../dist/dev.mjs").AgentStreamEvent[]} */
const summaryEvents = [];
const unsubSummary = summaryBus.on("session:summary", (event) => summaryEvents.push(event.payload));

const summaryChannel = new AgentUIChannel();
await summaryChannel.consumeRun({
  stream: (async function* () {
    yield {
      type: EventType.RUN_STARTED,
      threadId: "thread-summary",
      runId: "run-summary",
      timestamp: Date.now(),
    };
    yield {
      type: EventType.TEXT_MESSAGE_START,
      messageId: summaryMsgId,
      role: "assistant",
      threadId: "thread-summary",
      runId: "run-summary",
    };
    // Unlock summary phase via begin_summary
    yield {
      type: EventType.TOOL_CALL_START,
      toolCallId: "tc-bs",
      toolName: "begin_summary",
      messageId: summaryMsgId,
      threadId: "thread-summary",
      runId: "run-summary",
    };
    yield {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: summaryMsgId,
      delta: longText.slice(0, 100),
      threadId: "thread-summary",
      runId: "run-summary",
    };
    yield {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: summaryMsgId,
      delta: longText.slice(100),
      threadId: "thread-summary",
      runId: "run-summary",
    };
    // Transient tool segment — must NOT reset or clear the summary hub stream.
    yield {
      type: EventType.TOOL_CALL_START,
      toolCallId: "tc-2",
      toolName: "read_file",
      messageId: summaryMsgId,
      threadId: "thread-summary",
      runId: "run-summary",
    };
    yield {
      type: EventType.RUN_FINISHED,
      threadId: "thread-summary",
      runId: "run-summary",
      timestamp: Date.now(),
      finishReason: "stop",
      model: "mock",
    };
  })(),
  parentTaskToolCallId: summaryStreamId,
  summaryHub,
});

const summaryKey = agentStreamKey("task", summaryStreamId);
const summarySnap = summaryHub.getSnapshot(summaryKey);
assert.ok(summarySnap, "expected summary snapshot");
assert.equal(summarySnap.status, "ended");
assert.equal(summarySnap.pendingLine, longText, "full text should accumulate in pendingLine (no newlines)");
assert.equal(summaryEvents.filter((e) => e.type === "reset").length, 1, "exactly one reset (begin_summary)");
assert.ok(
  summaryEvents.some((e) => e.type === "append"),
  "expected append events"
);
assert.equal(summaryEvents.filter((e) => e.type === "end").length, 1, "exactly one end");
unsubSummary();

// ============================================================================
// Trailing-newline growth must stay monotonic (no shrink→clear→restream).
// ============================================================================

const monoHub = new AgentStreamHub();
const monoBus = createAgentEventBus();
monoHub.setEventBus(monoBus);
/** @type {string[]} */
const monoAppends = [];
const unsubMono = monoBus.on("session:summary", (event) => {
  if (event.payload.type === "append") monoAppends.push(event.payload.chunk);
});

const monoBase = "B".repeat(80);
const monoChannel = new AgentUIChannel();
await monoChannel.consumeRun({
  stream: (async function* () {
    yield {
      type: EventType.RUN_STARTED,
      threadId: "thread-mono",
      runId: "run-mono",
      timestamp: Date.now(),
    };
    yield {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "assistant-mono",
      role: "assistant",
      threadId: "thread-mono",
      runId: "run-mono",
    };
    yield {
      type: EventType.TOOL_CALL_START,
      toolCallId: "tc-bs-mono",
      toolName: "begin_summary",
      messageId: "assistant-mono",
      threadId: "thread-mono",
      runId: "run-mono",
    };
    yield {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "assistant-mono",
      delta: monoBase,
      threadId: "thread-mono",
      runId: "run-mono",
    };
    yield {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "assistant-mono",
      delta: "\n",
      threadId: "thread-mono",
      runId: "run-mono",
    };
    yield {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "assistant-mono",
      delta: "line2\nline3\nline4\nline5\nline6",
      threadId: "thread-mono",
      runId: "run-mono",
    };
    yield {
      type: EventType.RUN_FINISHED,
      threadId: "thread-mono",
      runId: "run-mono",
      timestamp: Date.now(),
      finishReason: "stop",
      model: "mock",
    };
  })(),
  parentTaskToolCallId: "task-mono",
  summaryHub: monoHub,
});

const monoJoined = monoAppends.join("");
assert.equal(monoJoined, monoBase + "\nline2\nline3\nline4\nline5\nline6");
const monoSnap = monoHub.getSnapshot(agentStreamKey("task", "task-mono"));
assert.ok(monoSnap);
assert.equal(monoSnap.status, "ended");
assert.deepEqual(monoSnap.lines, [monoBase, "line2", "line3", "line4", "line5"]);
assert.equal(monoSnap.pendingLine, "line6");
unsubMono();

// ============================================================================
// resetRetryUiState keeps the message history, rolls summary phase back, clears hub text
// ============================================================================

const retryHub = new AgentStreamHub();
const retryBus = createAgentEventBus();
retryHub.setEventBus(retryBus);
/** @type {Array<{ type: string }>} */
const retryEvents = [];
const unsubRetry = retryBus.on("session:summary", (event) => {
  retryEvents.push({ type: event.payload.type });
});

const retryChannel = new AgentUIChannel({
  initialMessages: [
    {
      id: "user-retry",
      role: "user",
      parts: [{ type: "text", content: "explore the repo" }],
      createdAt: new Date(),
    },
  ],
});

await retryChannel.consumeRun({
  stream: (async function* () {
    yield {
      type: EventType.RUN_STARTED,
      threadId: "thread-retry",
      runId: "run-retry-1",
      timestamp: Date.now(),
    };
    yield {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "assistant-retry",
      role: "assistant",
      threadId: "thread-retry",
      runId: "run-retry-1",
    };
    yield {
      type: EventType.TOOL_CALL_START,
      toolCallId: "tc-grep",
      toolName: "grep",
      messageId: "assistant-retry",
      threadId: "thread-retry",
      runId: "run-retry-1",
    };
    yield {
      type: EventType.TOOL_CALL_END,
      toolCallId: "tc-grep",
      threadId: "thread-retry",
      runId: "run-retry-1",
    };
    yield {
      type: EventType.TOOL_CALL_START,
      toolCallId: "tc-bs-retry",
      toolName: "begin_summary",
      messageId: "assistant-retry",
      threadId: "thread-retry",
      runId: "run-retry-1",
    };
    yield {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "assistant-retry",
      delta: "partial summary before failure",
      threadId: "thread-retry",
      runId: "run-retry-1",
    };
    // Simulate the retry-time UI reset (as runStreamWithRecovery does before a restart retry).
    retryChannel.resetRetryUiState();
    assert.equal(retryChannel.getTaskRunPhase(), "tools");
    // The history is the wire: what the dead attempt already did must survive the reset, or the
    // retry re-explores from the prompt. (Subagent-only history loss is the bug this guards.)
    assert.equal(retryChannel.getMessages()[0].role, "user");
    assert.equal(retryChannel.getMessages().length, 2, "the attempt's history is kept (prompt + in-flight assistant)");
    assert.ok(
      retryChannel.getMessages().some((m) => m.parts.some((p) => p.type === "tool-call" && p.id === "tc-grep")),
      "the tool call the dead attempt already made is still in the channel"
    );
    assert.ok(retryEvents.filter((e) => e.type === "reset").length >= 2, "begin_summary reset + retry reset");
    yield {
      type: EventType.RUN_STARTED,
      threadId: "thread-retry",
      runId: "run-retry-2",
      timestamp: Date.now(),
    };
    yield {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "assistant-retry-2",
      role: "assistant",
      threadId: "thread-retry",
      runId: "run-retry-2",
    };
    yield {
      type: EventType.TOOL_CALL_START,
      toolCallId: "tc-bs-retry-2",
      toolName: "begin_summary",
      messageId: "assistant-retry-2",
      threadId: "thread-retry",
      runId: "run-retry-2",
    };
    yield {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "assistant-retry-2",
      delta: "C".repeat(80),
      threadId: "thread-retry",
      runId: "run-retry-2",
    };
    yield {
      type: EventType.RUN_FINISHED,
      threadId: "thread-retry",
      runId: "run-retry-2",
      timestamp: Date.now(),
      finishReason: "stop",
      model: "mock",
    };
  })(),
  parentTaskToolCallId: "task-retry",
  summaryHub: retryHub,
});

assert.equal(
  retryChannel.getMessages().some((m) => m.role === "assistant"),
  true
);
const retrySnap = retryHub.getSnapshot(agentStreamKey("task", "task-retry"));
assert.ok(retrySnap);
assert.equal(retrySnap.status, "ended");
assert.equal(retrySnap.pendingLine, "C".repeat(80));
// consumeRun finally ends the hub and unlocks phase; live phase is only meaningful mid-run
assert.equal(retryChannel.getTaskRunPhase(), "tools");
unsubRetry();

// resetRetryUiState drops NO messages — not even assistant rows. The channel history is the wire
// (`compaction.onConfig` re-projects from it every attempt), so a subagent that already explored
// keeps that exploration across a retry instead of restarting from its prompt.
const tcRetryChannel = new AgentUIChannel({
  initialMessages: [
    {
      id: "tc-msg",
      role: "user",
      parts: [{ type: "text", content: "<ctx kind=current_date>\nnow\n</ctx>" }],
      createdAt: new Date(),
    },
    {
      id: "prompt-msg",
      role: "user",
      parts: [{ type: "text", content: "find the test framework" }],
      createdAt: new Date(),
    },
    {
      id: "assistant-tc",
      role: "assistant",
      parts: [{ type: "text", content: "partial work" }],
      createdAt: new Date(),
    },
  ],
});
tcRetryChannel.resetRetryUiState();
assert.equal(tcRetryChannel.getMessages().length, 3, "the retry reset drops no message at all");
assert.equal(tcRetryChannel.getMessages()[0].parts[0].content, "<ctx kind=current_date>\nnow\n</ctx>");
assert.equal(tcRetryChannel.getMessages()[1].parts[0].content, "find the test framework");
assert.equal(tcRetryChannel.getMessages()[2].parts[0].content, "partial work");

// failRun keeps the seeded prompt (+ optional error message) and clears summary state
const failChannel = new AgentUIChannel({
  initialMessages: [
    {
      id: "user-fail",
      role: "user",
      parts: [{ type: "text", content: "x" }],
      createdAt: new Date(),
    },
  ],
});
failChannel.setMessages([
  ...failChannel.getMessages(),
  {
    id: "assistant-fail",
    role: "assistant",
    parts: [{ type: "text", content: "partial" }],
    createdAt: new Date(),
  },
]);
failChannel.failRun();
assert.equal(failChannel.getMessages().length, 1, "failRun keeps the seeded user prompt");
assert.equal(failChannel.getMessages()[0].id, "user-fail");
assert.equal(failChannel.getTaskRunPhase(), "tools");

// failRun records the failure message after the kept prompt
const failErrorChannel = new AgentUIChannel({
  initialMessages: [
    {
      id: "user-fail-error",
      role: "user",
      parts: [{ type: "text", content: "x" }],
      createdAt: new Date(),
    },
  ],
});
failErrorChannel.failRun("boom");
const failErrorMessages = failErrorChannel.getMessages();
assert.equal(failErrorMessages.length, 2, "failRun appends an error message after the prompt");
assert.equal(failErrorMessages[0].id, "user-fail-error");
assert.equal(failErrorMessages[1].role, "assistant");
assert.match(failErrorMessages[1].parts[0].content, /boom/);
assert.equal(failErrorChannel.getTaskRunPhase(), "tools");

console.log("agent-ui-channel validation passed");
