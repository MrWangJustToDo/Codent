/**
 * Validates the root bus + per-agent scope cache:
 * scope identity, subagent up-flow, scope deletion, interceptor-error routing, and the envelope
 * fields the bus resolves from the owning agent.
 *
 * Run: pnpm --filter @codent/core run validate:agent-event-bus-scope
 */

import assert from "node:assert/strict";

import { AgentEventBusScope } from "../dist/dev.mjs";

// A handler failure is reported as an EVENT on the root bus (it used to be a direct AgentLog write
// from the scope). `resolveLogOwner` names the agent whose log the bridge will use.
const scope = new AgentEventBusScope({
  resolveLogOwner: (scopeId) => (scopeId === "child" ? "child" : undefined),
  resolveMeta: (agentId) => (agentId === "child" ? { runId: "run-1", sessionId: "ses_1" } : undefined),
});

assert.equal(scope.of("a"), scope.of("a"), "scope identity is cached");
assert.notEqual(scope.of("a"), scope.of("b"));
scope.of("orphan");
assert.throws(() => scope.of("orphan", "a"), /different parent/, "a scope cannot be re-parented later");

const rootEvents = [];
scope.on("session:start", (event) => rootEvents.push(event.agentId));
const child = scope.of("child", "a");
child.emit("session:start", { cwd: "/tmp" });
assert.deepEqual(rootEvents, ["child"], "subagent events up-flow to the root with their own id");

// The bus stamps identity the emitter did not supply — the property that makes `plan` / `ui` /
// `stream-hub` (direct bus emitters) produce the same envelope as the telemetry funnel.
const stamped = [];
scope.on("*", (event) => {
  if (event.type === "session:start") stamped.push(event);
});
child.emit("session:start", { cwd: "/tmp" });
const last = stamped.at(-1);
assert.equal(last.runId, "run-1", "runId is resolved from the owning agent");
assert.equal(last.sessionId, "ses_1", "sessionId is resolved from the owning agent");
assert.equal(last.agentId, "child");

// A retained replay is a snapshot of the past and must not inherit the CURRENT run id.
child.retain("session:start", () => ({ cwd: "/old" }));
const replayed = [];
child.on("session:start", (event) => replayed.push(event));
assert.equal(replayed.length, 1, "retained value replays immediately");
assert.equal(replayed[0].runId, undefined, "a retained replay carries no run id");

scope.delete("child");
const fresh = scope.of("child", "a");
assert.notEqual(fresh, child, "delete drops the cached scope");

// A throwing interceptor is reported against the scope it was registered on, and the bus continues.
const failures = [];
scope.on("*", (event) => {
  if (event.type === "agent:event-handler-error") failures.push(event);
});
child.onIntercept("tool:before:*", () => {
  throw new Error("boom");
});
await child.intercept({ type: "tool:before:run_command", payload: {}, defaultReturn: undefined });
assert.equal(failures.length, 1, "interceptor failure is reported once");
assert.equal(failures[0].agentId, "child", "attributed to the agent that registered the interceptor");
assert.equal(failures[0].payload.kind, "interceptor");
assert.equal(failures[0].payload.pattern, "tool:before:*");
assert.equal(failures[0].payload.event, "tool:before:run_command");
assert.match(failures[0].payload.error, /boom/);

// Root-scoped failures with no owning log emit nothing (nothing could record them) and do not throw.
const before = failures.length;
await assert.doesNotReject(() =>
  scope.root.intercept({ type: "tool:before:run_command", payload: {}, defaultReturn: undefined })
);
assert.equal(failures.length, before, "an unattributable failure is not emitted");

console.log("agent-event-bus-scope validation passed");
