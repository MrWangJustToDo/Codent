/**
 * Validates the live-agent registry + subagent tree queries:
 * duplicate ids, roots, link/unlink bookkeeping, and deepest-first active/all walks.
 *
 * Run: pnpm --filter @codent/core run validate:agent-registry
 */

import assert from "node:assert/strict";

import { AgentRegistry } from "../dist/dev.mjs";

function agent(id, { parentId, status = "idle", sessionScopeId } = {}) {
  return {
    id,
    parentId,
    status,
    childIds: [],
    updatedAt: 0,
    getStatus() {
      return this.status;
    },
    getSessionScopeId() {
      return sessionScopeId;
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

// Session-scoped walks: task children use `autoDestroy: false`, so a completed child from the
// conversation being left remains registered after `session.new` / `session.resume`. The optional
// session id must exclude it from the active conversation's task/command surfaces.
{
  const scoped = new AgentRegistry();
  const scopedRoot = agent("scoped-root");
  const current = agent("child-current", { parentId: "scoped-root", sessionScopeId: "ses_new" });
  const old = agent("child-old", { parentId: "scoped-root", sessionScopeId: "ses_old" });
  const oldGrandchild = agent("grand-old", { parentId: "child-old", sessionScopeId: "ses_old" });
  const legacy = agent("child-legacy", { parentId: "scoped-root" });
  for (const a of [scopedRoot, current, old, oldGrandchild, legacy]) scoped.register(a);
  scoped.linkChild("scoped-root", "child-current");
  scoped.linkChild("scoped-root", "child-old");
  scoped.linkChild("child-old", "grand-old");
  scoped.linkChild("scoped-root", "child-legacy");

  assert.deepEqual(
    scoped.allSubagents("scoped-root", "ses_new").map((a) => a.id),
    ["child-legacy", "child-current"],
    "the active session keeps its own and legacy children, but not the old subtree"
  );
  assert.deepEqual(
    scoped.allSubagents("scoped-root", "ses_old").map((a) => a.id),
    ["child-legacy", "grand-old", "child-old"],
    "filtering by the old session still finds the old subtree (legacy children stay visible)"
  );
  assert.deepEqual(
    scoped.allSubagents("scoped-root").map((a) => a.id),
    ["child-legacy", "grand-old", "child-old", "child-current"],
    "omitting the session id keeps the full cross-session walk"
  );
}

console.log("agent-registry validation passed");
