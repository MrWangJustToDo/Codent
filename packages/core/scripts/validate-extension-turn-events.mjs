/**
 * Validates the turn/message boundary events.
 *
 * These are the general facts an extension needs instead of a purpose-built "first output" event:
 * `agent:iteration` opens a turn, `turn:end` closes it, and assistant messages bracket themselves. The
 * assertions that matter are the ones a naive implementation gets wrong: firing `message:start` twice
 * for one response, counting a tool-only turn as "no output", and reporting an aborted turn as
 * finished.
 *
 * Run: pnpm --filter @codent/core run validate:extension-turn-events
 */
import assert from "node:assert/strict";

import { UsageTracker, createLifecycleMiddleware } from "../dist/dev.mjs";

function drive() {
  const events = [];
  const middleware = createLifecycleMiddleware({
    usage: new UsageTracker(),
    getPricing: () => null,
    emitEvent: (type, payload) => events.push({ type, payload }),
  });
  const ctx = { model: "fake-model", iteration: 0, messages: [], toolNames: [] };
  const of = (type) => events.filter((event) => event.type === type);
  return { events, middleware, ctx, of };
}

// ── 1. a text turn: start once, end with the text, turn closes ─────────────
{
  const { middleware, ctx, of } = drive();
  middleware.onStart(ctx);
  middleware.onChunk(ctx, { type: "TEXT_MESSAGE_START", messageId: "msg-1" });
  middleware.onChunk(ctx, { type: "TEXT_MESSAGE_CONTENT", delta: "hel" });
  middleware.onChunk(ctx, { type: "TEXT_MESSAGE_CONTENT", delta: "lo" });
  middleware.onChunk(ctx, { type: "RUN_FINISHED", finishReason: "stop" });

  const starts = of("message:start");
  assert.equal(starts.length, 1, "one assistant message per turn opens once");
  assert.equal(starts[0].payload.firstOutput, true, "the run's first assistant output is flagged");
  assert.equal(starts[0].payload.messageId, "msg-1");

  const ends = of("message:end");
  assert.equal(ends.length, 1);
  assert.equal(ends[0].payload.text, "hello", "the finalized text is the accumulated delta");
  assert.equal(ends[0].payload.finishReason, "stop");
  assert.equal(ends[0].payload.firstOutput, true);

  const turns = of("turn:end");
  assert.deepEqual(turns[0].payload, { index: 1, finishReason: "stop", toolCalls: 0 });
}

// ── 2. the second turn is not the first output ─────────────────────────────
{
  const { middleware, ctx, of } = drive();
  middleware.onStart(ctx);
  middleware.onChunk(ctx, { type: "TEXT_MESSAGE_START", messageId: "m1" });
  middleware.onChunk(ctx, { type: "RUN_FINISHED", finishReason: "tool_calls" });

  ctx.iteration = 1;
  middleware.onStart(ctx);
  middleware.onChunk(ctx, { type: "TEXT_MESSAGE_START", messageId: "m2" });
  middleware.onChunk(ctx, { type: "TEXT_MESSAGE_CONTENT", delta: "second" });
  middleware.onChunk(ctx, { type: "RUN_FINISHED", finishReason: "stop" });

  const starts = of("message:start");
  assert.deepEqual(
    starts.map((event) => event.payload.firstOutput),
    [true, false],
    "only the run's first assistant output carries firstOutput=true"
  );
  const turns = of("turn:end");
  assert.deepEqual(
    turns.map((event) => event.payload.index),
    [1, 2],
    "turn indices pair with agent:iteration (both 1-based)"
  );
}

// ── 3. a tool-only turn still brackets its message ─────────────────────────
{
  const { middleware, ctx, of } = drive();
  middleware.onStart(ctx);
  middleware.onChunk(ctx, { type: "TOOL_CALL_START", toolCallId: "call-1", toolName: "read_file" });
  middleware.onChunk(ctx, { type: "TOOL_CALL_START", toolCallId: "call-2", toolName: "grep" });
  middleware.onChunk(ctx, { type: "RUN_FINISHED", finishReason: "tool_calls" });

  assert.equal(of("message:start").length, 1, "a tool-call message is still an assistant message");
  const end = of("message:end")[0].payload;
  assert.equal(end.toolCalls, 2, "both tool calls are counted on the message");
  assert.equal(end.text, "");
  assert.deepEqual(of("turn:end")[0].payload, { index: 1, finishReason: "tool_calls", toolCalls: 2 });
}

// ── 4. an aborted turn is not reported as finished ─────────────────────────
{
  const { middleware, ctx, of } = drive();
  middleware.onStart(ctx);
  middleware.onChunk(ctx, { type: "TEXT_MESSAGE_START", messageId: "m1" });
  middleware.onChunk(ctx, { type: "TEXT_MESSAGE_CONTENT", delta: "partial" });
  // No RUN_FINISHED: the stream died / the run was aborted.

  assert.equal(of("turn:end").length, 0, "an aborted turn must not be reported as completed");
  assert.equal(of("message:end").length, 0, "and its message is not finalized");
  assert.equal(of("message:start").length, 1, "while the start it did emit stays valid");
}

console.log("extension turn events validation passed");
