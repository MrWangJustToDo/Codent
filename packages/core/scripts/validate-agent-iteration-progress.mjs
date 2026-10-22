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
  AgentLog,
  DEFAULT_AGENT_SESSION_CHANNELS,
  ManagedAgent,
  createAgentEventBus,
  createLifecycleMiddleware,
} from "../dist/dev.mjs";

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
}

console.log("agent-iteration-progress validation passed");
