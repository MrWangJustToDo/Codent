/**
 * A remote host must fold, label and keep rows exactly like the process that owns the tools.
 *
 * The owner publishes its catalog on the session snapshot (`toolDescriptors`); the client keeps
 * it on its own instance, so the host's `keepsCompactRow` / descriptors answer without a local
 * tool registry and without process-global hydration. This covers the constructor path (an
 * initial snapshot); `doResync` and the `session:tool-presentation` event update the same map.
 *
 * Run via `pnpm --filter @codent/server validate:remote-tool-catalog`.
 */

import assert from "node:assert/strict";

const { RemoteSessionClient } = await import("../dist/remote-session-client.mjs");
const core = await import("@codent/core");

const ownerCatalog = [
  { name: "owner_only_tool", category: "read", keepRow: true, hasText: true },
  { name: "owner_command", category: "command", detailed: true, hasText: true },
  // The hard case: nothing but a renderer keeps this row alive (`keepRow || clientSide || text`).
  { name: "owner_text_only", category: "other", hasText: true },
];

assert.equal(core.keepsCompactRow("owner_only_tool"), false, "unknown before any snapshot arrives");

const client = new RemoteSessionClient({
  agentId: "catalog-check",
  baseUrl: "http://127.0.0.1:1",
  fetchImpl: async () => {
    throw new Error("no network in this check");
  },
  initialSnapshot: {
    agentId: "catalog-check",
    messages: [],
    toolDescriptors: ownerCatalog,
  },
});
const resolve = (name) => client.getToolPresentation(name) ?? core.getBuiltinToolPresentation(name);

assert.equal(core.keepsCompactRow("owner_only_tool", resolve), true, "the client keeps the owner's row rule");
assert.equal(client.getToolPresentation("owner_command")?.detailed, true, "and the owner's block ownership");
assert.equal(
  core.keepsCompactRow("owner_text_only", resolve),
  true,
  "a text-only tool keeps its row on the host too (the owner has a renderer for it)"
);
assert.equal(
  core.describeToolPresentations().some((entry) => entry.name === "owner_only_tool"),
  false,
  "session descriptors are never re-published as host catalog entries"
);

// A second client owns its own catalog; one session must not adopt another's rows.
const second = new RemoteSessionClient({
  agentId: "catalog-check-2",
  baseUrl: "http://127.0.0.1:1",
  fetchImpl: async () => {
    throw new Error("no network in this check");
  },
  initialSnapshot: {
    agentId: "catalog-check-2",
    messages: [],
    toolDescriptors: [ownerCatalog[1]],
  },
});
const resolveSecond = (name) => second.getToolPresentation(name) ?? core.getBuiltinToolPresentation(name);
assert.equal(core.keepsCompactRow("owner_only_tool", resolveSecond), false, "a second session does not inherit it");
assert.equal(core.keepsCompactRow("owner_command", resolveSecond), true, "and resolves only its own catalog");
assert.equal(core.keepsCompactRow("owner_only_tool", resolve), true, "the first session still resolves its own");

console.log("validate-remote-tool-catalog: ok");
