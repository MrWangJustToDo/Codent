/**
 * The restart-retry UI reset (`AgentUIChannel.resetRetryUiState`).
 *
 * Three shapes, all of which matter and only one of which is about this run's text:
 *
 * 1. a row that PREDATES the run must survive — a wake turn runs with the previous answer last, and a
 *    stale retry can be handed a fresh transcript. Dropping it rewrites the user's transcript and
 *    breaks the store's append-only path (whole `session.jsonl` rewrite).
 * 2. the failed attempt's trailing TEXT-ONLY row must go, and the retry's text must land in its OWN
 *    row — otherwise the aborted prefix is duplicated into the answered turn, the session file, and
 *    every later wire.
 * 3. a TOOL-BEARING row must survive (that is the progress the retry resumes from), and the retry's
 *    text must still not append to it: the retry's first chunk can arrive without a `messageId`, which
 *    relies on the processor's active-assistant fallback being cleared.
 *
 * Run: pnpm --filter @codent/core run validate:retry-ui-reset
 */

import { EventType } from "@tanstack/ai/client";
import assert from "node:assert/strict";

import { AgentUIChannel } from "../dist/dev.mjs";

const threadId = "thread-retry-reset";

const userRow = (id, content) => ({
  id,
  role: "user",
  parts: [{ type: "text", content }],
  createdAt: new Date(),
});

const assistantRow = (id, content) => ({
  id,
  role: "assistant",
  parts: [{ type: "text", content }],
  createdAt: new Date(),
});

const textOf = (message) =>
  message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.content)
    .join("");

// ---------------------------------------------------------------------------
// 1. A row that predates the run survives
// ---------------------------------------------------------------------------
//
// `historicalMessageIds` is the run-boundary snapshot, i.e. exactly "ids that existed before this run".
{
  const channel = new AgentUIChannel({
    initialMessages: [userRow("prompt-pre", "find the test framework"), assistantRow("answer-pre", "previous answer")],
  });
  channel.resetRetryUiState();
  assert.equal(channel.getMessages().length, 2, "a row that predates the run survives the retry reset");
  assert.equal(textOf(channel.getMessages()[1]), "previous answer");
}

// ---------------------------------------------------------------------------
// 2. The failed attempt's text-only row is dropped, and the retry gets its own row
// ---------------------------------------------------------------------------
{
  const channel = new AgentUIChannel({ initialMessages: [userRow("prompt-rs", "find the test framework")] });
  await channel.consumeRun({
    stream: (async function* () {
      // Attempt 1 streams a partial answer, then the transport fails.
      yield {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "attempt-1",
        role: "assistant",
        threadId,
        runId: "run-rs-1",
      };
      yield {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "attempt-1",
        delta: "partial answer",
        threadId,
        runId: "run-rs-1",
      };
      channel.resetRetryUiState();
      // Attempt 2 carries a fresh engine-generated id, exactly as a real restart does.
      yield {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "attempt-2",
        role: "assistant",
        threadId,
        runId: "run-rs-2",
      };
      yield {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "attempt-2",
        delta: "full answer",
        threadId,
        runId: "run-rs-2",
      };
      yield {
        type: EventType.RUN_FINISHED,
        threadId,
        runId: "run-rs-2",
        timestamp: Date.now(),
        finishReason: "stop",
        model: "mock",
      };
    })(),
  });
  const assistantRows = channel.getMessages().filter((message) => message.role === "assistant");
  assert.equal(assistantRows.length, 1, "the aborted attempt's row is dropped and the retry gets its own");
  assert.equal(textOf(assistantRows[0]), "full answer", "the retry text is not appended to the aborted prefix");
}

// ---------------------------------------------------------------------------
// 3. A tool-bearing row is kept, and still does not absorb the retry's text
// ---------------------------------------------------------------------------
{
  const channel = new AgentUIChannel({ initialMessages: [userRow("prompt-tr", "check the repo")] });
  await channel.consumeRun({
    stream: (async function* () {
      yield {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "attempt-tool",
        role: "assistant",
        threadId,
        runId: "run-tr-1",
      };
      yield {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc-keep",
        toolCallName: "grep",
        messageId: "attempt-tool",
        threadId,
        runId: "run-tr-1",
      };
      channel.resetRetryUiState();
      // No TEXT_MESSAGE_START: the retry's text relies on the active-assistant fallback, which the
      // reset must have cleared. Without that, this delta appends to the kept tool row.
      yield { type: EventType.TEXT_MESSAGE_CONTENT, delta: "retry text", threadId, runId: "run-tr-2" };
      yield {
        type: EventType.RUN_FINISHED,
        threadId,
        runId: "run-tr-2",
        timestamp: Date.now(),
        finishReason: "stop",
        model: "mock",
      };
    })(),
  });
  const rows = channel.getMessages().filter((message) => message.role === "assistant");
  assert.equal(rows.length, 2, "the kept tool row and a NEW retry row (the active id was cleared)");
  assert.ok(
    rows[0].parts.some((part) => part.type === "tool-call" && part.id === "tc-keep"),
    "the tool call the retry resumes from is still there"
  );
  assert.equal(textOf(rows[1]), "retry text", "the retry text did not append to the kept tool row");
}

// ---------------------------------------------------------------------------
// 4. A synthetic `<ctx>` row after the aborted text does not shield it
// ---------------------------------------------------------------------------
//
// The failed attempt's own `onConfig` can append a `<ctx kind=…>` block AFTER it streamed text, so the
// tail is that user row. The drop must walk past it — and must recognise it by CONTENT (the shared
// `isContextUIMessage`, the same test compaction uses), not by an id shape that a restored transcript
// may not match.
{
  const channel = new AgentUIChannel({ initialMessages: [userRow("prompt-ctx", "check the repo")] });
  const ctx = "<ctx kind=current_date>\n2026-11-27\n</ctx>";
  await channel.consumeRun({
    stream: (async function* () {
      yield {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "attempt-ctx",
        role: "assistant",
        threadId,
        runId: "run-ctx-1",
      };
      yield {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "attempt-ctx",
        delta: "partial answer",
        threadId,
        runId: "run-ctx-1",
      };
      channel.addUserMessage(ctx, "ctx-current_date-1234abcd");
      channel.resetRetryUiState();
      yield {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "attempt-ctx-2",
        role: "assistant",
        threadId,
        runId: "run-ctx-2",
      };
      yield {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "attempt-ctx-2",
        delta: "full answer",
        threadId,
        runId: "run-ctx-2",
      };
      yield {
        type: EventType.RUN_FINISHED,
        threadId,
        runId: "run-ctx-2",
        timestamp: Date.now(),
        finishReason: "stop",
        model: "mock",
      };
    })(),
  });
  const messages = channel.getMessages();
  assert.deepEqual(
    messages.map((message) => message.role),
    ["user", "user", "assistant"],
    "the aborted prefix is dropped and the injected <ctx> row survives"
  );
  assert.equal(textOf(messages[1]), ctx, "the context block is untouched");
  assert.equal(textOf(messages[2]), "full answer", "the retry has its own row");
}

// ---------------------------------------------------------------------------
// 5. A wake turn's `turnStart` mark moves to the retry's row
// ---------------------------------------------------------------------------
//
// A wake turn has no user message, so its first output carries `metadata.turnStart` (ACP groups by
// that). Dropping the aborted row without re-arming the mark folds the retry's answer into the
// PREVIOUS turn on such a host.
{
  const channel = new AgentUIChannel({ initialMessages: [userRow("prompt-turn", "check the repo")] });
  channel.markTurnStart();
  await channel.consumeRun({
    stream: (async function* () {
      yield {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "attempt-turn",
        role: "assistant",
        threadId,
        runId: "run-turn-1",
      };
      yield {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "attempt-turn",
        delta: "partial answer",
        threadId,
        runId: "run-turn-1",
      };
      channel.resetRetryUiState();
      yield {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "attempt-turn-2",
        role: "assistant",
        threadId,
        runId: "run-turn-2",
      };
      yield {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "attempt-turn-2",
        delta: "full answer",
        threadId,
        runId: "run-turn-2",
      };
      yield {
        type: EventType.RUN_FINISHED,
        threadId,
        runId: "run-turn-2",
        timestamp: Date.now(),
        finishReason: "stop",
        model: "mock",
      };
    })(),
  });
  const assistantRows = channel.getMessages().filter((message) => message.role === "assistant");
  assert.equal(assistantRows.length, 1, "the aborted wake row is dropped");
  assert.equal(assistantRows[0].metadata?.turnStart, true, "the retry's row carries the wake-turn mark");
}

console.log("retry-ui-reset validation passed");
