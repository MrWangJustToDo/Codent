/**
 * Validates the unified AgentEventBus: observer error isolation, wildcard
 * (interceptor-excluded) delivery, intercept ordering/mutation/cancel/await,
 * retained replay, and scope isolation + up-flow.
 *
 * Run: pnpm --filter @codent/core run validate:agent-event-bus
 */

import assert from "node:assert/strict";

import { AGENT_EVENT_META, createAgentEventBus } from "../dist/dev.mjs";

// ============================================================================
// 1. Observer: ordered, error-isolated
// ============================================================================
{
  const reported = [];
  const bus = createAgentEventBus("root", (info) => reported.push(info));
  const seen = [];
  bus.on("agent:state", () => {
    throw new Error("listener boom");
  });
  bus.on("agent:state", (event) => seen.push(event.payload.status));

  bus.emit("agent:state", { status: "idle", name: "n", error: "", pendingApprovalCount: 0 });
  assert.deepEqual(seen, ["idle"], "second observer still receives after first throws");
  // The throw is contained, not lost: a silently dropped frame was the hardest failure to debug.
  assert.equal(reported.length, 1, "the listener failure is reported");
  assert.equal(reported[0].kind, "observer", "and attributed to the observer dispatch mode");
}

// ============================================================================
// 2. Wildcard receives observers but not interceptors
// ============================================================================
{
  const bus = createAgentEventBus();
  let wildcard = 0;
  bus.on("*", () => wildcard++);

  await bus.intercept({ type: "session:start", payload: { cwd: "/tmp" } });
  assert.equal(wildcard, 0, "interceptor dispatch is excluded from wildcard");

  bus.emit("session:start", { cwd: "/tmp" });
  assert.equal(wildcard, 1, "wildcard receives observer events");
}

// ============================================================================
// 3. Interceptor: order + shared mutation + await + exact/prefix match
// ============================================================================
{
  const bus = createAgentEventBus();
  const order = [];

  bus.onIntercept("tool:before:*", async (event) => {
    await Promise.resolve();
    order.push("a");
    event.payload.args = { x: 2 };
  });
  bus.onIntercept("tool:before:*", (event) => {
    order.push(`b:${event.payload.args.x}`);
  });
  bus.onIntercept("tool:after:read_file", () => {
    order.push("should-not-fire");
  });

  await bus.intercept({ type: "tool:before:run_command", payload: { args: { x: 1 } }, defaultReturn: undefined });
  assert.deepEqual(order, ["a", "b:2"], "ordered, awaited, shared mutable event, exact pattern filtered");
}

// ============================================================================
// 4. Interceptor: cancel short-circuits and returns undefined
// ============================================================================
{
  const bus = createAgentEventBus();
  let secondRan = false;
  bus.onIntercept("tool:before:*", () => false);
  bus.onIntercept("tool:before:*", () => {
    secondRan = true;
  });

  const result = await bus.intercept({
    type: "tool:before:run_command",
    payload: { args: {} },
    defaultReturn: "default",
  });
  assert.equal(secondRan, false, "cancel stops the chain");
  assert.equal(result, undefined, "cancel returns undefined");
}

// ============================================================================
// 5. Retained replay for late subscribers
// ============================================================================
{
  const bus = createAgentEventBus();
  let value = { mode: "off", autoMode: false };
  bus.retain("session:mode", () => value);

  const seen = [];
  bus.on("session:mode", (event) => seen.push(event.payload.mode));
  assert.deepEqual(seen, ["off"], "late subscriber receives retained value immediately");

  value = { mode: "plan", autoMode: false };
  bus.emit("session:mode", value);
  assert.deepEqual(seen, ["off", "plan"], "retained value then updates");

  bus.retain("session:mode", () => ({ mode: "ready", autoMode: false }));
  const seen2 = [];
  bus.on("session:mode", (event) => seen2.push(event.payload.mode));
  assert.deepEqual(seen2, ["ready"], "re-retain replaces the provider");
}

// ============================================================================
// 6. Scope isolation + subagent up-flow
// ============================================================================
{
  const root = createAgentEventBus();
  const a = root.scope("agent-a");
  const b = root.scope("agent-b");
  const subA = a.scope("agent-a-sub");

  const rootIds = [];
  const aEvents = [];
  const bEvents = [];
  root.on("session:messages", (event) => rootIds.push(event.agentId));
  a.on("session:messages", (event) => aEvents.push(event));
  b.on("session:messages", (event) => bEvents.push(event));

  a.emit("session:messages", []);
  assert.equal(rootIds.length, 1, "root observes child scope");
  assert.equal(aEvents.length, 1, "own scope observes");
  assert.equal(bEvents.length, 0, "sibling scope isolated");
  assert.equal(aEvents[0].agentId, "agent-a", "agentId defaults to scope id");

  // Retained replay is agent-local by default: a child scope must not inherit the parent's
  // todos/queues first frame merely because it has no local provider.
  root.retain("session:todos", () => ({ items: [], title: "parent" }));
  const childTodos = [];
  subA.on("session:todos", (event) => childTodos.push(event.payload.title));
  assert.deepEqual(childTodos, [], "child on() does not replay a parent retained value");
  const parentTodos = [];
  subA.on("session:todos", (event) => parentTodos.push(event.payload.title), { includeParents: true });
  assert.deepEqual(parentTodos, ["parent"], "includeParents opts into the parent replay");

  subA.emit("session:messages", []);
  assert.equal(aEvents.length, 2, "descendant event up-flows to parent scope");
  assert.equal(rootIds.length, 2, "descendant event reaches root");
  assert.equal(bEvents.length, 0, "unrelated sibling stays isolated");
}

// ============================================================================
// 7. Metadata registry covers projection + interceptor patterns
// ============================================================================
{
  assert.equal(AGENT_EVENT_META["agent:state"].channel, "state");
  assert.equal(AGENT_EVENT_META["agent:state"].retained, true);
  assert.equal(AGENT_EVENT_META["session:messages"].channel, "messages");
  assert.equal(AGENT_EVENT_META["tool:chunk"].channel, "tool");
  assert.equal(AGENT_EVENT_META["agent:tool-approval-resolved"].channel, "lifecycle");
  assert.equal(AGENT_EVENT_META["subagent:progress-summary-error"].channel, "lifecycle");
  // The pre-fork queue rides the lifecycle channel with the rest of the subagent family, so a host
  // that already watches subagent rows gets the wait state on the same subscription.
  assert.equal(AGENT_EVENT_META["subagent:queue"].channel, "lifecycle");
}

// ============================================================================
// 8. A throwing reporter cannot escape dispatch, and async wildcards are contained
// ============================================================================
//
// `onInterceptorError` is host-wired (agent log → pluggable sink). A throw there used to escape
// `emit()` / `intercept()`, turning a contained subscriber failure into a failed tool call or a
// crashed frame; a wildcard listener typed `void` may also be async, and its rejection was
// unhandled (the same shape `Emitter` handles).
{
  const bus = createAgentEventBus("root", () => {
    throw new Error("reporter broke");
  });
  let frames = 0;
  bus.on("*", () => {
    throw new Error("listener broke");
  });
  bus.on("*", () => {
    frames += 1;
  });
  assert.doesNotThrow(() => bus.emit("agent:iteration", { current: 1, max: 1 }), "a throwing reporter is contained");
  assert.equal(frames, 1, "the remaining wildcard listener still receives the frame");

  let asyncFrames = 0;
  const asyncBus = createAgentEventBus("root", () => {});
  asyncBus.on("*", async () => {
    asyncFrames += 1;
    throw new Error("async boom");
  });
  asyncBus.emit("agent:iteration", { current: 1, max: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(asyncFrames, 1, "an async wildcard is contained instead of becoming an unhandled rejection");
}

console.log("agent-event-bus validation passed");
