/**
 * Validates the live-agent registry + subagent tree queries:
 * duplicate ids, roots, link/unlink bookkeeping, and deepest-first active/all walks.
 *
 * Run: pnpm --filter @codent/core run validate:agent-registry
 */

import assert from "node:assert/strict";

import { AgentRegistry } from "../dist/dev.mjs";

function agent(id, { parentId, status = "idle" } = {}) {
  return {
    id,
    parentId,
    status,
    childIds: [],
    updatedAt: 0,
    getStatus() {
      return this.status;
    },
  };
}

const registry = new AgentRegistry();
const root = agent("root");
const childA = agent("child-a", { parentId: "root", status: "running" });
const childB = agent("child-b", { parentId: "root", status: "completed" });
const grandchild = agent("grandchild", { parentId: "child-a", status: "thinking" });

for (const a of [root, childA, childB, grandchild]) registry.register(a);
assert.equal(registry.get("root"), root);
assert.equal(registry.has("child-a"), true);
assert.deepEqual(
  registry.all().map((a) => a.id),
  ["root", "child-a", "child-b", "grandchild"]
);
assert.deepEqual(
  registry.roots().map((a) => a.id),
  ["root"]
);
assert.throws(() => registry.register(agent("root")), /already registered/);

registry.linkChild("root", "child-a");
registry.linkChild("root", "child-b");
registry.linkChild("child-a", "grandchild");
assert.deepEqual(
  registry.subagents("root").map((a) => a.id),
  ["child-a", "child-b"]
);
assert.ok(root.updatedAt > 0, "linkChild bumps the parent timestamp");

assert.deepEqual(
  registry.activeSubagents("root").map((a) => a.id),
  ["grandchild", "child-a"],
  "active descendants are deepest-first and exclude completed/idle agents"
);
assert.deepEqual(
  registry.allSubagents("root").map((a) => a.id),
  ["child-b", "grandchild", "child-a"],
  "all descendants are deepest-first, including completed agents"
);

registry.unlinkChild("root", "child-b");
assert.deepEqual(
  registry.subagents("root").map((a) => a.id),
  ["child-a"]
);
assert.deepEqual(
  registry.allSubagents("root").map((a) => a.id),
  ["grandchild", "child-a"]
);

registry.unlinkChild("missing", "child-a");
registry.linkChild("missing", "child-a");
assert.equal(registry.get("child-a"), childA, "missing parents are a no-op");

registry.delete("child-b");
assert.equal(registry.has("child-b"), false);
assert.deepEqual(
  registry.subagents("root").map((a) => a.id),
  ["child-a"]
);

console.log("agent-registry validation passed");
