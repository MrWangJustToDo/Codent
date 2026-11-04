/**
 * Validates emitAgentTelemetry sessionId injection and dispatch wiring.
 *
 * Run: pnpm --filter @codent/core run validate:emit-agent-event
 */

import assert from "node:assert/strict";

import {
  createEmitTelemetryFn,
  emitAgentTelemetry,
  getDroppedTelemetryEventCount,
  resetDroppedTelemetryEventCount,
} from "../dist/dev.mjs";

const events = [];

const emitter = {
  id: "agent-1",
  getSessionData: () => ({ id: "session-abc" }),
  dispatchEvent: (event) => events.push(event),
};

emitAgentTelemetry(emitter, "prompt:submit", { prompt: "hello" });

assert.equal(events.length, 1);
assert.equal(events[0].type, "prompt:submit");
assert.equal(events[0].agentId, "agent-1");
assert.equal(events[0].sessionId, "session-abc");
assert.equal(events[0].payload?.prompt, "hello");

emitAgentTelemetry(
  emitter,
  "subagent:started",
  { subagentId: "child", description: "explore" },
  { parentId: "parent-1", sessionId: "override-session" }
);

assert.equal(events.length, 2);
assert.equal(events[1].parentId, "parent-1");
assert.equal(events[1].sessionId, "override-session");
assert.equal(events[1].payload?.description, "explore");

// The BOUND emitter (`deps.emitEvent` in services/middleware) must forward a caller's envelope,
// because the async producers (title / save-error / side query) resolve after the agent may have
// adopted another session. Before this the bound form dropped `args[1]`, so the only way to state
// the originating session was `ManagedAgent.emitEvent`, which services do not hold.
const bound = createEmitTelemetryFn({
  id: "agent-2",
  parentId: "parent-2",
  getSessionData: () => ({ id: "live-session" }),
  dispatchEvent: (event) => events.push(event),
});
bound("prompt:submit", { prompt: "from a service" }, { sessionId: "leaving-session" });
assert.equal(events.at(-1).sessionId, "leaving-session", "an explicit session override wins over the live one");
assert.equal(events.at(-1).parentId, "parent-2", "the emitter's parent link still travels with the frame");

// A pre-wiring emit is counted, not silently swallowed (the old `return` made a lost event
// indistinguishable from one that was never emitted).
resetDroppedTelemetryEventCount();
assert.equal(getDroppedTelemetryEventCount(), 0, "the counter starts clean");
const delivered = events.length;
emitAgentTelemetry({ id: "no-dispatch" }, "agent:stop");
assert.equal(events.length, delivered, "an emitter with no dispatch adds no frame");
assert.equal(getDroppedTelemetryEventCount(), 1, "an emit with no dispatch is counted");
emitAgentTelemetry(emitter, "agent:stop");
assert.equal(getDroppedTelemetryEventCount(), 1, "a delivered emit does not count");

console.log("emitAgentTelemetry validation passed");
