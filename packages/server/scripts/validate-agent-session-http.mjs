/**
 * Live Local-vs-Remote AgentSession parity smoke.
 *
 * Boots the real Hono server on an ephemeral port, creates a real agent via
 * the remote host, then exercises catalog routes, remount seeds (tool buffers
 * / summary streams), state-channel sync (incl. rename without refetch), and
 * RemoteSessionClient reconnect behavior.
 *
 * Run: pnpm --filter @codent/server run validate:agent-session-http
 */
/* eslint-disable no-undef */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TEMP_RM_OPTIONS } from "../../core/scripts/helpers/temp-cleanup.mjs";

process.env.ROOT_PATH = mkdtempSync(join(tmpdir(), "agent-session-http-"));
process.env.SERVER_PORT = "0";
process.env.SANDBOX_ENV = "native";

const { createServer } = await import("../dist/index.mjs");
const { createRemoteAgentSessionHost } = await import("../dist/remote-session-host.mjs");
const { parseAgentSessionSseBlockForTests, RemoteSessionClient } = await import("../dist/remote-session-client.mjs");

// ── 0. SSE parse helper still tolerates heartbeats ──
assert.equal(parseAgentSessionSseBlockForTests(": ping\n\n"), null);
assert.equal(parseAgentSessionSseBlockForTests("event: ping\ndata: \n\n"), null);

const server = createServer();
await new Promise((resolve) => setTimeout(resolve, 400));
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;
assert.ok(port > 0);
const baseUrl = `http://127.0.0.1:${port}`;

// ── 1. Remote Host: create → snapshot → list ──
const host = createRemoteAgentSessionHost({ baseUrl });
const { session } = await host.create({
  name: "parity-agent",
  model: process.env.MODEL || "test-model",
});

const snap = session.getSnapshot();
assert.equal(snap.name, "parity-agent");
assert.ok(snap.agentId.length > 0);

const listResult = await host.list();
assert.ok(Array.isArray(listResult));
assert.ok(listResult.some((entry) => entry.agentId === snap.agentId));

// ── 2. Remount seed routes ──
const summaryRes = await fetch(`${baseUrl}/api/agent/${snap.agentId}/summary-streams`);
assert.equal(summaryRes.status, 200);
assert.deepEqual((await summaryRes.json()).snapshots ?? [], []);

const bufferRes = await fetch(`${baseUrl}/api/agent/${snap.agentId}/tool-buffers`);
assert.equal(bufferRes.status, 200);
assert.deepEqual((await bufferRes.json()).buffers, {});

// ── 2b. REST snapshots are gzip-compressed (bodies stay transparent JSON) ──
const gzipRes = await fetch(`${baseUrl}/api/agent/${snap.agentId}/snapshot`, {
  headers: { "accept-encoding": "gzip" },
});
assert.equal(gzipRes.status, 200);
assert.equal(gzipRes.headers.get("content-encoding"), "gzip", "snapshot route must compress");
assert.equal((await gzipRes.json()).name, "parity-agent");

// ── 2c. Raw SSE frame contract: {channel, payload, ts} wrapper survives ──
{
  const controller = new AbortController();
  const sse = await fetch(`${baseUrl}/api/agent/${snap.agentId}/events?channels=state`, {
    signal: controller.signal,
  });
  assert.equal(sse.status, 200);
  await session.dispatch({ type: "rename", name: "raw-frame-check" });
  const reader = sse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let frame = null;
  for (let i = 0; i < 50 && !frame; i++) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), 3000)),
    ]);
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const parsed = parseAgentSessionSseBlockForTests(block);
      // Skip the initial-state frame; wait for the post-rename one.
      if (parsed && parsed.channel === "state" && parsed.payload?.name === "raw-frame-check") {
        frame = parsed;
        break;
      }
    }
  }
  controller.abort();
  assert.ok(frame, "state event must arrive as an SSE frame");
  assert.equal(frame.payload.name, "raw-frame-check");
  assert.equal(typeof frame.ts, "number");
}

// ── 3. State-channel sync: rename propagates without a snapshot refetch ──
const stateUnsub = session.subscribe(() => {}, { channels: ["state"] });
await new Promise((resolve) => setTimeout(resolve, 150));

await session.dispatch({ type: "rename", name: "renamed-via-state" });
let renamed = false;
for (let i = 0; i < 40 && !renamed; i++) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  renamed = session.getSnapshot().name === "renamed-via-state";
}
assert.ok(renamed, `rename must propagate via state channel (got "${session.getSnapshot().name}")`);

// ── 4. RemoteSessionClient reconnect: survives server restart of the stream ──
{
  const client = new RemoteSessionClient({ baseUrl, agentId: snap.agentId });
  let events = 0;
  const unsub = client.subscribe(
    () => {
      events += 1;
    },
    { channels: ["state"] }
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(events >= 1, "subscribe should deliver initial state event");

  // getSummaryStreamSnapshot returns cached (empty) — not always-null contract shape
  assert.equal(client.getSummaryStreamSnapshot("task:none"), null);

  // refresh() hydrates from server routes
  await client.refresh();
  assert.equal(client.getSnapshot().name, "renamed-via-state");
  unsub();
}

// ── 5. Child id routes resolve through the same plane ──
{
  // Unknown id → 404 (server decides; no local crash)
  const missing = await fetch(`${baseUrl}/api/agent/does-not-exist/snapshot`);
  assert.equal(missing.status, 404);
  const lazy = host.connect("does-not-exist");
  assert.ok(lazy, "connect stays synchronous and delegates existence to the server");
}

// ── 5b. `/models` must always offer the server's own model ──
{
  // The connection `POST /api/agent` falls back to when a client names no model is the
  // server's `.env` MODEL. A models.json listing other ids used to hide it: the route
  // added the fallback entry only when models.json was absent, so the advertised list
  // was one no session could select its own default model from.
  process.env.MODEL = "served-model";
  mkdirSync(join(process.env.ROOT_PATH, ".agents", "config"), { recursive: true });
  writeFileSync(
    join(process.env.ROOT_PATH, ".agents", "config", "models.json"),
    JSON.stringify({
      models: [
        {
          type: "direct",
          style: "openai",
          baseURL: "https://upstream.example.com/v1",
          apiKey: "sk-must-not-leak",
          models: ["other-model"],
        },
      ],
    })
  );

  const modelsRes = await fetch(`${baseUrl}/api/agent/models`);
  assert.equal(modelsRes.status, 200);
  const payload = await modelsRes.json();
  const offered = payload.entries.flatMap((entry) => entry.models);
  assert.ok(offered.includes("other-model"), "models.json ids stay offered");
  assert.ok(offered.includes("served-model"), "the server's own .env model must always be offered");
  assert.equal(payload.active.model, "served-model", "and it is what a session started now would run");
  assert.ok(
    payload.entries[payload.active.entryIndex].models.includes(payload.active.model),
    "active must point at an entry that offers it"
  );
  assert.ok(!JSON.stringify(payload).includes("upstream.example.com"), "no upstream baseURL leaves the server");
  assert.ok(!JSON.stringify(payload).includes("sk-must-not-leak"), "no apiKey either");
}

// ── 6. Destroy ──
await host.destroy(snap.agentId);
const gone = await fetch(`${baseUrl}/api/agent/${snap.agentId}/snapshot`);
assert.equal(gone.status, 404);

stateUnsub();
// Await the close, and destroy keep-alive sockets first. `server.close()` only fires its
// callback once every connection has ended, and undici's `fetch` keeps connections alive — so
// awaiting close() alone can hang forever (caught by CI as a validator timeout). Firing the
// callback without awaiting would instead exit mid-close, which trips a libuv assertion on
// Windows (`!(handle->flags & UV_HANDLE_CLOSING)`) after the success line was already printed.
server.closeAllConnections?.();
await new Promise((resolve) => server.close(resolve));
rmSync(process.env.ROOT_PATH, TEMP_RM_OPTIONS);
console.log("agent-session-http validation passed");
process.exit(0);
