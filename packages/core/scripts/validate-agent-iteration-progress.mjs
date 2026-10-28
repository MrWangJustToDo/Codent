/**
 * Validates the agent-loop iteration ("turn") progress event:
 * the lifecycle middleware maps TanStack's 0-based `IterationInfo.iteration` to
 * 1-based {@link AgentIterationState} and reports the run's iteration budget;
 * plus the retained `iteration` channel / meta wiring.
 *
 * Run: pnpm --filter @codent/core run validate:agent-iteration-progress
 */

import assert from "node:assert/strict";

import {
  AGENT_EVENT_META,
  AgentConfigSchema,
  AgentLog,
  DEFAULT_AGENT_MAX_ITERATIONS,
  DEFAULT_AGENT_SESSION_CHANNELS,
  MAX_AGENT_ITERATIONS,
  ManagedAgent,
  createAgentEventBus,
  createLifecycleMiddleware,
} from "../dist/dev.mjs";

// --- ONE iteration default and ONE ceiling ----------------------------------
//
// The budget used to be restated in four places (core schema 10, session host 100, CLI 50, app 50).
// The schema default IS the product default now; hosts omit the option when the user set nothing,
// and every validator/CLI/help string reads these constants instead of a literal.
assert.equal(
  AgentConfigSchema.parse({ model: "m" }).maxIterations,
  DEFAULT_AGENT_MAX_ITERATIONS,
  "the schema default is the single agent-loop default"
);
assert.ok(
  Number.isInteger(MAX_AGENT_ITERATIONS) && MAX_AGENT_ITERATIONS >= DEFAULT_AGENT_MAX_ITERATIONS,
  "the ceiling is a real upper bound"
);
assert.equal(
  AgentConfigSchema.parse({ model: "m", maxIterations: MAX_AGENT_ITERATIONS }).maxIterations,
  MAX_AGENT_ITERATIONS,
  "the ceiling itself is accepted"
);
assert.throws(
  () => AgentConfigSchema.parse({ model: "m", maxIterations: MAX_AGENT_ITERATIONS + 1 }),
  /Too big/i,
  "one above the ceiling is rejected, not clamped"
);

// --- channel / meta wiring ---------------------------------------------------

assert.equal(AGENT_EVENT_META["agent:iteration"]?.channel, "iteration");
assert.equal(AGENT_EVENT_META["agent:iteration"]?.retained, true);
assert.equal(DEFAULT_AGENT_SESSION_CHANNELS.includes("iteration"), true);

// --- middleware maps IterationInfo → 1-based progress ------------------------

{
  const seen = [];
  const mw = createLifecycleMiddleware({
    usage: {},
    getPricing: () => null,
    maxIterations: 7,
    onIteration: (state) => seen.push(state),
  });

  // 0-based on the wire (first iteration), then an arbitrary later one.
  await mw.onIteration?.({}, { iteration: 0, messageId: "m1" });
  await mw.onIteration?.({}, { iteration: 2, messageId: "m2" });

  assert.deepEqual(seen, [
    { current: 1, max: 7 },
    { current: 3, max: 7 },
  ]);
}

// No maxIterations configured → max falls back to 0 (unknown), current still 1-based.
{
  const seen = [];
  const mw = createLifecycleMiddleware({
    usage: {},
    getPricing: () => null,
    onIteration: (state) => seen.push(state),
  });
  await mw.onIteration?.({}, { iteration: 4, messageId: "m" });
  assert.deepEqual(seen, [{ current: 5, max: 0 }]);
}

// Missing onIteration hook → no throw.
{
  const mw = createLifecycleMiddleware({ usage: {}, getPricing: () => null, maxIterations: 3 });
  await mw.onIteration?.({}, { iteration: 0, messageId: "m" });
}

// --- `llm:request` / `llm:response` / `turn:start` report the RUN-scoped turn ----
//
// The engine's own counter (`IterationInfo.iteration`) is per chat, and a chat pump starts one chat
// per tool phase, so `ctx.iteration` is 0 at `onStart` for every request of a pump-driven turn: one
// 47-request turn logged `iter 0` forty-seven times while its responses logged a counter, i.e. the
// same model call reported two different turns. The index now comes from `onIteration` (once per
// model call) per run token.
{
  const events = [];
  const mw = createLifecycleMiddleware({
    usage: {},
    getPricing: () => null,
    maxIterations: 7,
    getRunToken: () => "run-1",
    emitEvent: (type, data) => events.push({ type, data }),
  });

  // Chat 1 (one model turn, as a chat pump does per tool phase): the request announces turn 1
  // before `onIteration` confirms it.
  await mw.onStart?.({ model: "m", messages: [], iteration: 0 });
  await mw.onIteration?.({}, { iteration: 0, messageId: "m1" });
  await mw.onFinish?.(undefined, { finishReason: "stop" });
  const first = events.filter((e) => e.type === "llm:request" || e.type === "llm:response");
  assert.deepEqual(
    first.map((e) => [e.type, e.data.iteration]),
    [
      ["llm:request", 1],
      ["llm:response", 1],
    ],
    "one model call reports the SAME turn in request and response"
  );
  assert.equal(events.find((e) => e.type === "turn:start").data.index, 1, "turn:start carries the run-scoped index");

  // Chat 2 — the next tool-phase pump continues the run.
  events.length = 0;
  await mw.onStart?.({ model: "m", messages: [], iteration: 0 });
  await mw.onIteration?.({}, { iteration: 0, messageId: "m2" });
  await mw.onFinish?.(undefined, { finishReason: "stop" });
  assert.equal(events.find((e) => e.type === "llm:request").data.iteration, 2, "the second chat is turn 2");
  assert.equal(events.find((e) => e.type === "llm:response").data.iteration, 2);

  // A worker keeps ONE chat for many iterations: the request announces the first, the response the
  // last, and `turn:start` counts each — while `agent:iteration` progress keeps the engine's own
  // 1-based-within-budget value (a run-scoped index there would read `60/50`).
  events.length = 0;
  const progress = [];
  const worker = createLifecycleMiddleware({
    usage: {},
    getPricing: () => null,
    maxIterations: 7,
    getRunToken: () => "run-w",
    emitEvent: (type, data) => events.push({ type, data }),
    onIteration: (state) => progress.push(state),
  });
  await worker.onStart?.({ model: "m", messages: [], iteration: 0 });
  await worker.onIteration?.({}, { iteration: 0, messageId: "w1" });
  await worker.onIteration?.({}, { iteration: 1, messageId: "w2" });
  await worker.onFinish?.(undefined, { finishReason: "stop" });
  assert.equal(events.find((e) => e.type === "llm:request").data.iteration, 1, "the chat starts at turn 1");
  assert.equal(events.find((e) => e.type === "llm:response").data.iteration, 2, "…and covers turns 1-2");
  assert.deepEqual(
    events.filter((e) => e.type === "turn:start").map((e) => e.data.index),
    [1, 2],
    "each model turn inside the chat is numbered"
  );
  assert.deepEqual(
    progress,
    [
      { current: 1, max: 7 },
      { current: 2, max: 7 },
    ],
    "progress stays engine-scoped"
  );

  // A chat that ends BEFORE its first iteration still reports ITS OWN turn: early termination, a
  // pending tool phase and the upstream error path all reach `onFinish` without an iteration, and
  // reporting the previous turn's index there re-introduced "one model call, two numbers".
  events.length = 0;
  const early = createLifecycleMiddleware({
    usage: {},
    getPricing: () => null,
    maxIterations: 7,
    getRunToken: () => "run-e",
    emitEvent: (type, data) => events.push({ type, data }),
  });
  await early.onStart?.({ model: "m", messages: [], iteration: 0 });
  await early.onIteration?.({}, { iteration: 0, messageId: "e1" });
  await early.onFinish?.(undefined, { finishReason: "stop" });
  await early.onStart?.({ model: "m", messages: [], iteration: 0 });
  await early.onFinish?.(undefined, { finishReason: "error" });
  assert.deepEqual(
    events.filter((e) => e.type === "llm:request").map((e) => e.data.iteration),
    [1, 2],
    "each chat announces its own turn"
  );
  assert.deepEqual(
    events.filter((e) => e.type === "llm:response").map((e) => e.data.iteration),
    [1, 2],
    "…and a chat that never iterated reports the turn it announced, not the previous one"
  );

  // A new run token restarts the numbering on the SAME middleware (a wake turn, or the next user
  // turn in the same process).
  events.length = 0;
  let token = "run-1";
  const resettable = createLifecycleMiddleware({
    usage: {},
    getPricing: () => null,
    maxIterations: 7,
    getRunToken: () => token,
    emitEvent: (type, data) => events.push({ type, data }),
  });
  await resettable.onIteration?.({}, { iteration: 0, messageId: "r1a" });
  await resettable.onIteration?.({}, { iteration: 0, messageId: "r1b" });
  token = "run-2";
  await resettable.onStart?.({ model: "m", messages: [], iteration: 0 });
  await resettable.onIteration?.({}, { iteration: 0, messageId: "r2" });
  assert.equal(
    events.find((e) => e.type === "llm:request").data.iteration,
    1,
    "a new run token restarts the turn numbering"
  );
}

// --- `turn:end` closes only a turn that was OPENED --------------------------
//
// A chat can end before its first model call (early termination, a pending tool phase, a failed
// start). It never emitted `turn:start`, so closing it reported the PREVIOUS turn's index (0 for the
// first chat) with no matching open.
{
  const events = [];
  const mw = createLifecycleMiddleware({
    usage: {},
    getPricing: () => null,
    maxIterations: 7,
    getRunToken: () => "run-early",
    emitEvent: (type, data) => events.push({ type, data }),
  });

  await mw.onStart?.({ model: "m", messages: [] });
  await mw.onChunk?.({}, { type: "RUN_FINISHED", finishReason: "stop" });
  assert.equal(
    events.some((e) => e.type === "turn:end"),
    false,
    "a chat that never iterated closes no turn"
  );

  // A normal chat still opens and closes exactly once, with the same index.
  await mw.onStart?.({ model: "m", messages: [] });
  await mw.onIteration?.({}, { iteration: 0, messageId: "m" });
  await mw.onChunk?.({}, { type: "RUN_FINISHED", finishReason: "stop" });
  assert.deepEqual(
    events.filter((e) => e.type === "turn:start" || e.type === "turn:end").map((e) => [e.type, e.data.index]),
    [
      ["turn:start", 1],
      ["turn:end", 1],
    ],
    "one open, one close, same index"
  );
}

// --- a terminal run clears the retained iteration progress ------------------
{
  const managed = new ManagedAgent(
    { name: "iteration", model: "test-model", maxIterations: 7 },
    { log: new AgentLog(), tools: {}, todoManager: null }
  );
  const bus = createAgentEventBus("iteration-progress");
  managed.setEventBus(bus);
  const seen = [];
  bus.on("agent:iteration", (event) => seen.push(event.payload), { replay: false });

  managed.setIterationProgress({ current: 3, max: 7 });
  managed.finalizeRun("aborted");
  assert.deepEqual(managed.readIteration(), { current: 0, max: 7 }, "a terminal run resets iteration to idle");
  assert.deepEqual(seen.at(-1), { current: 0, max: 7 }, "the retained channel is republished with idle progress");
  // The turn's own reading survives the reset on the snapshot: a turn can end exactly at its
  // budget, and the stop reason is classified AFTER finalize (ACP `max_turn_requests`).
  assert.deepEqual(
    managed.getL1State().lastIteration,
    { current: 3, max: 7 },
    "the finalized turn's iteration is kept for stop-reason classification"
  );
  managed.resetRunOutcome();
  assert.equal(managed.getL1State().lastIteration, null, "a session reset clears it with the rest of the run outcome");
}

console.log("agent-iteration-progress validation passed");
