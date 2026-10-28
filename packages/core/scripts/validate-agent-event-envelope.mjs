/**
 * Validates typed AgentEvent envelope (ts, sessionId, payload) and JSON round-trip.
 *
 * Run: pnpm --filter @codent/core run validate:agent-event-envelope
 */

import assert from "node:assert/strict";

import { createAgentEventBus, emitAgentTelemetry } from "../dist/dev.mjs";

const events = [];

const emitter = {
  id: "agent-1",
  getSessionData: () => ({ id: "session-abc" }),
  dispatchEvent: (event) => events.push(event),
};

emitAgentTelemetry(emitter, "prompt:submit", { prompt: "hello", contextMessageCount: 3 });

assert.equal(events.length, 1);
assert.equal(events[0].type, "prompt:submit");
assert.equal(events[0].agentId, "agent-1");
assert.equal(typeof events[0].ts, "number");
assert.equal(events[0].sessionId, "session-abc");
assert.equal(events[0].payload?.prompt, "hello");
assert.equal(events[0].data, undefined);

const roundTrip = JSON.parse(JSON.stringify(events[0]));
assert.equal(roundTrip.payload.prompt, "hello");
assert.equal(roundTrip.sessionId, "session-abc");

emitAgentTelemetry(emitter, "subagent:completed", { subagentId: "child-1", summary: "done" }, { parentId: "parent-1" });

assert.equal(events.length, 2);
assert.equal(events[1].parentId, "parent-1");
assert.equal(events[1].payload.summary, "done");

emitAgentTelemetry(emitter, "agent:thinking");
assert.equal(events.length, 3);
assert.equal(events[2].type, "agent:thinking");
assert.deepEqual(events[2].payload, {});

emitAgentTelemetry({ id: "no-dispatch" }, "agent:stop", { reason: "x" });
assert.equal(events.length, 3);

// --- a child scope's events carry the parent WITHOUT per-call meta ---
//
// The domain objects (`usage` / `todo` / `ui` / `stream-hub` / `plan`) emit straight on the bus, with
// no meta. Deriving the parent from the bus chain is what makes those events attributable: before,
// only `emitEvent` callers had a `parentId`, so a subagent's usage/todos/plan events looked like a
// root agent's.
{
  const bus = createAgentEventBus("root");
  const parentBus = bus.scope("agent-parent");
  const childBus = parentBus.scope("agent-child");

  const onChild = [];
  childBus.on("agent:stop", (event) => onChild.push(event));
  childBus.emit("agent:stop", { reason: "x" });
  assert.equal(onChild[0].agentId, "agent-child");
  assert.equal(onChild[0].parentId, "agent-parent", "a child scope derives parentId from the bus chain");

  const onParent = [];
  parentBus.on("agent:stop", (event) => onParent.push(event));
  parentBus.emit("agent:stop", { reason: "y" });
  assert.equal("parentId" in onParent[0], false, "an agent scoped on the root bus has no parent");

  const explicit = [];
  childBus.on("agent:stop", (event) => explicit.push(event));
  childBus.emit("agent:stop", { reason: "z" }, { parentId: "someone-else" });
  assert.equal(explicit[0].parentId, "someone-else", "explicit meta still wins");
}

// --- sessionId is the SESSION, never the agent id ---
{
  const noSession = [];
  emitAgentTelemetry(
    { id: "agent-child", getSessionData: () => null, dispatchEvent: (event) => noSession.push(event) },
    "agent:stop",
    { reason: "x" }
  );
  assert.equal(
    "sessionId" in noSession[0],
    false,
    "an unknown session is omitted — the agent id is a different identifier space"
  );

  const inherited = [];
  emitAgentTelemetry(
    {
      id: "agent-child",
      getSessionData: () => null,
      getEventSessionId: () => "ses_parent",
      dispatchEvent: (event) => inherited.push(event),
    },
    "agent:stop",
    { reason: "x" }
  );
  assert.equal(inherited[0].sessionId, "ses_parent", "a subagent's events carry the parent's session");

  // The bound emitter (what middleware and domains receive) carries the child's parent link.
  const { createEmitTelemetryFn } = await import("../dist/dev.mjs");
  const bound = [];
  const emit = createEmitTelemetryFn({
    id: "agent-child",
    parentId: "agent-parent",
    getSessionData: () => null,
    getEventSessionId: () => "ses_parent",
    dispatchEvent: (event) => bound.push(event),
  });
  emit("agent:stop", { reason: "x" });
  assert.equal(bound[0].parentId, "agent-parent", "the bound emitter carries the parent link");
}

console.log("agent-event-envelope validation passed");
