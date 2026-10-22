/**
 * Validates AgentStreamHub + line-buffer / display-window helpers.
 *
 * Run: pnpm --filter @codent/core run validate:agent-stream
 */

import assert from "node:assert/strict";

import {
  AgentStreamHub,
  applyAppendToAgentStreamWindow,
  applyAgentStreamAppend,
  createAgentEventBus,
  agentStreamWindowFromSnapshot,
  emptyAgentStreamDisplayWindow,
  emptyAgentStreamLineBuffer,
  renderAgentStreamDisplayRows,
  agentStreamKey,
} from "../dist/dev.mjs";

// --- line buffer ---
{
  let buf = emptyAgentStreamLineBuffer();
  buf = applyAgentStreamAppend(buf, "hello");
  assert.deepEqual(buf, { lines: [], pendingLine: "hello" });
  buf = applyAgentStreamAppend(buf, "\nworld\n");
  assert.deepEqual(buf, { lines: ["hello", "world"], pendingLine: "" });
  buf = applyAgentStreamAppend(buf, "tail", { maxCompleteLines: 1 });
  assert.deepEqual(buf, { lines: ["world"], pendingLine: "tail" });
}

// --- display window ---
{
  let win = emptyAgentStreamDisplayWindow();
  win = applyAppendToAgentStreamWindow(win, "a\nb\nc\nd\n", 2);
  assert.deepEqual(win.lines, ["c", "d"]);
  assert.equal(win.hidden, 2);
  assert.equal(win.pendingLine, "");

  const rendered = renderAgentStreamDisplayRows(win, 3);
  assert.equal(rendered.hidden, 2);
  assert.equal(rendered.rows[0], "… 2 lines hidden above");
  assert.deepEqual(rendered.rows.slice(1), ["c", "d"]);

  const fromSnap = agentStreamWindowFromSnapshot({ lines: ["a", "b", "c", "d"], pendingLine: "e" }, 2);
  assert.deepEqual(fromSnap.lines, ["c", "d"]);
  assert.equal(fromSnap.pendingLine, "e");
  assert.equal(fromSnap.hidden, 2);
}

// --- hub events + snapshot ---
{
  const hub = new AgentStreamHub();
  const bus = createAgentEventBus();
  hub.setEventBus(bus);
  /** @type {import("../dist/dev.mjs").AgentStreamEvent[]} */
  const events = [];
  const unsub = bus.on("session:summary", (event) => events.push(event.payload));

  const key = agentStreamKey("task", "tc-1");
  hub.reset({ source: "task", toolCallId: "tc-1" });
  hub.append(key, "line1\nline2");
  hub.end(key);

  assert.equal(events[0]?.type, "reset");
  assert.equal(events[1]?.type, "append");
  assert.equal(events[2]?.type, "end");

  const snap = hub.getSnapshot(key);
  assert.ok(snap);
  assert.equal(snap.status, "ended");
  assert.deepEqual(snap.lines, ["line1"]);
  assert.equal(snap.pendingLine, "line2");
  assert.ok(snap.seq >= 3);

  // Late append after end is ignored.
  hub.append(key, "\nignored");
  assert.equal(hub.getSnapshot(key)?.pendingLine, "line2");

  // Compact key is stable (agent-scoped singleton).
  hub.reset({ source: "compact", compactId: "agent_root" });
  const compactKey = agentStreamKey("compact", "agent_root");
  hub.append(compactKey, "compact text");
  assert.equal(hub.getSnapshot(compactKey)?.pendingLine, "compact text");
  assert.equal(hub.listSnapshots().length, 2);

  // Second compact reset reuses the same key (no zombie entries).
  hub.reset({ source: "compact", compactId: "agent_root" });
  assert.equal(hub.listSnapshots().filter((s) => s.source === "compact").length, 1);
  assert.equal(hub.getSnapshot(compactKey)?.status, "active");
  assert.equal(hub.getSnapshot(compactKey)?.pendingLine, "");

  // Command uses the same hub state machine, with stdout/stderr channels and the
  // existing `tool` transport projection.
  const chunks = [];
  const clears = [];
  const unsubChunks = bus.on("tool:chunk", (event) => chunks.push(event.payload));
  const unsubClear = bus.on("tool:clear", (event) => clears.push(event.payload));
  hub.appendCommand("cmd-1", "stdout", "a\nb");
  hub.appendCommand("cmd-1", "stderr", "err\n");
  assert.equal(hub.getSnapshot(agentStreamKey("command", "cmd-1", "stdout"))?.pendingLine, "b");
  assert.equal(hub.getSnapshot(agentStreamKey("command", "cmd-1", "stderr"))?.lines.length, 1);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].chunk.type, "stdout");
  assert.equal(chunks[1].chunk.type, "stderr");
  hub.clearCommand("cmd-1");
  assert.equal(hub.getSnapshot(agentStreamKey("command", "cmd-1", "stdout")), null);
  assert.equal(clears.length, 1);

  // clearCommand is retry semantics: it drops the settled tombstone so a re-executed
  // call with the same toolCallId can stream again.
  hub.appendCommand("cmd-retry", "stdout", "first\n");
  hub.endCommand("cmd-retry");
  assert.equal(hub.getSnapshot(agentStreamKey("command", "cmd-retry", "stdout"))?.status, "ended");
  hub.clearCommand("cmd-retry", { emit: false });
  hub.appendCommand("cmd-retry", "stdout", "second\n");
  assert.deepEqual(
    hub.getSnapshot(agentStreamKey("command", "cmd-retry", "stdout"))?.lines,
    ["second"],
    "clearCommand clears the closed-command tombstone for a retry"
  );
  hub.endCommand("cmd-retry");
  unsubChunks();
  unsubClear();
  unsub();
}

// --- compact epoch isolation ---
{
  const hub = new AgentStreamHub();
  const key = agentStreamKey("compact", "agent-epoch");
  hub.reset({ source: "compact", compactId: "agent-epoch", epoch: "old" });
  hub.append(key, "old-pass", { epoch: "old" });

  hub.reset({ source: "compact", compactId: "agent-epoch", epoch: "new" });
  hub.append(key, "stale", { epoch: "old" });
  assert.equal(
    hub.getSnapshot(key)?.pendingLine,
    "",
    "an old epoch's late chunk cannot append to an active new compaction"
  );

  hub.append(key, "fresh", { epoch: "new" });
  assert.equal(hub.getSnapshot(key)?.pendingLine, "fresh");
  hub.end(key);
  hub.append(key, "reopen", { epoch: "new" });
  assert.equal(hub.getSnapshot(key)?.status, "active", "same-epoch follow-up passes may reopen");
  assert.equal(hub.getSnapshot(key)?.pendingLine, "freshreopen");
  hub.end(key);
  hub.append(key, "old-again", { epoch: "old" });
  assert.equal(hub.getSnapshot(key)?.pendingLine, "freshreopen");
}

// --- generation guard + clear events ---
{
  const hub = new AgentStreamHub();
  const bus = createAgentEventBus();
  hub.setEventBus(bus);
  const summaryEvents = [];
  const toolClears = [];
  const unsubSummary = bus.on("session:summary", (event) => summaryEvents.push(event.payload));
  const unsubTool = bus.on("tool:clear", (event) => toolClears.push(event.payload));

  const oldGeneration = hub.getGeneration();
  hub.reset({ source: "task", toolCallId: "old-task", generation: oldGeneration });
  hub.append(agentStreamKey("task", "old-task"), "old", { generation: oldGeneration });
  hub.appendCommand("old-command", "stdout", "out\n");

  hub.clearAll();
  assert.equal(
    summaryEvents.some((event) => event.type === "end" && event.key === "task:old-task"),
    true
  );
  assert.deepEqual(toolClears, [{ kind: "clear", toolCallId: "old-command" }]);
  assert.equal(
    hub.reset({ source: "task", toolCallId: "old-task", generation: oldGeneration }),
    null,
    "a producer from a cleared generation cannot recreate a task stream"
  );
  assert.equal(hub.listSnapshots().length, 0);

  const currentGeneration = hub.getGeneration();
  const key = agentStreamKey("task", "new-task");
  hub.reset({ source: "task", toolCallId: "new-task", generation: currentGeneration });
  hub.append(key, "stale", { generation: oldGeneration });
  assert.equal(hub.getSnapshot(key)?.pendingLine, "");
  hub.append(key, "fresh", { generation: currentGeneration });
  assert.equal(hub.getSnapshot(key)?.pendingLine, "fresh");

  unsubSummary();
  unsubTool();
}

// --- clearAll clears pruned command buffers too ---
{
  const hub = new AgentStreamHub();
  const bus = createAgentEventBus();
  hub.setEventBus(bus);
  const clears = [];
  const unsub = bus.on("tool:clear", (event) => clears.push(event.payload.toolCallId));
  for (let i = 0; i < 18; i++) {
    hub.appendCommand(`pruned-${i}`, "stdout", "x\n");
    hub.endCommand(`pruned-${i}`);
  }
  assert.equal(hub.getSnapshot(agentStreamKey("command", "pruned-0", "stdout")), null);
  hub.clearAll();
  assert.equal(clears.includes("pruned-0"), true, "a pruned command still receives tool:clear");
  assert.equal(clears.includes("pruned-17"), true);
  unsub();
}

// --- reset / restore cleanup ---
{
  const hub = new AgentStreamHub();
  const taskKey = agentStreamKey("task", "task-cleanup");
  const compactKey = agentStreamKey("compact", "agent-cleanup");
  hub.reset({ source: "task", toolCallId: "task-cleanup" });
  hub.append(taskKey, "task text");
  hub.reset({ source: "compact", compactId: "agent-cleanup", epoch: "cleanup" });
  hub.append(compactKey, "compact text", { epoch: "cleanup" });
  hub.appendCommand("cmd-cleanup", "stdout", "out\n");

  hub.clearAll();
  assert.equal(hub.listSnapshots().length, 0, "clearAll drops command, task and compact streams");

  hub.appendCommand("cmd-cleanup", "stdout", "late\n");
  assert.equal(
    hub.getSnapshot(agentStreamKey("command", "cmd-cleanup", "stdout")),
    null,
    "clearAll keeps the command tombstone so an in-flight chunk cannot recreate a preview"
  );
}

// --- command previews: byte cap, bounded entry count, reset cleanup ---
{
  const hub = new AgentStreamHub();
  for (let i = 0; i < 700; i++) hub.appendCommand("long-command", "stdout", `line-${i}-${"x".repeat(400)}\n`);
  const long = hub.getSnapshot(agentStreamKey("command", "long-command", "stdout"));
  assert.ok(long && long.lines.length > 500, "command previews are not limited to the 500-line text snapshot cap");
  assert.ok(long.lines.length < 700, "the 256KB command cap still evicts old lines");
  hub.endCommand("long-command");
  assert.equal(
    hub.getSnapshot(agentStreamKey("command", "long-command", "stdout"))?.status,
    "ended",
    "a settled command is marked ended"
  );

  // Active commands are never evicted, even beyond the completed-command budget.
  for (let i = 0; i < 20; i++) {
    hub.appendCommand(`active-${i}`, "stdout", "x\n");
    hub.appendCommand(`active-${i}`, "stderr", "e\n");
  }
  assert.equal(
    hub.listSnapshots().filter((s) => s.source === "command" && s.status === "active").length,
    40,
    "active command previews are not pruned"
  );
  for (let i = 0; i < 20; i++) hub.endCommand(`active-${i}`);

  for (let i = 0; i < 20; i++) {
    hub.appendCommand(`cmd-${i}`, "stdout", "x\n");
    hub.appendCommand(`cmd-${i}`, "stderr", "e\n");
    hub.endCommand(`cmd-${i}`);
  }
  const completed = hub.listSnapshots().filter((s) => s.source === "command");
  const completedCommands = new Map();
  for (const snapshot of completed) {
    const group = completedCommands.get(snapshot.toolCallId) ?? [];
    group.push(snapshot.key);
    completedCommands.set(snapshot.toolCallId, group);
  }
  assert.ok(completedCommands.size <= 16, `completed commands are bounded, got ${completedCommands.size}`);
  for (const [toolCallId, keys] of completedCommands) {
    if (toolCallId.startsWith("cmd-")) {
      assert.equal(keys.length, 2, "stdout and stderr for one command are evicted together");
    }
  }

  hub.clearAll();
  assert.equal(hub.listSnapshots().filter((s) => s.source === "command").length, 0);

  const abandoned = new AgentStreamHub();
  abandoned.appendCommand("abandoned", "stdout", "partial\n");
  abandoned.appendCommand("abandoned", "stderr", "err\n");
  abandoned.endAllCommands();
  assert.deepEqual(
    abandoned.listSnapshots().map((s) => s.status),
    ["ended", "ended"],
    "an abandoned run settles its command streams instead of leaving them active"
  );

  // A late chunk after the completed command was pruned must not recreate it as active.
  const late = new AgentStreamHub();
  late.appendCommand("late-command", "stdout", "first\n");
  late.endCommand("late-command");
  for (let i = 0; i < 17; i++) {
    late.appendCommand(`fill-${i}`, "stdout", "x\n");
    late.endCommand(`fill-${i}`);
  }
  assert.equal(
    late.getSnapshot(agentStreamKey("command", "late-command", "stdout")),
    null,
    "the oldest completed command was pruned"
  );
  late.appendCommand("late-command", "stdout", "late chunk\n");
  assert.equal(
    late.getSnapshot(agentStreamKey("command", "late-command", "stdout")),
    null,
    "a late chunk cannot revive a settled command"
  );
}

console.log("agent-stream validation passed");
