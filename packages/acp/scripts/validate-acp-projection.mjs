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

import {
  buildElicitationRequest,
  mapElicitationResponse,
  sessionConfigOptions,
  toolLocationsFor,
} from "../dist/index.mjs";

import { createChecker, finish } from "./acp-report.mjs";
import { capture, schemaFailures, zod } from "./acp-scenario.mjs";

const checker = createChecker();
const check = checker.check;

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
  // The RESULT writer must follow the terminal transition's rule: content OR rawOutput, never both.
  // Sending both put the tool's raw JSON (path / oldString / newString) under the diff the client had
  // already rendered — reported as "the edit row shows its diff twice".
  const lastUpdate = a.updates("tool_call_update").at(-1);
  check(
    "a result that carries content does not also dump rawOutput",
    lastUpdate?.content !== undefined && lastUpdate?.rawOutput === undefined,
    JSON.stringify({
      content: lastUpdate?.content?.map((c) => c.type),
      hasRawOutput: lastUpdate?.rawOutput !== undefined,
    })
  );
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

// ===========================================================================
// 6. Media on the wire, and the command argument hint
// ===========================================================================
//
// `ContentBlock` is `text | image | audio | resource_link | embedded_resource`, and we sent only text.
// Two places lost real content because of it: a tool that returns an image (`read_file` of a
// screenshot) reached the client as an empty row, and a user attachment disappeared from history on
// `session/load` (only the replay can carry it back — the live row is the client's own).
{
  // The shapes below are COPIED FROM A REAL SESSION (`.agents/sessions/ses_mv153klh_d4xgti.session.jsonl`,
  // a `read_file` of a screenshot), because this section's first version tested a shape nothing
  // produces: a `tool-result.content` ARRAY. On the real path the result part carries
  // `content: '<json string>'` — never an array — and the bytes live on the tool-CALL part's `output`.
  // The assertion passed while the client's row stayed blank, which is exactly what a fixture that
  // guesses gets you.
  const IMAGE = { type: "image", path: "src/shot.png", mimeType: "image/png", base64: "QUJD", size: 3 };
  // The call part, as persisted: `output` is the tool's own return value, with the engine's envelope
  // (`durationMs`, `cachedOutputPath`) around it.
  const callPart = {
    id: "call-1",
    type: "tool-call",
    name: "read_file",
    arguments: '{"path":"src/shot.png"}',
    state: "complete",
    input: { path: "src/shot.png" },
    output: { ...IMAGE, durationMs: 12, cachedOutputPath: null },
  };
  // The result part, as persisted: `content` is the JSON STRING of what the tool returned.
  const resultPart = {
    id: "r1",
    type: "tool-result",
    toolCallId: "call-1",
    state: "complete",
    content: JSON.stringify(IMAGE),
  };

  const imagesOf = (c) => c.flatMap((x) => (x.type === "content" ? [x.content] : [])).filter((b) => b.type === "image");
  const textsOf = (c) => c.flatMap((x) => (x.type === "content" && x.content.type === "text" ? [x.content.text] : []));

  // (a) The persisted shape — what a replayed/restored session gives the projector.
  const persisted = capture();
  persisted.push("messages", [{ id: "a1", role: "assistant", parts: [callPart] }]);
  persisted.push("messages", [{ id: "a1", role: "assistant", parts: [callPart, resultPart] }]);
  const pContent = persisted.lastContent("call-1") ?? [];
  const pImage = imagesOf(pContent)[0];
  check(
    "a persisted tool result (content is a JSON string) still carries its image",
    pImage?.type === "image" && pImage.data === "QUJD" && pImage.mimeType === "image/png",
    JSON.stringify(pContent.map((c) => c.type + "/" + (c.content?.type ?? "?")))
  );
  // The counter-assertion, and the one that would have caught the original bug: the bytes must NOT
  // arrive as the row's text. `toolResultText` used to `JSON.stringify` an object result, so the whole
  // base64 payload was rendered where a human reads — a wall of noise next to a blank preview.
  check(
    "…and its bytes are NOT leaked as the row's text",
    !textsOf(pContent).some((t) => t.includes("QUJD")),
    JSON.stringify(textsOf(pContent).map((t) => t.slice(0, 60)))
  );
  persisted.stop();

  // (b) The live shape — `content` is a ContentPart[] here. Both doors have to work, and the same
  // image arriving through BOTH must not land twice: the result's `output` and its `content` are two
  // views of one tool call, and a client renders every chunk it is handed.
  const live = capture();
  const liveResult = {
    ...resultPart,
    output: { ...IMAGE, durationMs: 12 },
    content: [{ type: "text", text: "read src/shot.png" }, IMAGE],
  };
  live.push("messages", [{ id: "a1", role: "assistant", parts: [callPart] }]);
  live.push("messages", [{ id: "a1", role: "assistant", parts: [callPart, liveResult] }]);
  const liveContent = live.lastContent("call-1") ?? [];
  check(
    "a live tool result (content is a ContentPart[]) carries its image",
    imagesOf(liveContent)[0]?.data === "QUJD",
    JSON.stringify(liveContent.map((c) => c.type + "/" + (c.content?.type ?? "?")))
  );
  check(
    "…alongside the text, not instead of it",
    textsOf(liveContent).some((t) => t.includes("read src/shot.png")),
    JSON.stringify(liveContent.map((c) => c.type + "/" + (c.content?.type ?? "?")))
  );
  check(
    "…exactly once, though output and content both hold it",
    imagesOf(liveContent).length === 1,
    JSON.stringify(imagesOf(liveContent).map((b) => b.data))
  );
  live.stop();

  // (c) The transition writer's path: the CALL part is the only thing that has run, and it already
  // carries the result in `output` (the real shape — `read_file` puts the image there). This is the
  // case the `output` door exists for, and it fires when the status MOVES, which is why the tick is
  // driven twice: `pending` first, then the terminal state the tool actually reached.
  const moved = capture();
  const pending = { ...callPart, state: "input-complete", output: undefined };
  const done = { ...callPart, state: "complete" };
  moved.push("messages", [{ id: "a1", role: "assistant", parts: [pending] }]);
  moved.push("messages", [{ id: "a1", role: "assistant", parts: [done] }]);
  const movedContent = moved.lastContent("call-1") ?? [];
  check(
    "an image on the call's own output still reaches the client (no result part yet)",
    imagesOf(movedContent)[0]?.data === "QUJD",
    JSON.stringify(movedContent.map((c) => c.type + "/" + (c.content?.type ?? "?")))
  );
  moved.stop();

  // (d) A result that carries no image must not grow one, and its text survives — as the JSON it is.
  // `run_command` / `grep` / `read_file` results are JSON strings in every session on disk
  // (`{"command":…,"stdout":…}`, `{"matches":[…]}`, `{"type":"text","content":…}`), so "an object
  // result is not text" would empty those rows. The rule is narrower: bytes are not text.
  const plain = capture();
  const plainCall = { ...callPart, output: { success: true, content: "wrote 3 lines", durationMs: 1 } };
  const plainResult = { ...resultPart, content: '{"command":"wc -l x.ts","stdout":"3 x.ts"}' };
  plain.push("messages", [{ id: "a1", role: "assistant", parts: [plainCall] }]);
  plain.push("messages", [{ id: "a1", role: "assistant", parts: [plainCall, plainResult] }]);
  const plainContent = plain.lastContent("call-1") ?? [];
  check(
    "a result with no image keeps its text and gains no image block",
    imagesOf(plainContent).length === 0 && textsOf(plainContent).some((t) => t.includes('"stdout":"3 x.ts"')),
    JSON.stringify(plainContent.map((c) => c.type + "/" + (c.content?.type ?? "?")))
  );
  plain.stop();

  // (e) A live `ContentPart[]` text result still renders its text entries (the array door).
  const arr = capture();
  const arrResult = { ...resultPart, content: [{ type: "text", text: "Fetched image: https://x/y.png" }] };
  arr.push("messages", [{ id: "a1", role: "assistant", parts: [callPart] }]);
  arr.push("messages", [{ id: "a1", role: "assistant", parts: [callPart, arrResult] }]);
  const arrContent = arr.lastContent("call-1") ?? [];
  check(
    "an array result renders its text part, not its JSON",
    textsOf(arrContent).some((t) => t.includes("Fetched image") && !t.includes('"type"')),
    JSON.stringify(textsOf(arrContent))
  );
  arr.stop();

  // A user attachment, on replay. The hydrated shape is a data URL; the data-URL prefix is not part of
  // ACP's base64 payload, so it must be stripped (core owns that parsing).
  const attach = capture();
  attach.projector.replayFrom({
    todos: [],
    mode: "normal",
    usage: undefined,
    name: "probe",
    messages: [
      {
        id: "msg_img",
        role: "user",
        parts: [
          { type: "text", content: "look at this" },
          { type: "image", source: { type: "data", value: "data:image/png;base64,QUJD", mimeType: "image/png" } },
        ],
      },
    ],
  });
  const chunks = attach.updates("user_message_chunk");
  check(
    "a replayed attachment carries its bytes (prefix stripped, same messageId as the text)",
    chunks.length === 2 &&
      chunks[1].content.type === "image" &&
      chunks[1].content.data === "QUJD" &&
      chunks[1].messageId === "msg_img",
    JSON.stringify(chunks.map((u) => [u.content.type, u.content.data ?? u.content.text]))
  );
  attach.stop();

  // An un-hydrated ref is NOT an image: sending `media://…` as base64 would render a broken image, and
  // this layer cannot read the store.
  const refOnly = capture();
  refOnly.projector.replayFrom({
    todos: [],
    mode: "normal",
    usage: undefined,
    name: "probe",
    messages: [
      {
        id: "msg_ref",
        role: "user",
        parts: [{ type: "image", source: { value: "media://abc.png", mimeType: "image/png" } }],
      },
    ],
  });
  check(
    "an un-hydratable `media://` ref is dropped rather than sent as a broken image",
    refOnly.updates("user_message_chunk").length === 0,
    JSON.stringify(refOnly.emitted.map((u) => u.sessionUpdate))
  );
  refOnly.stop();

  // The catalog's `usage` becomes the protocol's `input.hint`; a command with no arguments has none.
  const commands = capture({ compaction: true, notices: true }, () => ({
    builtin: [
      { name: "compact", description: "Compress conversation context" },
      { name: "clear", description: "Clear the conversation" },
    ],
    extension: [{ name: "ext_echo", description: "echo" }],
  }));
  const advertised = commands.updates("available_commands_update").at(-1)?.availableCommands ?? [];
  const compact = advertised.find((c) => c.name === "compact");
  const clear = advertised.find((c) => c.name === "clear");
  check(
    "a command that takes arguments advertises the hint the catalog already declares",
    compact?.input?.hint === "[focus]",
    JSON.stringify(compact)
  );
  check("…and one that takes none advertises no input", clear?.input === undefined, JSON.stringify(clear));
  commands.stop();
}

// ===========================================================================
// 7. Thinking shares its turn's messageId, and a replay keeps part order
// ===========================================================================
//
// Reported from Zed: after a reconnect the thinking appeared AFTER the reply, and a thought arrived
// twice. The protocol is explicit about the cause of the first: "All chunks belonging to the same
// message share the same `messageId`. A change in `messageId` indicates a new message has started."
// We were sending thinking under a SECOND id (`<id>-thought`), so every turn was two messages — and the
// replay emitted them grouped by kind (text, then thinking, then calls), so the second message landed
// after the reply. Zed's own adapter (`@zed-industries/claude-code-acp`) never invents an id (it sends
// none at all) and replays through the same mapping it streams live, so its order is the message's.
// Measured over three real sessions before this change: the live path emitted each thought exactly once
// (no shrink and no rewritten prefix across 4000+ successive message snapshots), so the duplicate was on
// the replay path — which re-sent content the client already had with a different messageId.
{
  const messages = [
    {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "thinking", content: "first thought" },
        { type: "tool-call", id: "call-1", name: "read_file", arguments: '{"path":"a.ts"}', state: "complete" },
        { type: "text", content: "answer" },
        { type: "thinking", content: " and more" },
      ],
    },
  ];
  const c = capture();
  c.projector.replayFrom({ todos: [], mode: "normal", usage: undefined, name: "probe", messages });
  for (let i = 0; i < 3; i++) c.push("messages", messages);

  const kinds = c.emitted
    .filter((u) => ["agent_thought_chunk", "agent_message_chunk"].includes(u.sessionUpdate))
    .map((u) => (u.sessionUpdate === "agent_thought_chunk" ? "thought" : "text"));
  check(
    "a replay keeps the message's own part order (thinking → tool call → text → thinking)",
    JSON.stringify(kinds) === JSON.stringify(["thought", "text", "thought"]),
    JSON.stringify(kinds)
  );
  const chunks = c.emitted.filter((u) => ["agent_thought_chunk", "agent_message_chunk"].includes(u.sessionUpdate));
  check(
    "every chunk of a turn shares its messageId (a changed id IS a new message)",
    chunks.every((u) => u.messageId === "a1"),
    JSON.stringify(chunks.map((u) => u.messageId))
  );
  check(
    "the tool call is reported at its own position, not after the text",
    (() => {
      const seq = c.emitted
        .filter((u) => ["agent_thought_chunk", "agent_message_chunk", "tool_call"].includes(u.sessionUpdate))
        .map((u) => u.sessionUpdate);
      return seq.indexOf("tool_call") === 1;
    })(),
    JSON.stringify(c.emitted.map((u) => u.sessionUpdate))
  );
  check(
    "thinking is streamed once per part, and three redundant ticks add nothing",
    chunks.filter((u) => u.sessionUpdate === "agent_thought_chunk").length === 2,
    JSON.stringify(chunks.map((u) => u.sessionUpdate))
  );
  check(
    "the parts arrive in order and are concatenated by the client",
    (() => {
      const thoughts = chunks.filter((u) => u.sessionUpdate === "agent_thought_chunk");
      return thoughts[0].content.text === "first thought" && thoughts[1].content.text === " and more";
    })()
  );
}

// ===========================================================================
// 8. Conformance: every payload against the SDK's own schema
// ===========================================================================
{
  check(
    "every `session/update` this host emitted passes the protocol's schema",
    schemaFailures.length === 0,
    schemaFailures.slice(0, 3).join(" | ")
  );

  // The `session/new` / `load` response carries the selectors a client renders; they are built by hand
  // (there is no `session/set_model` in this protocol), so the schema is the check that they are the
  // protocol's shape and not merely ours.
  const snapshot = {
    todos: [],
    mode: "normal",
    usage: undefined,
    name: "probe",
    model: "anthropic/claude-3.5-sonnet",
    messages: [],
  };
  const withCatalog = {
    sessionId: "s1",
    configOptions: sessionConfigOptions(snapshot, [
      { index: 0, style: "anthropic", models: ["anthropic/claude-3.5-sonnet"] },
    ]),
  };
  const withoutCatalog = { sessionId: "s1", configOptions: sessionConfigOptions(snapshot, undefined) };
  const withCatalogParsed = zod.zNewSessionResponse.safeParse(withCatalog);
  const withoutCatalogParsed = zod.zNewSessionResponse.safeParse(withoutCatalog);
  check(
    "a `session/new` response with both selectors passes the schema",
    withCatalogParsed.success,
    withCatalogParsed.success ? "" : JSON.stringify(withCatalogParsed.error.issues.slice(0, 3))
  );
  check(
    "…and with no catalog it drops the model option rather than advertising a fake choice",
    withoutCatalogParsed.success && withoutCatalog.configOptions.length === 1,
    JSON.stringify(withoutCatalog.configOptions.map((o) => o.id))
  );
}

// ===========================================================================
// 9. A replaced (shorter) thought is NOT re-sent
// ===========================================================================
//
// When the thinking phase ends, the engine replaces the streamed reasoning with its final (shorter)
// version. ACP chunks are append-only — a chunk cannot be retracted — so re-sending the replacement
// under the same `messageId` appends the whole text a second time, which is the duplicated thinking a
// client showed at exactly that moment. Reported from Zed after a session restore: a new turn's
// thinking arrived twice, once as it streamed and once when it finished.
{
  const c = capture();
  const message = (thinking) => [{ id: "a1", role: "assistant", parts: [{ type: "thinking", content: thinking }] }];
  c.push("messages", message("streamed reasoning that turned out longer"));
  c.push("messages", message("final reasoning"));
  const thoughts = c.updates("agent_thought_chunk");
  check(
    "a shrinking thought is not re-sent (append-only chunks cannot replace)",
    thoughts.length === 1 && thoughts[0].content.text === "streamed reasoning that turned out longer",
    JSON.stringify(thoughts.map((u) => u.content.text))
  );
  // The cursor caught up: growth after the replacement streams only the new tail, never the whole text.
  c.push("messages", message("final reasoning plus more"));
  const after = c.updates("agent_thought_chunk");
  check(
    "…and growth after it streams only the tail",
    after.length === 2 && after[1].content.text === " plus more",
    JSON.stringify(after.map((u) => u.content.text))
  );
  c.stop();
}

// ===========================================================================
// 10. `ask_user` keeps the free-form answer the TUI offers
// ===========================================================================
//
// The tool's contract is "the user can still provide a free-form answer", and the TUI gives them a text
// field next to the options. A form whose only field is an `enum` takes that away — the client can render
// buttons and nothing else — so the options carry a companion string, and a typed answer outranks the
// selection (and is reported as the answer's `draft`).
{
  const withOptions = buildElicitationRequest("s1", { toolCallId: "c1", question: "Pick", options: ["a", "b"] });
  const properties = withOptions.requestedSchema.properties ?? {};
  check(
    "an options question also offers a free-form field",
    properties.custom?.type === "string" && Array.isArray(properties.answer?.enum),
    JSON.stringify(Object.keys(properties))
  );
  check(
    "…and passes the protocol's own elicitation schema",
    (() => {
      const parsed = zod.zCreateElicitationRequest.safeParse(withOptions);
      return parsed.success ? true : JSON.stringify(parsed.error.issues.slice(0, 2));
    })() === true
  );
  check(
    "a typed answer becomes the answer AND the draft (not the selected option)",
    JSON.stringify(mapElicitationResponse({ action: "accept", content: { answer: "a", custom: "my own" } })) ===
      JSON.stringify({ answer: "my own", draft: "my own" }),
    JSON.stringify(mapElicitationResponse({ action: "accept", content: { answer: "a", custom: "my own" } }))
  );
  check(
    "a selection still maps to the option, with no draft",
    JSON.stringify(mapElicitationResponse({ action: "accept", content: { answer: "a" } })) ===
      JSON.stringify({ answer: "a" })
  );
  check(
    "a multi-select answer keeps its selected list",
    JSON.stringify(mapElicitationResponse({ action: "accept", content: { answer: ["a", "b"] } })) ===
      JSON.stringify({ answer: "a, b", selected: ["a", "b"] })
  );
  // Ticking options AND typing is not either/or: dropping the ticks was reported as "only my typing was
  // sent", and the model then cannot tell which predefined answers were chosen.
  check(
    "…and a typed answer is an ADDITIONAL entry, not a replacement",
    JSON.stringify(mapElicitationResponse({ action: "accept", content: { answer: ["a", "b"], custom: "mine" } })) ===
      JSON.stringify({ answer: "a, b, mine", selected: ["a", "b"], draft: "mine" }),
    JSON.stringify(mapElicitationResponse({ action: "accept", content: { answer: ["a", "b"], custom: "mine" } }))
  );
  // The question is the form's `message`; a field title repeating it rendered the question twice in Zed.
  check(
    "the question is not repeated in the field labels",
    withOptions.message === "Pick" && properties.answer?.title !== "Pick" && properties.custom?.title !== "Pick",
    JSON.stringify({ message: withOptions.message, labels: [properties.answer?.title, properties.custom?.title] })
  );
  const noOptions = buildElicitationRequest("s1", { toolCallId: "c2", question: "Why?" });
  const plain = noOptions.requestedSchema.properties?.answer ?? {};
  check(
    "a question with no options is plain free text",
    plain.type === "string" && !Array.isArray(plain.enum),
    JSON.stringify(plain)
  );
  check(
    "declining an elicitation is a null answer, not an empty string",
    mapElicitationResponse({ action: "decline" }) === null
  );
}

finish(checker.failures);
