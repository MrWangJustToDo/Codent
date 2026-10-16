/**
 * `AcpProjector` outbound contract — the shapes where the LAST writer decides what the client shows.
 *
 * The two subjects here look unrelated but share one failure mode: an update REPLACES the content the
 * client holds, so whatever a writer omits is what the user loses.
 *
 * 1. **Tool calls.** `content` carries the edit preview (a `diff`) and the result text, and TWO writers
 *    emit it — the call's own terminal transition and the result part — in the engine's order, not
 *    ours. Each has to carry both halves, and the preview itself goes out when the INPUT is resolvable
 *    rather than when the call ends: a result part that lands first moves the status, which makes the
 *    call's own transition a no-op, and the preview is then never sent at all.
 * 2. **Compaction.** `compaction_update` upserts by id and `compaction_summary_chunk` appends. Core
 *    reports a compaction through three different channels (the `state` status, the `summary` stream,
 *    `lifecycle`), so one compaction must come out as ONE id with a closed status — and a manual
 *    `/compact`, which emits no lifecycle event at all, is visible only through the status.
 *
 * Every check drives the real projector over a mock session. None of them is a unit test of a helper:
 * the helpers were already correct when the wiring dropped the preview (a unit `toolDiffFor` assertion
 * passed green while no `write_file` row ever carried a diff).
 *
 * Run: pnpm --filter @codent/acp run validate:acp:projection
 */

import { formatCompactionSummaryContent } from "@codent/core";

import { AcpProjector, toolLocationsFor } from "../dist/index.mjs";

import { createChecker, finish } from "./acp-report.mjs";

const checker = createChecker();
const check = checker.check;

// ===========================================================================
// A mock session + a capture of everything the projector emits
// ===========================================================================

/** Every `session/update` the projector emitted, in order. */
function capture(client = { compaction: true, notices: true }) {
  const listeners = new Set();
  const emitted = [];
  const session = {
    getSnapshot: () => ({ todos: [], mode: "normal", usage: undefined, name: "probe", messages: [] }),
    subscribe: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };
  const projector = new AcpProjector(session, {
    rootPath: "/ws",
    emit: (update) => emitted.push(update),
    commands: () => ({ builtin: [], extension: [] }),
    client,
  });
  projector.start();
  return {
    emitted,
    projector,
    push: (channel, payload) => {
      for (const listener of listeners) listener({ channel, payload, ts: Date.now() });
    },
    /** The content of the last update that carried any, i.e. what the client is left holding. */
    lastContent(toolCallId) {
      const withContent = emitted.filter(
        (u) => u.toolCallId === toolCallId && Array.isArray(u.content) && u.content.length > 0
      );
      return withContent[withContent.length - 1]?.content;
    },
    updates: (sessionUpdate) => emitted.filter((u) => u.sessionUpdate === sessionUpdate),
    stop: () => projector.stop(),
  };
}

// ===========================================================================
// 1. The edit preview survives whichever writer runs last
// ===========================================================================

{
  const INPUT = { path: "src/demo.ts", content: "export const x = 1;" };
  const callPart = (over) => ({
    id: "call-1",
    type: "tool-call",
    name: "write_file",
    arguments: '{"path":"src/demo.ts","content":"export const x = 1;"}',
    state: "complete",
    ...over,
  });
  // A `write_file` result: a separate part, which is what makes the two writers independent.
  const result = {
    id: "r1",
    role: "tool",
    parts: [
      {
        id: "call-1",
        type: "tool-result",
        toolCallId: "call-1",
        state: "complete",
        content: [{ type: "text", text: "wrote src/demo.ts" }],
      },
    ],
  };
  const assistant = (part) => [{ id: "a1", role: "assistant", parts: [part] }];

  // Order A — the result lands while the call part is still `input-complete`: the call's own terminal
  // transition is then a no-op (the status is already completed), which is how the preview vanished.
  const a = capture();
  a.push("messages", assistant(callPart({ state: "input-streaming", arguments: '{"path":"src/demo.ts","cont' })));
  a.push("messages", assistant(callPart({ state: "input-complete", input: INPUT })));
  a.push("messages", [...assistant(callPart({ state: "input-complete", input: INPUT })), result]);
  a.push("messages", [...assistant(callPart({ input: INPUT, output: { bytesWritten: 19, created: true } })), result]);
  const finalA = a.lastContent("call-1") ?? [];
  check(
    "order A: the row the client is left holding carries the edit preview",
    finalA.some((c) => c.type === "diff" && c.path === "/ws/src/demo.ts"),
    JSON.stringify(finalA.map((c) => c.type))
  );
  check(
    "order A: …and the result text, one not erasing the other",
    finalA.some((c) => c.type === "content"),
    JSON.stringify(finalA.map((c) => c.type))
  );

  // Order B — the call part reaches its terminal state first. The row must come out the same: that is
  // the property the fix is about, not the sequence.
  const b = capture();
  b.push("messages", assistant(callPart({ state: "input-streaming", arguments: '{"path":"src/demo.ts","cont' })));
  b.push("messages", assistant(callPart({ state: "input-complete", input: INPUT })));
  b.push("messages", assistant(callPart({ input: INPUT, output: { bytesWritten: 19, created: true } })));
  b.push("messages", [...assistant(callPart({ input: INPUT, output: { bytesWritten: 19, created: true } })), result]);
  const finalB = b.lastContent("call-1") ?? [];
  check(
    "order B: the same row, whichever writer ran last",
    finalB.some((c) => c.type === "diff") && finalB.some((c) => c.type === "content"),
    JSON.stringify(finalB.map((c) => c.type))
  );

  // The preview is a function of the input, so it goes out while the call is still running — waiting for
  // the terminal status is what made the row order-dependent in the first place.
  const previews = a
    .updates("tool_call_update")
    .filter((u) => u.toolCallId === "call-1" && (u.content ?? []).some((c) => c.type === "diff"));
  check(
    "the preview goes out before the call finishes",
    previews.some((u) => u.status === "in_progress" || u.status === "pending"),
    JSON.stringify(previews.map((u) => u.status))
  );

  // `messages` re-emits the whole array on every tick, so an unguarded preview would be re-sent per tick.
  const before = a.emitted.length;
  a.push("messages", [...assistant(callPart({ input: INPUT, output: { bytesWritten: 19, created: true } })), result]);
  check("re-reporting the same tick emits nothing new", a.emitted.length === before, `${before} → ${a.emitted.length}`);
  a.stop();
  b.stop();
}

// ===========================================================================
// 2. One compaction, one id, one closed status
// ===========================================================================

const statusEvent = (status) => ({ status, name: "probe", sessionId: "s1", error: "", pendingApprovalCount: 0 });
const compactKey = "compact:agent_1";

{
  // The capability gate: without it the protocol forbids every compaction update, so a full sequence
  // (status, stream, end) must emit none at all.
  const off = capture({ compaction: false, notices: true });
  off.push("state", statusEvent("compacting"));
  off.push("summary", { type: "reset", key: compactKey, source: "compact", compactId: "agent_1", epoch: "e1", seq: 1 });
  off.push("summary", { type: "append", key: compactKey, chunk: "sum", seq: 2 });
  off.push("summary", { type: "end", key: compactKey, seq: 3 });
  off.push("state", statusEvent("running"));
  check(
    "a client that never advertised `session.compaction` gets no compaction update",
    off.emitted.every((u) => !String(u.sessionUpdate).startsWith("compaction")),
    JSON.stringify(off.emitted.map((u) => u.sessionUpdate))
  );
  off.stop();

  // The automatic path, in the order core actually produces it: `beginCompaction` sets the status
  // first, then the summarizer's stream starts.
  const auto = capture();
  auto.push("state", statusEvent("compacting"));
  auto.push("summary", {
    type: "reset",
    key: compactKey,
    source: "compact",
    compactId: "agent_1",
    epoch: "e1",
    seq: 1,
  });
  auto.push("summary", { type: "append", key: compactKey, chunk: "[summary]", seq: 2 });
  auto.push("summary", { type: "append", key: compactKey, chunk: " part 2", seq: 3 });
  auto.push("summary", { type: "end", key: compactKey, seq: 4 });
  auto.push("state", statusEvent("running"));

  const updates = auto.updates("compaction_update");
  check(
    "a compaction is announced in progress",
    updates[0]?.status === "in_progress",
    JSON.stringify(updates.map((u) => u.status))
  );
  check(
    "…once: the summary stream reuses the row the status opened, it does not open a second",
    new Set(updates.map((u) => u.compactionId)).size === 1,
    JSON.stringify(updates.map((u) => u.compactionId))
  );
  check(
    "the summary streams as chunks, in order, against that id",
    JSON.stringify(auto.updates("compaction_summary_chunk").map((u) => u.content.text)) ===
      JSON.stringify(["[summary]", " part 2"]) &&
      auto.updates("compaction_summary_chunk").every((u) => u.compactionId === updates[0].compactionId),
    JSON.stringify(auto.updates("compaction_summary_chunk").map((u) => u.content.text))
  );
  check(
    "the row closes as completed with the summary the chunks built",
    updates.at(-1)?.status === "completed" && updates.at(-1)?.summary?.[0]?.text === "[summary] part 2",
    JSON.stringify(updates.at(-1))
  );
  check(
    "…and nothing is emitted after the close (the status leaves `compacting` next)",
    auto.updates("compaction_update").length === updates.length,
    JSON.stringify(auto.updates("compaction_update").map((u) => u.status))
  );
  check(
    "a task summary is not a compaction",
    (() => {
      const t = capture();
      t.push("summary", { type: "reset", key: "task:tc1", source: "task", toolCallId: "tc1", seq: 1 });
      t.push("summary", { type: "append", key: "task:tc1", chunk: "task text", seq: 2 });
      t.push("summary", { type: "end", key: "task:tc1", seq: 3 });
      const ok = t.emitted.every((u) => !String(u.sessionUpdate).startsWith("compaction"));
      t.stop();
      return ok;
    })()
  );
  auto.stop();

  // A manual `/compact` emits NO lifecycle event and (when the model returns text) still streams the
  // summary; the status is what makes it visible at all.
  const manual = capture();
  manual.push("state", statusEvent("compacting"));
  manual.push("state", statusEvent("running"));
  const manualUpdates = manual.updates("compaction_update");
  check(
    "a manual `/compact` is visible through the status alone (it emits no lifecycle event)",
    manualUpdates.map((u) => u.status).join(",") === "in_progress,completed",
    JSON.stringify(manualUpdates.map((u) => u.status))
  );
  manual.stop();

  // Two compactions are two rows: the id is the protocol's upsert key, so reusing one row would tell
  // the client that the second compaction is a patch to the first.
  const twice = capture();
  twice.push("state", statusEvent("compacting"));
  twice.push("state", statusEvent("running"));
  twice.push("state", statusEvent("compacting"));
  twice.push("state", statusEvent("running"));
  check(
    "each compaction gets its own row",
    new Set(twice.updates("compaction_update").map((u) => u.compactionId)).size === 2,
    JSON.stringify(twice.updates("compaction_update").map((u) => u.compactionId))
  );
  twice.stop();

  // Abort and failure: neither produces a summary `end`, and an open row would sit there forever.
  const aborted = capture();
  aborted.push("state", statusEvent("compacting"));
  aborted.push("state", statusEvent("aborted"));
  check(
    "an aborted compaction closes as cancelled",
    aborted.updates("compaction_update").at(-1)?.status === "cancelled",
    JSON.stringify(aborted.updates("compaction_update").map((u) => u.status))
  );
  aborted.stop();

  const failed = capture();
  failed.push("state", statusEvent("compacting"));
  failed.push("lifecycle", { type: "compaction:auto-error", error: "summarizer died" });
  const failure = failed.updates("compaction_update").at(-1);
  check(
    "a failed compaction closes as failed, carrying the reason",
    failure?.status === "failed" && failure?.error === "summarizer died",
    JSON.stringify(failure)
  );
  failed.stop();

  // A completion whose own summary stream was never seen still has to reach the client: that is the
  // shape the very first version of this supported, and dropping it would lose the row entirely.
  const orphan = capture();
  orphan.push("lifecycle", { type: "compaction:reactive-complete" });
  check(
    "a completion with no row of ours still reports one",
    orphan.updates("compaction_update").at(-1)?.status === "completed",
    JSON.stringify(orphan.updates("compaction_update"))
  );
  orphan.stop();
}

// ===========================================================================
// 3. A compaction summary is not a user turn
// ===========================================================================
//
// The summary lives on the channel as a `role: "user"` message because that is how the MODEL gets it.
// Replaying it as one showed the whole body as if the user had typed it (reported for `session/load`),
// so it is projected where the protocol puts compaction — the compaction row — and a client without
// that capability gets one line instead of the body.
{
  const summaryMessage = {
    id: "msg_summary_1",
    role: "user",
    parts: [{ type: "text", content: formatCompactionSummaryContent("Goal: ship the thing.") }],
  };
  const plainUser = { id: "msg_user_1", role: "user", parts: [{ type: "text", content: "hello" }] };
  const snapshot = (messages) => ({ todos: [], mode: "normal", usage: undefined, name: "probe", messages });

  const capable = capture();
  capable.projector.replayFrom(snapshot([plainUser, summaryMessage]));
  const userChunks = capable.updates("user_message_chunk");
  check(
    "a replayed compaction summary is NOT a user turn",
    userChunks.every((u) => !(u.content?.text ?? "").includes("[CONVERSATION SUMMARY]")),
    JSON.stringify(userChunks.map((u) => u.content?.text?.slice(0, 40)))
  );
  check(
    "…an ordinary user turn still is",
    userChunks.some((u) => u.messageId === "msg_user_1")
  );
  const rows = capable.updates("compaction_update");
  check(
    "…it is the compaction row, keyed by the message id (stable across reloads)",
    rows.length === 1 && rows[0].compactionId === "msg_summary_1" && rows[0].status === "completed",
    JSON.stringify(rows)
  );
  check(
    "…carrying the body WITHOUT the markers (the row's summary is the text, not the wrapper)",
    rows[0]?.summary?.[0]?.text === "Goal: ship the thing.",
    JSON.stringify(rows[0]?.summary)
  );
  capable.stop();

  // No capability: still not a user turn. One line, so the compaction is not invisible — the body is
  // model context, and a reader needs the position, not thousands of tokens of summary.
  const plain = capture({ compaction: false, notices: true });
  plain.projector.replayFrom(snapshot([summaryMessage]));
  check(
    "without `session.compaction` the summary is a one-line notice, not a user turn",
    plain.updates("user_message_chunk").length === 0 &&
      plain.updates("agent_message_chunk").length === 1 &&
      plain.updates("compaction_update").length === 0,
    JSON.stringify(plain.emitted.map((u) => u.sessionUpdate))
  );
  plain.stop();
}

// ===========================================================================
// 4. A live compaction is visible without the capability too
// ===========================================================================

{
  const off = capture({ compaction: false, notices: true });
  off.push("state", { status: "compacting", name: "probe", sessionId: "s1", error: "", pendingApprovalCount: 0 });
  off.push("summary", {
    type: "reset",
    key: "compact:agent_1",
    source: "compact",
    compactId: "agent_1",
    epoch: "e1",
    seq: 1,
  });
  off.push("summary", { type: "append", key: "compact:agent_1", chunk: "body text", seq: 2 });
  off.push("summary", { type: "end", key: "compact:agent_1", seq: 3 });
  off.push("state", { status: "running", name: "probe", sessionId: "s1", error: "", pendingApprovalCount: 0 });
  check(
    "a non-rendering client gets exactly one notice, and no compaction updates",
    off.updates("agent_message_chunk").length === 1 && off.updates("compaction_update").length === 0,
    JSON.stringify(off.emitted.map((u) => u.sessionUpdate))
  );
  check(
    "…and the notice stands in the transcript where the compaction happened",
    (off.updates("agent_message_chunk")[0]?.content?.text ?? "").includes("Context compacted"),
    JSON.stringify(off.updates("agent_message_chunk")[0]?.content)
  );
  off.stop();
}

// ===========================================================================
// 5. `locations[].line` — what a client follows the agent with
// ===========================================================================
{
  check(
    "read_file's 0-based offset becomes a 1-based line",
    JSON.stringify(toolLocationsFor({ path: "src/a.ts", offset: 10 }, "/ws")) ===
      JSON.stringify([{ path: "/ws/src/a.ts", line: 11 }]),
    JSON.stringify(toolLocationsFor({ path: "src/a.ts", offset: 10 }, "/ws"))
  );
  check(
    "an LSP tool's 0-based line too",
    JSON.stringify(toolLocationsFor({ path: "src/a.ts", line: 3 }, "/ws")) ===
      JSON.stringify([{ path: "/ws/src/a.ts", line: 4 }]),
    JSON.stringify(toolLocationsFor({ path: "src/a.ts", line: 3 }, "/ws"))
  );
  check(
    "no position ⇒ no line (a fabricated one would jump somewhere wrong)",
    JSON.stringify(toolLocationsFor({ path: "src/a.ts" }, "/ws")) === JSON.stringify([{ path: "/ws/src/a.ts" }])
  );
  check(
    "a multi-path input attaches the line only to the primary path",
    JSON.stringify(toolLocationsFor({ path: "src/a.ts", paths: ["src/b.ts"], offset: 0 }, "/ws")) ===
      JSON.stringify([{ path: "/ws/src/a.ts", line: 1 }, { path: "/ws/src/b.ts" }]),
    JSON.stringify(toolLocationsFor({ path: "src/a.ts", paths: ["src/b.ts"], offset: 0 }, "/ws"))
  );
}

finish(checker.failures);
