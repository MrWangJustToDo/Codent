/**
 * Validates emitAgentTelemetry sessionId injection and dispatch wiring.
 *
 * Run: pnpm --filter @codent/core run validate:emit-agent-event
 */

import assert from "node:assert/strict";

import { emitAgentTelemetry, getDroppedTelemetryEventCount, resetDroppedTelemetryEventCount } from "../dist/dev.mjs";

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

// A pre-wiring emit is counted, not silently swallowed (the old `return` made a lost event
// indistinguishable from one that was never emitted).
resetDroppedTelemetryEventCount();
assert.equal(getDroppedTelemetryEventCount(), 0, "the counter starts clean");
emitAgentTelemetry({ id: "no-dispatch" }, "agent:stop");
assert.equal(events.length, 2);
assert.equal(getDroppedTelemetryEventCount(), 1, "an emit with no dispatch is counted");
emitAgentTelemetry(emitter, "agent:stop");
assert.equal(getDroppedTelemetryEventCount(), 1, "a delivered emit does not count");

console.log("emitAgentTelemetry validation passed");
