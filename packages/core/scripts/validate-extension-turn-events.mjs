/**
 * Validates the turn/message boundary events.
 *
 * The hook that matters is `onIteration`, not `onStart`: TanStack calls `onStart` once per `chat()`
 * and `RUN_FINISHED` once per model iteration, so a boundary derived from `onStart` reports index 1
 * for every turn of a tool-using run. This drives the real hook sequence an engine produces.
 *
 * Run: pnpm --filter @codent/core run validate:extension-turn-events
 */
import assert from "node:assert/strict";

import { UsageTracker, createLifecycleMiddleware } from "../dist/dev.mjs";

function drive(runToken = "turn-1") {
  const events = [];
  const middleware = createLifecycleMiddleware({
    usage: new UsageTracker(),
    getPricing: () => null,
    getRunToken: () => runToken,
    maxIterations: 5,
    emitEvent: (type, payload) => events.push({ type, payload }),
  });
  const ctx = { model: "fake-model", iteration: 0, messages: [], toolNames: [] };
  const of = (type) => events.filter((event) => event.type === type);
  const beginTurn = (iteration) => {
    ctx.iteration = iteration;
    middleware.onIteration(ctx, { iteration });
  };
  return { events, middleware, ctx, of, beginTurn };
}

// ── 1. one text turn: a start, one message bracket, one end ─────────────────
{
  const { middleware, ctx, of, beginTurn } = drive();
  middleware.onStart(ctx);
  beginTurn(0);
  middleware.onChunk(ctx, { type: "TEXT_MESSAGE_START", messageId: "msg-1" });
  middleware.onChunk(ctx, { type: "TEXT_MESSAGE_CONTENT", delta: "hel" });
  middleware.onChunk(ctx, { type: "TEXT_MESSAGE_CONTENT", delta: "lo" });
  middleware.onChunk(ctx, { type: "RUN_FINISHED", finishReason: "stop" });

  assert.deepEqual(
    of("turn:start").map((e) => e.payload),
    [{ index: 1, max: 5 }]
  );
  const starts = of("message:start");
  assert.equal(starts.length, 1, "one assistant message per turn opens once");
  assert.equal(starts[0].payload.firstOutput, true, "the run's first assistant output is flagged");

  const ends = of("message:end");
  assert.equal(ends.length, 1);
  assert.equal(ends[0].payload.text, "hello");
  assert.equal(ends[0].payload.finishReason, "stop");
  assert.deepEqual(
    of("turn:end").map((e) => e.payload),
    [{ index: 1, finishReason: "stop", toolCalls: 0 }]
  );
}

// ── 2. a second turn advances the index, resets the payload, and is not "first" ─
{
  const { middleware, ctx, of, beginTurn } = drive();
  middleware.onStart(ctx);
  beginTurn(0);
  middleware.onChunk(ctx, { type: "TEXT_MESSAGE_START", messageId: "m1" });
  middleware.onChunk(ctx, { type: "TEXT_MESSAGE_CONTENT", delta: "one" });
  middleware.onChunk(ctx, { type: "TOOL_CALL_START", toolCallId: "c1", toolName: "read_file" });
  middleware.onChunk(ctx, { type: "RUN_FINISHED", finishReason: "tool_calls" });

  beginTurn(1);
  middleware.onChunk(ctx, { type: "TEXT_MESSAGE_START", messageId: "m2" });
  middleware.onChunk(ctx, { type: "TEXT_MESSAGE_CONTENT", delta: "two" });
  middleware.onChunk(ctx, { type: "RUN_FINISHED", finishReason: "stop" });

  assert.deepEqual(
    of("turn:start").map((e) => e.payload.index),
    [1, 2],
    "the turn index comes from the iteration, matching agent:iteration"
  );
  assert.deepEqual(
    of("turn:end").map((e) => ({ index: e.payload.index, toolCalls: e.payload.toolCalls })),
    [
      { index: 1, toolCalls: 1 },
      { index: 2, toolCalls: 0 },
    ],
    "tool calls are per turn, not cumulative"
  );
  const texts = of("message:end").map((e) => e.payload.text);
  assert.deepEqual(texts, ["one", "two"], "each message reports only its own text");
  assert.deepEqual(
    of("message:start").map((e) => e.payload.firstOutput),
    [true, false]
  );
}

// ── 3. a tool-only turn still brackets its message ─────────────────────────
{
  const { middleware, ctx, of, beginTurn } = drive();
  middleware.onStart(ctx);
  beginTurn(0);
  middleware.onChunk(ctx, { type: "TOOL_CALL_START", toolCallId: "call-1", toolName: "read_file" });
  middleware.onChunk(ctx, { type: "TOOL_CALL_START", toolCallId: "call-2", toolName: "grep" });
  middleware.onChunk(ctx, { type: "RUN_FINISHED", finishReason: "tool_calls" });

  assert.equal(of("message:start").length, 1, "a tool-call message is still an assistant message");
  assert.equal(of("message:end")[0].payload.toolCalls, 2);
  assert.equal(of("message:end")[0].payload.text, "");
  assert.deepEqual(of("turn:end")[0].payload, { index: 1, finishReason: "tool_calls", toolCalls: 2 });
}

// ── 4. an aborted turn opens but never closes ──────────────────────────────
{
  const { middleware, ctx, of, beginTurn } = drive();
  middleware.onStart(ctx);
  beginTurn(0);
  middleware.onChunk(ctx, { type: "TEXT_MESSAGE_START", messageId: "m1" });
  middleware.onChunk(ctx, { type: "TEXT_MESSAGE_CONTENT", delta: "partial" });

  assert.equal(of("turn:start").length, 1, "the start that happened is not retracted");
  assert.equal(of("turn:end").length, 0, "an aborted turn is not reported as completed");
  assert.equal(of("message:end").length, 0, "and its message is not finalized");
}

// ── 5. a suspended turn (approval) closes exactly once ─────────────────────
{
  const { middleware, ctx, of, beginTurn } = drive();
  middleware.onStart(ctx);
  beginTurn(0);
  middleware.onChunk(ctx, { type: "TOOL_CALL_START", toolCallId: "c1", toolName: "run_command" });
  // The engine pipes the model's own RUN_FINISHED, then a second interrupt-shaped one for the pause.
  middleware.onChunk(ctx, { type: "RUN_FINISHED", finishReason: "tool_calls" });
  middleware.onChunk(ctx, { type: "RUN_FINISHED", finishReason: "tool_calls" });

  assert.equal(of("turn:end").length, 1, "a turn paused for approval must not report two ends");
  assert.equal(of("message:end").length, 1);
}

// ── 6. a retained first output is not re-reported by a retried attempt ─────
{
  const { middleware, ctx, of, beginTurn } = drive("turn-1");
  middleware.onStart(ctx);
  beginTurn(0);
  middleware.onChunk(ctx, { type: "TEXT_MESSAGE_START", messageId: "m1" });
  middleware.onChunk(ctx, { type: "TEXT_MESSAGE_CONTENT", delta: "first" });
  middleware.onChunk(ctx, { type: "RUN_FINISHED", finishReason: "stop" });

  // A restart-style retry re-enters the engine: onStart plus iteration 0 again, same user turn.
  middleware.onStart(ctx);
  beginTurn(0);
  middleware.onChunk(ctx, { type: "TEXT_MESSAGE_START", messageId: "m2" });
  middleware.onChunk(ctx, { type: "RUN_FINISHED", finishReason: "stop" });

  assert.deepEqual(
    of("message:start").map((e) => e.payload.firstOutput),
    [true, false],
    "firstOutput belongs to the user turn, not to one chat() attempt"
  );
}

console.log("extension turn events validation passed");
