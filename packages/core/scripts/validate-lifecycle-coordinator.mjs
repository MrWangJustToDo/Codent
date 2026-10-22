/**
 * Validates the destroy/teardown cascade:
 * recursive child destruction, ownership + bus-scope cleanup, the subagent:destroyed event, and
 * the ordered extension → background-work → log-flush chain that settleTeardowns drains.
 *
 * Run: pnpm --filter @codent/core run validate:lifecycle-coordinator
 */

import assert from "node:assert/strict";

import { AgentRegistry, LifecycleCoordinator, SessionOwnership } from "../dist/dev.mjs";

const events = [];
const scopes = [];

function fakeAgent(id, parentId) {
  return {
    id,
    parentId,
    parentTaskId: parentId ? "task-parent" : undefined,
    childIds: [],
    updatedAt: 0,
    getMcpManager: () => ({ forceKill: () => events.push(`mcp:${id}`) }),
    abort: (reason) => events.push(`abort:${id}:${reason}`),
    getExtensionRunner: () => ({
      emitSessionShutdown: async (agentId) => events.push(`shutdown:${agentId}`),
      destroyAll: async () => events.push(`destroyAll:${id}`),
    }),
    destroyCommandService: async () => events.push(`jobs:${id}`),
    flushLogOnDestroy: () => events.push(`flush:${id}`),
    emitEvent: (type, data) => events.push(`event:${id}:${type}:${data.subagentId}`),
  };
}

const registry = new AgentRegistry();
const ownership = new SessionOwnership();
const lifecycle = new LifecycleCoordinator({
  registry,
  ownership,
  clearAgentScope: (id) => scopes.push(id),
});

const root = fakeAgent("root");
const child = fakeAgent("child", "root");
const grandchild = fakeAgent("grandchild", "child");
for (const a of [root, child, grandchild]) registry.register(a);
registry.linkChild("root", "child");
registry.linkChild("child", "grandchild");
ownership.acquire("ses-root", "root");
ownership.acquire("ses-child", "child");
ownership.acquire("ses-unrelated", "other");

lifecycle.destroy("root");
assert.equal(registry.has("root"), false, "root removed");
assert.equal(registry.has("child"), false, "child destroyed recursively");
assert.equal(registry.has("grandchild"), false, "grandchild destroyed recursively");
assert.equal(ownership.ownerOf("ses-root"), undefined, "root claim released");
assert.equal(ownership.ownerOf("ses-child"), undefined, "child claim released");
assert.equal(ownership.ownerOf("ses-unrelated"), "other", "other agents' claims untouched");
assert.deepEqual(scopes, ["root", "child", "grandchild"], "every agent scope is dropped");

for (const id of ["root", "child", "grandchild"]) {
  assert.ok(events.includes(`mcp:${id}`), `${id} MCP killed`);
  assert.ok(events.includes(`abort:${id}:Agent destroyed`), `${id} aborted`);
}
assert.ok(events.includes("event:child:subagent:destroyed:child"), "child destruction is reported");
assert.ok(events.includes("event:grandchild:subagent:destroyed:grandchild"), "grandchild destruction is reported");
assert.ok(!events.includes("event:root:subagent:destroyed:root"), "root has no parent event");

await lifecycle.settleTeardowns();
for (const id of ["root", "child", "grandchild"]) {
  const shutdown = events.indexOf(`shutdown:${id}`);
  const destroyAll = events.indexOf(`destroyAll:${id}`);
  const jobs = events.indexOf(`jobs:${id}`);
  const flush = events.indexOf(`flush:${id}`);
  assert.ok(shutdown >= 0 && destroyAll > shutdown && jobs > destroyAll && flush > jobs, `${id} teardown order`);
}

// A missing id is a no-op, and settle still resolves.
lifecycle.destroy("missing");
await lifecycle.settleTeardowns();

// A rejecting background-work step must not skip the log flush or become an unhandled rejection.
{
  const events2 = [];
  const failing = {
    id: "failing",
    parentId: undefined,
    childIds: [],
    updatedAt: 0,
    getMcpManager: () => null,
    abort: () => {},
    getExtensionRunner: () => null,
    destroyCommandService: async () => {
      throw new Error("job teardown failed");
    },
    flushLogOnDestroy: () => events2.push("flush"),
    emitEvent: () => {},
  };
  const registry2 = new AgentRegistry();
  registry2.register(failing);
  const lifecycle2 = new LifecycleCoordinator({
    registry: registry2,
    ownership: new SessionOwnership(),
    clearAgentScope: () => {},
  });
  lifecycle2.destroy("failing");
  await lifecycle2.settleTeardowns();
  assert.deepEqual(events2, ["flush"], "a failed background teardown still flushes the log");
}

console.log("lifecycle-coordinator validation passed");
