/**
 * End-to-end validation of the remote-session incremental channels.
 *
 * Boots the real Hono server on an ephemeral port, creates a real agent via
 * the remote host, then dispatches state-mutating commands and asserts the new
 * protocol-level channels (`extensions` / `mcp` / `mode`) are delivered and the
 * RemoteSessionClient's cached snapshot fields flip accordingly — without a
 * snapshot refetch.
 *
 * Note: post-command events are emitted once, at dispatch time, and are not
 * replayed to subscribers who connect afterwards — so each subscription waits
 * for an initial `state` event before dispatching, to ensure its SSE stream is
 * live.
 *
 * Run: pnpm --filter @codent/server run validate:agent-session-channels
 */
/* eslint-disable no-undef */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TEMP_RM_OPTIONS } from "../../core/scripts/helpers/temp-cleanup.mjs";

process.env.ROOT_PATH = mkdtempSync(join(tmpdir(), "agent-session-channels-"));
process.env.SERVER_PORT = "0";
process.env.SANDBOX_ENV = "native";

const { createServer, getServerManager } = await import("../dist/index.mjs");
const { createRemoteAgentSessionHost } = await import("../dist/remote-session-host.mjs");
const { RemoteSessionClient, applyEventForTests } = await import("../dist/remote-session-client.mjs");

// The server owns its agent runtime (a `CodentAgent` over the workspace CoreEnv);
// `getServerManager()` from the server entry reaches the agents it created.
// `agentStreamKey` is a pure helper shared through the externalized core.
const { agentStreamKey } = await import(new URL("../../core/dist/index.mjs", import.meta.url).href);

const waitFor = async (label, fn, timeoutMs = 6000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timeout waiting for ${label}`);
};

const server = createServer();
await new Promise((resolve) => setTimeout(resolve, 400));
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;
assert.ok(port > 0);
const baseUrl = `http://127.0.0.1:${port}`;

const host = createRemoteAgentSessionHost({ baseUrl });
const { session } = await host.create({
  name: "channels-agent",
  model: process.env.MODEL || "test-model",
});

// ── 1. mcp.refresh → mcp event + snapshot.mcp present ──
const seen = new Set();
const unsub = session.subscribe(
  (event) => {
    seen.add(event.channel);
  },
  { channels: ["mcp", "mode", "extensions", "state"] }
);
await waitFor("SSE live (initial state)", () => seen.has("state"));

const mcpRes = await session.dispatch({ type: "mcp.refresh" });
assert.equal(mcpRes.ok, true, `mcp.refresh ok: ${JSON.stringify(mcpRes)}`);
await waitFor("mcp event", () => seen.has("mcp"));
assert.ok(Array.isArray(session.getSnapshot().mcp.servers), "snapshot.mcp.servers must be an array");

// ── 2. auto.toggle → mode event + snapshot.autoMode flips ──
const beforeAuto = session.getSnapshot().autoMode;
const autoRes = await session.dispatch({ type: "mode.set", mode: "auto" });
assert.equal(autoRes.ok, true);
await waitFor("mode event + autoMode flip", () => seen.has("mode") && session.getSnapshot().autoMode !== beforeAuto);

// ── 3. plan.enable → mode === "plan" ──
const planOn = await session.dispatch({ type: "mode.set", mode: "plan" });
assert.equal(planOn.ok, true);
await waitFor("snapshot.mode === plan", () => session.getSnapshot().mode === "plan");

// ── 4. plan.disable → mode === "normal" ──
const planOff = await session.dispatch({ type: "mode.set", mode: "normal" });
assert.equal(planOff.ok, true);
await waitFor("snapshot.mode === normal", () => session.getSnapshot().mode === "normal");

// ── 5. extension.toggle → extensions event + snapshot.extensions flip ──
const extensions = session.getSnapshot().extensions?.extensions ?? [];
if (extensions.length > 0) {
  const first = extensions[0];
  const target = !first.enabled;
  const extRes = await session.dispatch({ type: "extension.toggle", id: first.id, enabled: target });
  assert.equal(extRes.ok, true, `extension.toggle ok: ${JSON.stringify(extRes)}`);
  await waitFor("extensions event", () => seen.has("extensions"));
  await waitFor(
    `snapshot.extensions[${first.id}].enabled === ${target}`,
    () => session.getSnapshot().extensions.extensions.find((e) => e.id === first.id)?.enabled === target
  );
  // restore original state
  await session.dispatch({ type: "extension.toggle", id: first.id, enabled: first.enabled });
} else {
  // The suite reads the shared skip marker to report this as a skip rather than silently
  // folding an unexercised branch into a pass.
  console.log("[validator-skip] no extensions loaded on temp root; extension.toggle branch not exercised");
}

// ── 6. Channel filtering: a state-only subscriber must not see mode events ──
const stateOnlyChannels = [];
const stateOnly = session.subscribe(
  (event) => {
    stateOnlyChannels.push(event.channel);
  },
  { channels: ["state"] }
);
await waitFor("state-only SSE live", () => stateOnlyChannels.length > 0);
await session.dispatch({ type: "mode.set", mode: "auto" }); // emits a mode event
await new Promise((resolve) => setTimeout(resolve, 200));
assert.ok(!stateOnlyChannels.includes("mode"), "state-only subscriber must not receive mode events");
stateOnly();

// ── 7. Unsubscribe stops delivery ──
let postUnsub = 0;
const temp = session.subscribe(
  () => {
    postUnsub += 1;
  },
  { channels: ["mode", "state"] }
);
await waitFor("temp SSE live", () => postUnsub > 0); // initial state event proves the stream is live
temp();
const countAfterUnsub = postUnsub;
await session.dispatch({ type: "mode.toggle" });
await new Promise((resolve) => setTimeout(resolve, 200));
assert.equal(postUnsub, countAfterUnsub, "unsubscribed handler must not receive events");

// ── 8. RemoteSessionClient applies the new channels onto its cached snapshot ──
{
  const client = new RemoteSessionClient({ baseUrl, agentId: session.getSnapshot().agentId });
  const clientSeen = new Set();
  const clientUnsub = client.subscribe(
    (event) => {
      clientSeen.add(event.channel);
    },
    { channels: ["mode", "state"] }
  );
  await waitFor("client SSE live", () => clientSeen.has("state"));
  const before = client.getSnapshot().autoMode;
  await session.dispatch({ type: "mode.set", mode: before ? "normal" : "auto" });
  await waitFor("client snapshot autoMode flip", () => client.getSnapshot().autoMode !== before);
  assert.ok(
    ["normal", "plan", "auto"].includes(client.getSnapshot().mode),
    `mode valid (got ${client.getSnapshot().mode})`
  );
  clientUnsub();
}

// ── 9. tool + summary channels end-to-end (unified bus → session projection → SSE) ──
// Drives the server-side agent's scoped bus directly (tool:chunk / tool:clear,
// session:summary via the shared AgentStreamHub) and asserts the client sees
// the projected `tool` / `summary` session events.
{
  const agentId = session.getSnapshot().agentId;
  const managed = getServerManager().getAgent(agentId);
  assert.ok(managed, "server agent is registered in the server runtime's manager");

  const client = new RemoteSessionClient({ baseUrl, agentId });
  /** @type {Array<{channel: string; payload: any}>} */
  const live = [];
  const clientUnsub = client.subscribe((event) => live.push(event), { channels: ["tool", "summary", "state"] });
  // tool/summary carry no retained value — wait for the retained `state` replay
  // first so the SSE subscription is mounted before we emit (events would
  // otherwise be lost before the stream exists).
  await waitFor("tool/summary SSE live", () => live.some((e) => e.channel === "state"));

  const bus = managed.getEventBus();
  assert.ok(bus, "managed agent has a scoped unified bus");

  // Command stream: run_command → per-agent AgentStreamHub → tool:chunk / tool:clear.
  // Here we drive the scoped bus directly to exercise the full session projection + SSE hop.
  bus.emit("tool:chunk", {
    kind: "chunk",
    chunk: { toolCallId: "e2e-run", type: "stdout", chunk: "hello e2e" },
  });
  bus.emit("tool:clear", { kind: "clear", toolCallId: "e2e-run" });

  // Task summary stream: AgentStreamHub (parent-managed) → session:summary.
  const taskKey = agentStreamKey("task", "e2e-task");
  managed.streamHub.reset({ source: "task", toolCallId: "e2e-task" });
  managed.streamHub.append(taskKey, "task text\n");
  managed.streamHub.end(taskKey);

  // Compact stream: same hub, `compact` source → compact banner events.
  const compactKey = agentStreamKey("compact", agentId);
  managed.streamHub.reset({ source: "compact", compactId: agentId, label: "e2e compact" });
  managed.streamHub.append(compactKey, "compact text");

  await waitFor(
    "tool + summary channels",
    () =>
      live.some((e) => e.channel === "tool" && e.payload.kind === "chunk" && e.payload.chunk.chunk === "hello e2e") &&
      live.some((e) => e.channel === "tool" && e.payload.kind === "clear" && e.payload.toolCallId === "e2e-run") &&
      live.some((e) => e.channel === "summary" && e.payload.type === "reset" && e.payload.source === "task") &&
      live.some((e) => e.channel === "summary" && e.payload.type === "append")
  );

  // A summary append can arrive without a preceding reset (the row mounted after the reset,
  // or the first subscription skipped a resync). The cache must synthesize the entry, and a
  // same-epoch append must reopen an ended stream.
  {
    const cache = new Map();
    const snapshot = client.getSnapshot();
    applyEventForTests(
      snapshot,
      {
        channel: "summary",
        payload: {
          type: "append",
          key: "task:late-row",
          source: "task",
          channel: "text",
          toolCallId: "late-row",
          chunk: "late text\n",
          seq: 2,
        },
      },
      cache
    );
    const late = cache.get("task:late-row");
    assert.ok(late, "an append without a cached reset creates a stream entry");
    assert.equal(late.status, "active", "the synthesized entry is active");
    assert.deepEqual(late.lines, ["late text"], "the first append is retained");

    applyEventForTests(
      snapshot,
      { channel: "summary", payload: { type: "end", key: "task:late-row", source: "task", channel: "text", seq: 3 } },
      cache
    );
    assert.equal(cache.get("task:late-row")?.status, "ended", "end closes the synthesized entry");

    applyEventForTests(
      snapshot,
      {
        channel: "summary",
        payload: {
          type: "append",
          key: "task:late-row",
          source: "task",
          channel: "text",
          toolCallId: "late-row",
          chunk: "next pass\n",
          seq: 4,
        },
      },
      cache
    );
    assert.equal(cache.get("task:late-row")?.status, "active", "an append after end reopens the entry");
  }

  // Late-read fallback: the summary-streams endpoint still serves current hub
  // text (remote clients keep a local summaryCache fed by SSE events only).
  const summaryRes = await fetch(`${baseUrl}/api/agent/${agentId}/summary-streams`);
  assert.equal(summaryRes.status, 200);
  const { snapshots } = await summaryRes.json();
  const compSnap = snapshots.find((s) => s.key === compactKey);
  assert.ok(
    compSnap && String(compSnap.pendingLine ?? "").includes("compact text"),
    `compact summary snapshot readable via HTTP (got ${JSON.stringify(compSnap)})`
  );

  // A reconnect/resync while an SSE subscription is already mounted must re-publish
  // the re-seeded summary cache; otherwise useSummaryStream keeps the text it read
  // at subscription time and never sees the server's newer snapshot.
  const beforeResyncReplay = live.length;
  await client.refresh();
  await waitFor(
    "resync replay reaches the live summary subscriber",
    () =>
      live
        .slice(beforeResyncReplay)
        .some(
          (event) => event.channel === "summary" && event.payload.type === "reset" && event.payload.key === compactKey
        ) &&
      live
        .slice(beforeResyncReplay)
        .some(
          (event) =>
            event.channel === "summary" &&
            event.payload.type === "append" &&
            event.payload.key === compactKey &&
            String(event.payload.chunk ?? "").includes("compact text")
        )
  );

  clientUnsub();
}

// ── Lifecycle projection: id first, unambiguous task fallback, no generation bleed ──
// The `lifecycle` channel is the only subagent source for a client that does not subscribe to
// `subagents` (the extension sidepanel). These cases drive the reducer directly: a row must be
// created by the events that introduce a child, a call-scoped phase must find its row when the
// child id is absent, and an ambiguous call (a discarded pre-fork plus its respawn) must not be
// patched wholesale — that regression is what `resolveSubagentRowDisplay` exists to undo.
{
  const lifecycle = (type, agentId, payload) => ({ channel: "lifecycle", payload: { type, agentId, payload } });
  const ids = (snapshot) => snapshot.subagents.map((row) => row.id);
  let snapshot = { subagents: [] };

  snapshot = applyEventForTests(
    snapshot,
    lifecycle("subagent:started", "sub-agent-1", {
      subagentId: "sub-agent-1",
      description: "explore the tree",
      parentTaskToolCallId: "task-1",
    })
  );
  assert.deepEqual(ids(snapshot), ["sub-agent-1"]);
  assert.equal(snapshot.subagents[0].description, "explore the tree");

  snapshot = applyEventForTests(
    snapshot,
    lifecycle("subagent:phase", "root-agent", { phase: "summary", parentTaskToolCallId: "task-1" })
  );
  assert.equal(
    snapshot.subagents[0].taskPhase,
    "summary",
    "a phase without a child id resolves through the single row registered for its task call"
  );

  snapshot = applyEventForTests(
    snapshot,
    lifecycle("subagent:started", "sub-agent-2", {
      subagentId: "sub-agent-2",
      description: "retry",
      parentTaskToolCallId: "task-1",
    })
  );
  const before = snapshot.subagents.map((row) => row.taskPhase);
  snapshot = applyEventForTests(
    snapshot,
    lifecycle("subagent:phase", "root-agent", { phase: "limit", parentTaskToolCallId: "task-1" })
  );
  assert.deepEqual(
    snapshot.subagents.map((row) => row.taskPhase),
    before,
    "an ambiguous task fallback (two generations) must not patch every row"
  );

  snapshot = applyEventForTests(
    snapshot,
    lifecycle("subagent:phase", "sub-agent-2", {
      subagentId: "sub-agent-2",
      phase: "limit",
      parentTaskToolCallId: "task-1",
    })
  );
  assert.equal(snapshot.subagents.find((row) => row.id === "sub-agent-2").taskPhase, "limit");
  assert.notEqual(snapshot.subagents.find((row) => row.id === "sub-agent-1").taskPhase, "limit");

  snapshot = applyEventForTests(
    snapshot,
    lifecycle("subagent:destroyed", "sub-agent-1", { subagentId: "sub-agent-1" })
  );
  assert.deepEqual(ids(snapshot), ["sub-agent-2"], "destroyed removes the row");
  console.log("lifecycle projection: id + unambiguous task fallback + no generation bleed — ok");
}

// ── the reducer must cover EVERY channel, and stay exhaustive ──
//
// The per-channel assertions above only prove the channels someone thought to test. A new
// `AGENT_SESSION_CHANNELS` entry used to fall into `default: return snapshot`, so the remote
// snapshot silently stopped updating (that is exactly how `lastIteration` would have been missed)
// while every listed channel stayed green. The reducer now ends in `never` (a compile error when a
// channel is unhandled); this pins both halves from the outside.
{
  const { AGENT_SESSION_CHANNELS } = await import(new URL("../../core/dist/index.mjs", import.meta.url).href);
  const source = readFileSync(new URL("../src/remote-session-reducer.ts", import.meta.url), "utf8");
  const missing = AGENT_SESSION_CHANNELS.filter((channel) => !source.includes(`case "${channel}":`));
  assert.deepEqual(missing, [], `remote reducer has no case for: ${missing.join(", ")}`);
  assert.match(
    source,
    /const uncovered: never = event;/,
    "the reducer must keep its exhaustiveness guard (a dropped channel has to fail to compile)"
  );
  console.log(`reducer covers all ${AGENT_SESSION_CHANNELS.length} channels — ok`);
}

unsub();
await host.destroy(session.getSnapshot().agentId);
// Await the close, and destroy keep-alive sockets first. `server.close()` only fires its
// callback once every connection has ended, and undici's `fetch` keeps connections alive — so
// awaiting close() alone can hang forever (caught by CI as a validator timeout). Firing the
// callback without awaiting would instead exit mid-close, which trips a libuv assertion on
// Windows (`!(handle->flags & UV_HANDLE_CLOSING)`) after the success line was already printed.
server.closeAllConnections?.();
await new Promise((resolve) => server.close(resolve));
rmSync(process.env.ROOT_PATH, TEMP_RM_OPTIONS);
console.log("agent-session-channels validation passed");
process.exit(0);
