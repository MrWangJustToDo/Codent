/**
 * Truncated / stalled model-response settlement.
 *
 * The measured incident: one response emitted 143 `TOOL_CALL_START` placeholders with zero argument
 * bytes and never reached `RUN_FINISHED`. The turn only ended when the user pressed Esc, and the
 * abort path settled every row as `Cancelled by user.` This suite covers the two halves that keep
 * that from recurring:
 *
 * - the stream observer records the missing terminal event / tool-call starts and bounds a response
 *   that stops advancing after a tool call started;
 * - the boundary predicate turns "returned without a terminal event + an incomplete call" into a
 *   stream failure, so the caller never needs Esc to finish the turn.
 *
 * The classification + split settlement live in `validate-incomplete-tool-calls.mjs`.
 *
 * Run: pnpm --filter @codent/core run validate:truncated-tool-call-settlement
 */

import assert from "node:assert/strict";

import {
  MODEL_STREAM_STALL_MESSAGE,
  TRUNCATED_MODEL_STREAM_MESSAGE,
  hasTruncatedToolCalls,
  isTruncatedModelStream,
  observeModelStream,
} from "../dist/dev.mjs";

async function* chunks(list) {
  for (const chunk of list) yield chunk;
}

async function collect(stream, observation, options) {
  const iterator = observeModelStream(stream, observation, options)[Symbol.asyncIterator]();
  while (!(await iterator.next()).done) {
    // drain
  }
}

// ---------------------------------------------------------------------------
// 1. A normal attempt records its terminal event and tool-call start.
// ---------------------------------------------------------------------------
{
  const observation = { sawTerminal: false, toolStarts: 0, openToolCalls: 0, stalled: false };
  await collect(
    chunks([
      { type: "RUN_STARTED" },
      { type: "TOOL_CALL_START", toolCallId: "call_1", toolCallName: "run_command" },
      { type: "TOOL_CALL_END", toolCallId: "call_1" },
      { type: "RUN_FINISHED", finishReason: "tool_calls" },
    ]),
    observation
  );
  assert.equal(observation.sawTerminal, true, "a completed attempt is recorded");
  assert.equal(observation.toolStarts, 1);
  assert.equal(observation.stalled, false);
}

// ---------------------------------------------------------------------------
// 2. A response that returns without RUN_FINISHED is observable, not inferred.
// ---------------------------------------------------------------------------
{
  const observation = { sawTerminal: false, toolStarts: 0, openToolCalls: 0, stalled: false };
  await collect(
    chunks([{ type: "RUN_STARTED" }, { type: "TOOL_CALL_START", toolCallId: "call_1", toolCallName: "todo" }]),
    observation
  );
  assert.equal(observation.sawTerminal, false, "an early generator end is not a finish");
  assert.equal(observation.toolStarts, 1);
}

// ---------------------------------------------------------------------------
// 3. The idle guard fires only after a tool-call start and only without chunks.
// ---------------------------------------------------------------------------
{
  async function* stalledAfterToolCall() {
    yield { type: "RUN_STARTED" };
    yield { type: "TOOL_CALL_START", toolCallId: "call_1", toolCallName: "todo" };
    // No further chunk: the provider stopped advancing without a terminal event.
    await new Promise(() => {});
  }
  const observation = { sawTerminal: false, toolStarts: 0, openToolCalls: 0, stalled: false };
  // The guard's timer is `unref`'d (it must never keep a host alive on its own), and the stalled
  // source holds no live handle either — keep the test process alive long enough for it to fire.
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    await assert.rejects(
      () => collect(stalledAfterToolCall(), observation, { stallTimeoutMs: 25 }),
      (error) => error instanceof Error && error.message === MODEL_STREAM_STALL_MESSAGE,
      "a silent tool-call stream is bounded instead of parking until Esc"
    );
  } finally {
    clearInterval(keepAlive);
  }
  assert.equal(observation.stalled, true);
  assert.equal(observation.sawTerminal, false);
}

// A tool call that already ENDED is not a stall: tool execution inside the same async iterable is
// legitimately silent (a `run_command` may take minutes), and the old "any start ever" arm killed it.
{
  async function* slowToolExecution() {
    yield { type: "TOOL_CALL_START", toolCallId: "call_1", toolCallName: "run_command" };
    yield { type: "TOOL_CALL_END", toolCallId: "call_1" };
    // Represents tool execution: no chunk, far longer than the budget.
    await new Promise((resolve) => setTimeout(resolve, 120));
    yield { type: "RUN_FINISHED", finishReason: "stop" };
  }
  const observation = { sawTerminal: false, toolStarts: 0, openToolCalls: 0, stalled: false };
  await collect(slowToolExecution(), observation, { stallTimeoutMs: 25 });
  assert.equal(observation.stalled, false, "tool execution after TOOL_CALL_END is not a model-stream stall");
  assert.equal(observation.openToolCalls, 0);
  assert.equal(observation.sawTerminal, true);
}

// A disabled guard must not interrupt a quiet stream.
{
  async function* quietButEnding() {
    yield { type: "TOOL_CALL_START", toolCallId: "call_1", toolCallName: "todo" };
  }
  const observation = { sawTerminal: false, toolStarts: 0, openToolCalls: 0, stalled: false };
  await collect(quietButEnding(), observation, { stallTimeoutMs: 0 });
  assert.equal(observation.stalled, false, "0 disables the stall guard");
  assert.equal(observation.toolStarts, 1);
}

// A restart-style retry (429 / gateway / capability / reactive compact) re-enters chat() and emits
// RUN_STARTED again. A call the dead attempt announced never receives its arguments; keeping it
// open would arm the guard through the retry's tool execution — where a long run_command/task is
// legitimately silent — and kill it. RUN_STARTED resets the attempt-scoped facts.
{
  async function* retriedAttempt() {
    yield { type: "RUN_STARTED" };
    yield { type: "TOOL_CALL_START", toolCallId: "call_dead", toolCallName: "run_command" };
    // The attempt failed before TOOL_CALL_END; recovery restarts from a fresh engine.
    yield { type: "RUN_STARTED" };
    yield { type: "TOOL_CALL_START", toolCallId: "call_live", toolCallName: "run_command" };
    yield { type: "TOOL_CALL_END", toolCallId: "call_live" };
    // Tool execution: legitimately silent, far longer than the idle budget.
    await new Promise((resolve) => setTimeout(resolve, 120));
    yield { type: "RUN_FINISHED", finishReason: "stop" };
  }
  const observation = { sawTerminal: false, toolStarts: 0, openToolCalls: 0, stalled: false };
  await collect(retriedAttempt(), observation, { stallTimeoutMs: 25 });
  assert.equal(observation.stalled, false, "a retried attempt's tool execution is not a model-stream stall");
  assert.equal(observation.openToolCalls, 0, "the dead attempt's open call does not leak into the retry");
  assert.equal(observation.sawTerminal, true, "the retry's own terminal event is the one recorded");
  assert.equal(observation.toolStarts, 2);
}

// ---------------------------------------------------------------------------
// 4. Boundary predicate: only a terminal-less attempt with a truncated call fails.
// ---------------------------------------------------------------------------
{
  const truncatedMessages = [
    {
      id: "a1",
      role: "assistant",
      parts: [{ type: "tool-call", id: "call_1", name: "todo", arguments: "", state: "awaiting-input" }],
    },
  ];
  const base = {
    sawTerminal: false,
    toolStarts: 1,
    hasTruncatedToolCalls: hasTruncatedToolCalls(truncatedMessages),
    hasPendingInteraction: false,
  };
  assert.equal(isTruncatedModelStream(base), true, "returned without a terminal event + truncation fails");
  assert.equal(isTruncatedModelStream({ ...base, sawTerminal: true }), false, "a finished response is unaffected");
  assert.equal(isTruncatedModelStream({ ...base, toolStarts: 0 }), false, "no tool-call start means no boundary");
  assert.equal(
    isTruncatedModelStream({ ...base, hasPendingInteraction: true }),
    false,
    "a parked question/approval is not a stream failure"
  );
  assert.equal(isTruncatedModelStream({ ...base, hasTruncatedToolCalls: false }), false);
  assert.match(TRUNCATED_MODEL_STREAM_MESSAGE, /tool calls were complete/);
}

// ---------------------------------------------------------------------------
// 5. Integration: the span turns a returned truncated attempt into a failure.
// ---------------------------------------------------------------------------
{
  const { AgentUIChannel, runManagedSpan, TRUNCATED_MODEL_STREAM_MESSAGE: MESSAGE } = await import("../dist/dev.mjs");
  const channel = new AgentUIChannel();
  const managed = {
    getUI: () => channel,
    setUIChannel: () => {},
    getStatus: () => "running",
    getAbortSignal: () => undefined,
    isAbortError: () => false,
    config: {},
    tools: {},
  };
  const manager = {
    getAgent: () => managed,
    runAgentStream: async function* () {
      yield { type: "RUN_STARTED" };
      yield { type: "TOOL_CALL_START", toolCallId: "call_1", toolCallName: "todo" };
      // No TOOL_CALL_END and no RUN_FINISHED: the response ended inside the tool-call stream.
    },
  };

  const result = await runManagedSpan({
    manager,
    agentId: "agent-1",
    messages: [],
    channel,
    flagEmptyStream: false,
    stallTimeoutMs: 0,
  });
  assert.equal(result.errorMessage, MESSAGE, "the attempt is finalized as a stream failure");
  assert.equal(result.truncated, true, "and marked for truncated settlement");
  const part = channel
    .getMessages()
    .flatMap((message) => message.parts)
    .find((entry) => entry.type === "tool-call");
  assert.ok(part, "the UI channel still carries the announced call");
  assert.equal(part.name, "todo");
  assert.equal(part.arguments, "");
}

// ---------------------------------------------------------------------------
// 6. A stream that stops advancing is bounded, and closing it must not turn the
//    turn into a user cancel.
// ---------------------------------------------------------------------------
{
  const { AgentUIChannel, runManagedSpan } = await import("../dist/dev.mjs");
  const channel = new AgentUIChannel();
  const aborts = [];
  const run = {
    cancelled: 0,
    cancelAbortController() {
      this.cancelled += 1;
    },
    currentAbortController: { abort: (reason) => aborts.push(reason) },
  };
  const managed = {
    getUI: () => channel,
    setUIChannel: () => {},
    getStatus: () => "running",
    getAbortSignal: () => undefined,
    isAbortError: () => false,
    getToolInputSchema: () => undefined,
    config: {},
    tools: {},
    run,
  };
  const manager = {
    getAgent: () => managed,
    runAgentStream: async function* () {
      yield { type: "RUN_STARTED" };
      yield { type: "TOOL_CALL_START", toolCallId: "call_1", toolCallName: "todo" };
      // No TOOL_CALL_END and no terminal event: the provider stopped advancing.
      await new Promise(() => {});
    },
  };

  // The idle guard's timer is `unref`'d and the stalled source holds no live handle either, so keep
  // the test process alive long enough for it to fire.
  const keepAlive = setInterval(() => {}, 1_000);
  let result;
  try {
    result = await runManagedSpan({
      manager,
      agentId: "agent-stall",
      messages: [],
      channel,
      flagEmptyStream: false,
      stallTimeoutMs: 25,
    });
  } finally {
    clearInterval(keepAlive);
  }

  assert.equal(result.stalled, true, "the idle guard's stall reaches the caller");
  assert.equal(result.truncated, true, "the announced call is left truncated for settlement");
  assert.equal(result.errorMessage, MODEL_STREAM_STALL_MESSAGE, "the failure names the stall");
  assert.equal(run.cancelled, 1, "the abort listener is detached before the transport is closed");
  assert.equal(aborts.length, 1, "the stalled read is closed");
  assert.equal(
    aborts[0]?.message,
    MODEL_STREAM_STALL_MESSAGE,
    "the abort carries the stall, not an abort verdict that would read as a user cancel"
  );
}

console.log("truncated-tool-call-settlement validation passed");
