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

const { createServer, getServerManager } = await import("../dist/index.mjs");
const { createRemoteAgentSessionHost } = await import("../dist/remote-session-host.mjs");
const { applyEventForTests, parseAgentSessionSseBlockForTests, RemoteSessionClient } =
  await import("../dist/remote-session-client.mjs");

// ── 0. SSE parse helper still tolerates heartbeats ──
assert.equal(parseAgentSessionSseBlockForTests(": ping\n\n"), null);
assert.equal(parseAgentSessionSseBlockForTests("event: ping\ndata: \n\n"), null);

// ── 0b. The remote snapshot reducer must actually carry the fields the UI reads ──
//
// A remote client caches a snapshot and updates it from channel events; `dispatch()` deliberately
// does NOT refetch it. So a field the UI renders, with no channel carrying it, is stale until an
// unrelated full resync — and locally the same code looks correct, because
// `LocalAgentSession.getSnapshot()` reads live memory. Both of these shipped that way.
{
  const base = {
    agentId: "a1",
    name: "n",
    status: "running",
    error: "",
    pendingApprovalCount: 0,
    mode: "normal",
    lastStreamDurationMs: 0,
    messages: [],
    queues: { steer: [], followUp: [] },
    usage: {},
    todos: [],
    todosTitle: null,
    plan: {},
    autoMode: false,
    mcp: { servers: [] },
    extensions: { extensions: [] },
    toolDescriptors: [],
    interactions: { approvals: [], askUser: [] },
    jobs: { jobs: [] },
    iteration: { current: 0, max: 0 },
    subagents: [],
  };

  // (i) The footer renders "Completed in 1.2s" from `lastStreamDurationMs`, which is set at the END
  // of a run — the moment no other channel fires. It has to ride the state event.
  const l1 = {
    status: "completed",
    name: "n",
    sessionId: null,
    error: "",
    pendingApprovalCount: 0,
    model: "m",
    modelInfo: null,
    reasoningEffort: null,
    lastStreamDurationMs: 4321,
  };
  const done = applyEventForTests(base, { channel: "state", payload: l1, ts: 1 });
  assert.equal(done.status, "completed");
  assert.equal(done.lastStreamDurationMs, 4321, "the state channel carries the run duration");

  // (ii) `subagent:created` / `:destroyed` carry a single id, so the list can only move through the
  // retained `subagents` channel. A panel that re-reads its cached snapshot on those events would
  // gain and lose nothing off-process.
  const added = applyEventForTests(base, {
    channel: "subagents",
    payload: { subagents: [{ id: "s1", status: "running" }] },
    ts: 2,
  });
  assert.equal(added.subagents.length, 1, "the subagents channel adds a task row");
  const removed = applyEventForTests(added, { channel: "subagents", payload: { subagents: [] }, ts: 3 });
  assert.equal(removed.subagents.length, 0, "and removes one");
}

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

// ── 1b. Create-body tuning knobs reach the local host; bad values are 400 ──
//
// These are part of `AgentSessionCreateOptions` now. A remote-session client would otherwise set
// them locally and have them silently dropped by the HTTP schema — the exact drift the local
// `validate:agent-session-host` matrix guards on the other end of the wire.
const model = process.env.MODEL || "test-model";
const tuningRes = await fetch(`${baseUrl}/api/agent`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "tuning-agent",
    model,
    temperature: 0.2,
    maxTokens: 128,
    reasoningEffort: "high",
    compaction: { tokenThreshold: 50_000, compactAtPercent: 70 },
    skillDirs: [],
    lazyToolsConfig: { includeDescription: "full" },
    agentDocFilenames: ["PROBE.md"],
    agentDocLoadOverride: false,
  }),
});
assert.equal(tuningRes.status, 200, "create accepts every tuning knob");
const tuning = await tuningRes.json();
await fetch(`${baseUrl}/api/agent/${tuning.id}`, { method: "DELETE" });

const badReasoning = await fetch(`${baseUrl}/api/agent`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "bad-reasoning", model, reasoningEffort: "not-a-level" }),
});
assert.equal(badReasoning.status, 400, "an out-of-enum reasoning level is a client error, not a 500");
const badTemperature = await fetch(`${baseUrl}/api/agent`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "bad-temperature", model, temperature: 9 }),
});
assert.equal(badTemperature.status, 400, "an out-of-range temperature is a client error");

// ── 2. Remount seed routes ──
const summaryRes = await fetch(`${baseUrl}/api/agent/${snap.agentId}/summary-streams`);
assert.equal(summaryRes.status, 200);
assert.deepEqual((await summaryRes.json()).snapshots ?? [], []);

const bufferRes = await fetch(`${baseUrl}/api/agent/${snap.agentId}/tool-buffers`);
assert.equal(bufferRes.status, 200);
assert.deepEqual((await bufferRes.json()).buffers, {});

// `task` children use `autoDestroy: false`; a session switch aborts but does not destroy them.
// The remount seed must keep the old child's command buffers out of the current conversation.
{
  const manager = getServerManager();
  const currentChild = await manager.spawnSubagent(snap.agentId, {});
  const oldChild = await manager.spawnSubagent(snap.agentId, {});
  oldChild.setSessionScopeId("ses_old");
  currentChild.getStreamHub().appendCommand("current-command", "stdout", "current output");
  oldChild.getStreamHub().appendCommand("old-command", "stdout", "old output");

  assert.ok(
    manager.getAllSubagents(snap.agentId).some((agent) => agent.id === oldChild.id),
    "the old child is still in the registry (session switch only aborts it)"
  );

  const scopedRes = await fetch(`${baseUrl}/api/agent/${snap.agentId}/tool-buffers`);
  assert.equal(scopedRes.status, 200);
  const scopedBuffers = (await scopedRes.json()).buffers;
  assert.equal(scopedBuffers["current-command"]?.stdout, "current output", "the current child is seeded");
  assert.equal(scopedBuffers["old-command"], undefined, "the old child's command buffer is filtered out");

  manager.destroyAgent(currentChild.id);
  manager.destroyAgent(oldChild.id);
}

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

// ── 2d. `?channels=` is narrowed to real channel names, and rejects unknown ones ──
//
// The query string is untrusted text that used to reach `session.subscribe` as `string[]`.
// Narrowing it must not degrade into "subscribe to everything": core reads an *empty*
// channel list as "use the defaults", so an unknown name dropped to `[]` would hand the
// client every channel it did not ask for. Assert the rejection instead.
{
  const unknown = await fetch(`${baseUrl}/api/agent/${snap.agentId}/events?channels=bogus`);
  assert.equal(unknown.status, 400, "an unknown channel must be rejected, not silently dropped");
  const body = await unknown.json();
  assert.match(body.message, /bogus/, "the rejection must name the offending channel");

  // A mixed list is rejected too — a partially-unknown request must not half-subscribe.
  const mixed = await fetch(`${baseUrl}/api/agent/${snap.agentId}/events?channels=state,bogus`);
  assert.equal(mixed.status, 400);

  // The legitimate spelling still works, and an empty value falls back to the defaults.
  const ok = await fetch(`${baseUrl}/api/agent/${snap.agentId}/events?channels=state,messages`, {
    signal: AbortSignal.timeout(1500),
  });
  assert.equal(ok.status, 200);
  ok.body?.cancel();
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

  // getAgentStreamSnapshot returns cached (empty) — not always-null contract shape
  assert.equal(client.getAgentStreamSnapshot("task:none"), null);

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
