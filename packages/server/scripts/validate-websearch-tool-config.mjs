/**
 * Remote-session create must carry websearch `toolConfig` to the server-side agent loop
 * (spec: "Remote-session create carries tool configuration").
 *
 * The gap this guards: the server's `POST /api/agent` schema accepted `toolConfig`, but the
 * client host (`createRemoteAgentSessionHost`) assembled the body field-by-field and never
 * sent it — so a remote-session client's websearch keys were silently dropped and the
 * server silently used its own defaults. Asserting the request *shape* would not have caught
 * it; this boots the real server and inspects the created agent's effective tool config.
 *
 * Run: pnpm --filter @codent/server run validate:websearch-tool-config
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ROOT_PATH = mkdtempSync(join(tmpdir(), "websearch-toolconfig-http-"));
process.env.SERVER_PORT = "0";
process.env.SANDBOX_ENV = "native";

const { createServer, getServerManager } = await import("../dist/index.mjs");
const { createRemoteAgentSessionHost } = await import("../dist/remote-session-host.mjs");

const WEBSEARCH = {
  braveApiKey: "brave-secret-from-client",
  parallelApiKey: "parallel-secret-from-client",
  provider: "parallel",
};

const server = createServer();
await new Promise((resolve) => setTimeout(resolve, 400));
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;
assert.ok(port > 0, "server must listen on an ephemeral port");
const baseUrl = `http://127.0.0.1:${port}`;

try {
  const host = createRemoteAgentSessionHost({ baseUrl });

  // ── 1. A create WITH toolConfig must reach the server-side agent's config ──
  {
    const { session } = await host.create({
      name: "toolconfig-agent",
      model: process.env.MODEL || "test-model",
      maxConcurrentTasks: 7,
      toolConfig: { websearch: WEBSEARCH },
    });
    const snapshot = session.getSnapshot();
    const agent = getServerManager().getAgent(snapshot.agentId);
    assert.ok(agent, "the server must own an agent for the created id");
    const effective = agent.config.toolConfig?.websearch;
    assert.ok(effective, "the server-side agent must carry a websearch tool config");
    assert.equal(effective.provider, WEBSEARCH.provider, "provider preference must be forwarded");
    assert.equal(effective.braveApiKey, WEBSEARCH.braveApiKey, "brave key must be forwarded");
    assert.equal(effective.parallelApiKey, WEBSEARCH.parallelApiKey, "parallel key must be forwarded");
    assert.equal(agent.config.maxConcurrentTasks, 7, "maxConcurrentTasks must be forwarded to the server-side agent");
  }

  // ── 2. A create WITHOUT toolConfig keeps the server default (no leakage from case 1) ──
  {
    const { session } = await host.create({
      name: "no-toolconfig-agent",
      model: process.env.MODEL || "test-model",
    });
    const agent = getServerManager().getAgent(session.getSnapshot().agentId);
    assert.ok(agent);
    const effective = agent.config.toolConfig?.websearch;
    assert.equal(effective?.provider, undefined, "no client toolConfig → no forwarded provider");
    assert.equal(effective?.braveApiKey, undefined, "no client toolConfig → no forwarded key");
    assert.equal(agent.config.maxConcurrentTasks, undefined, "no client cap → server default");
  }

  console.log("websearch toolConfig forwarding validation passed");
} finally {
  server.close();
}
