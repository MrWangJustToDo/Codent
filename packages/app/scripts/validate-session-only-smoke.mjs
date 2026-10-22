/**
 * Local Session-only smoke against real Local Host (native CoreEnv, temp workspace).
 *
 * Covers Host.create → snapshot fields → plan / mcp / session.list → destroy.
 * Interactive CLI chat/subagent panel remains a manual checklist (see README).
 *
 * Run: pnpm --filter @codent/app run validate:session-only-smoke
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "codent-session-smoke-"));

const { createNodeEnv } = await import(new URL("../../node/dist/index.mjs", import.meta.url).href);
const { agentManager, clearCoreEnv, createLocalAgentSessionHost, registerCoreEnv } = await import(
  new URL("../../core/dist/index.mjs", import.meta.url).href
);

registerCoreEnv(createNodeEnv({ rootPath: root, mode: "native" }));

try {
  const host = createLocalAgentSessionHost({ manager: agentManager });
  const { session } = await host.create({
    name: "smoke",
    model: "smoke-model",
    modelStyle: "openai",
    maxIterations: 5,
    systemPrompt: "smoke",
  });

  const snap = session.getSnapshot();
  assert.equal(snap.name, "smoke");
  assert.equal(snap.status, "idle");
  assert.ok(Array.isArray(snap.subagents));
  assert.equal(typeof snap.plan.phase, "string");
  assert.ok(Array.isArray(snap.mcp.servers));
  assert.ok(Array.isArray(snap.extensions.extensions));

  assert.equal((await session.dispatch({ type: "mode.toggle" })).ok, true);
  assert.equal((await session.dispatch({ type: "plan.list" })).ok, true);
  assert.equal((await session.dispatch({ type: "mcp.refresh" })).ok, true);

  const listed = await session.dispatch({ type: "session.list" });
  assert.equal(listed.ok, true);
  assert.ok(Array.isArray(listed.data?.sessions));

  assert.equal((await session.dispatch({ type: "stop" })).ok, true);
  assert.ok((await host.list()).some((e) => e.agentId === session.id));

  await host.destroy(session.id);
  assert.equal(host.connect(session.id), null);

  console.log("session-only-smoke: ok");
} finally {
  for (const agent of [...agentManager.getAgents()]) {
    agentManager.destroyAgent(agent.id);
  }
  clearCoreEnv();
}
