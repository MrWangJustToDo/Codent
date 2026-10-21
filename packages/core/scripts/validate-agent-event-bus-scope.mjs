/**
 * Validates the root bus + per-agent scope cache:
 * scope identity, subagent up-flow, scope deletion, and interceptor-error routing to the
 * registering scope's log.
 *
 * Run: pnpm --filter @codent/core run validate:agent-event-bus-scope
 */

import assert from "node:assert/strict";

import { AgentEventBusScope } from "../dist/dev.mjs";

const warnings = [];
const resolveLog = (scopeId) =>
  scopeId === "child"
    ? { warn: (category, message, data) => warnings.push({ scopeId, category, message, data }) }
    : undefined;

const scope = new AgentEventBusScope({ resolveLog });
assert.equal(scope.of("a"), scope.of("a"), "scope identity is cached");
assert.notEqual(scope.of("a"), scope.of("b"));
const orphan = scope.of("orphan");
assert.throws(() => scope.of("orphan", "a"), /different parent/, "a scope cannot be re-parented later");

const rootEvents = [];
scope.on("session:start", (event) => rootEvents.push(event.agentId));
const child = scope.of("child", "a");
child.emit("session:start", { cwd: "/tmp" });
assert.deepEqual(rootEvents, ["child"], "subagent events up-flow to the root with their own id");

scope.delete("child");
const fresh = scope.of("child", "a");
assert.notEqual(fresh, child, "delete drops the cached scope");

// A throwing interceptor logs against the scope it was registered on; the bus continues.
warnings.length = 0;
child.onIntercept("tool:before:*", () => {
  throw new Error("boom");
});
await child.intercept({ type: "tool:before:run_command", payload: {}, defaultReturn: undefined });
assert.equal(warnings.length, 1, "interceptor failure is reported");
assert.equal(warnings[0].scopeId, "child");
assert.equal(warnings[0].category, "hooks");
assert.match(warnings[0].data.error, /boom/);

// Root-scoped failures fall back to the resolver's root policy (here: no log, no throw).
await assert.doesNotReject(() =>
  scope.root.intercept({ type: "tool:before:run_command", payload: {}, defaultReturn: undefined })
);

console.log("agent-event-bus-scope validation passed");
