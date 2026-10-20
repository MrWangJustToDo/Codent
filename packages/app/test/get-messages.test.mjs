/**
 * Validates the static display pipeline (`getMessages`): flattening messages into
 * transcript rows plus the flat-message cache, which must invalidate whenever a
 * row's content changes under a stable id.
 *
 * Run: node packages/app/test/get-messages.test.mjs
 *
 * Regression (flat cache): the compact activity summary keeps a content-independent
 * synthetic id (`display-activity:<userMessageId>:<seq>`) while its text grows as
 * more tools fold in. With an id + tool-only fingerprint, the cache served the very
 * first render forever, so the folded tool area never updated.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL } from "node:url";

import { computeMessageRenderSignature } from "../dist/index.mjs";
import { countSourceMessages, getMessages } from "../dist/utils/get-messages.mjs";

function textMsg(id, role, content) {
  return { id, role, parts: [{ type: "text", content }] };
}

function toolMsg(id, tools) {
  return {
    id,
    role: "assistant",
    parts: tools.map((t) => ({
      type: "tool-call",
      id: t.id,
      name: t.name,
      state: t.state ?? "complete",
      arguments: t.arguments ?? "{}",
      output: t.output,
    })),
  };
}

const readFile = (id) => ({ id, name: "read_file", arguments: JSON.stringify({ file_path: `${id}.ts` }), output: {} });
const user = textMsg("u1", "user", "fix the bug");
const final = (id) => textMsg(id, "assistant", "Done.");

const rowText = (message) => (message?.parts[0]?.type === "text" ? message.parts[0].content : "");
const summaryRow = (result) => result.staticMessages.find((m) => m.id.startsWith("display-activity:"));
const sig = (message) => computeMessageRenderSignature(message);

// ---------------------------------------------------------------------------
// 1. The signature covers content, not only tool state
// ---------------------------------------------------------------------------
assert.notEqual(
  sig(textMsg("a1", "assistant", "Done.")),
  sig(textMsg("a1", "assistant", "Done, and then some.")),
  "text content must be part of the signature"
);
assert.equal(
  sig(textMsg("a1", "assistant", "Done.")),
  sig(textMsg("a1", "assistant", "Done.")),
  "equal content ⇒ equal signature"
);
assert.notEqual(sig(textMsg("x", "user", "hi")), sig(textMsg("x", "assistant", "hi")), "role must be part of it");
assert.notEqual(
  sig(toolMsg("a1", [{ id: "t1", name: "read_file", output: {} }])),
  sig(toolMsg("a1", [{ id: "t1", name: "read_file", state: "input-streaming" }])),
  "tool state must stay part of it"
);
// Large parts are compared by a bounded head+tail digest — growth still invalidates.
const longText = "x".repeat(20000);
assert.notEqual(
  sig(textMsg("a1", "assistant", longText)),
  sig(textMsg("a1", "assistant", `${longText}y`)),
  "appended text must invalidate a large row"
);

// ---------------------------------------------------------------------------
// 2. Regression: the folded tool area follows the folded run
// ---------------------------------------------------------------------------
const first = getMessages([user, toolMsg("a1", [readFile("t1")]), final("a2")], { mode: "compact" });
assert.equal(rowText(summaryRow(first)), "Explored 1 file", "single folded tool");

const second = getMessages(
  [user, toolMsg("a1", [readFile("t1")]), toolMsg("a2", [readFile("t2"), readFile("t3")]), final("a3")],
  { mode: "compact" }
);
assert.equal(summaryRow(second).id, summaryRow(first).id, "the synthetic summary keeps its id across projections");
assert.equal(rowText(summaryRow(second)), "Explored 3 files", "the summary row must follow the folded run");

// ---------------------------------------------------------------------------
// 3. The cache still short-circuits unchanged rows (same object, no re-flatten)
// ---------------------------------------------------------------------------
const again = getMessages(
  [user, toolMsg("a1", [readFile("t1")]), toolMsg("a2", [readFile("t2"), readFile("t3")]), final("a3")],
  { mode: "compact" }
);
assert.equal(summaryRow(again), summaryRow(second), "unchanged content must reuse the cached flat row");

// ---------------------------------------------------------------------------
// 4. Full mode: a static row whose text changes under the same id updates too
// ---------------------------------------------------------------------------
const fullBefore = getMessages([user, textMsg("a1", "assistant", "Working."), final("a2")], { mode: "full" });
const fullAfter = getMessages([user, textMsg("a1", "assistant", "Working, and now finished."), final("a3")], {
  mode: "full",
});
assert.equal(rowText(fullBefore.staticMessages.find((m) => m.id.startsWith("a1"))), "Working.");
assert.equal(
  rowText(fullAfter.staticMessages.find((m) => m.id.startsWith("a1"))),
  "Working, and now finished.",
  "static text rows must not pin the first render"
);

// ---------------------------------------------------------------------------
// 5. `countSourceMessages` must not split ids that merely end in digits
// ---------------------------------------------------------------------------
// Regression: the counter used to strip a `-d?\d+$` suffix from EVERY row id, so source
// messages whose own ids end in a number were merged together and the hidden count was
// under-reported. `flattenMessage` never renames user messages, so a user row's id IS its
// source id; only assistant rows carry a part index appended by the projection.
const rowOf = (id, role = "assistant") => ({ id, role, parts: [{ type: "text", content: "x" }] });

assert.equal(countSourceMessages([rowOf("a0-d0"), rowOf("a0-d1")]), 1, "two parts of one message count once");
assert.equal(countSourceMessages([rowOf("a0-d1"), rowOf("a1-d1")]), 2, "distinct messages count separately");
assert.equal(
  countSourceMessages([rowOf("msg-user-0", "user"), rowOf("msg-user-1", "user"), rowOf("msg-user-2", "user")]),
  3,
  "user ids ending in digits are distinct messages, not flattened rows"
);
assert.equal(
  countSourceMessages([rowOf("ctx-git_status-abc-7", "user"), rowOf("ctx-git_status-abc-8", "user")]),
  2,
  "ctx ids carrying a numeric nonce are distinct messages"
);
assert.equal(
  countSourceMessages([rowOf("msg-user-0", "user"), rowOf("a5-d0"), rowOf("a5-d1")]),
  2,
  "digit-tailed user ids and flattened assistant rows resolve independently"
);
assert.equal(
  countSourceMessages([rowOf("display-activity:u2:0")]),
  1,
  "a compact summary row is a single source message"
);

// The same guarantee through the real pipeline, with a digit-tailed user message present.
const digitUser = textMsg("msg-user-0", "user", "first prompt");
const digitUser2 = textMsg("msg-user-1", "user", "second prompt");
const digitResult = getMessages([digitUser, toolMsg("a1", [readFile("t1")]), digitUser2, final("a2")], {
  mode: "full",
});
const distinctSources = new Set(
  digitResult.staticMessages.map((m) => (m.role === "user" ? m.id : m.id.replace(/-d?\d+$/, "")))
).size;
assert.equal(
  countSourceMessages(digitResult.staticMessages),
  distinctSources,
  "the counter must match the real distinct-source count for digit-tailed ids"
);

// ---------------------------------------------------------------------------
// 6. The hidden-marker count: ONE subtraction over source messages
// ---------------------------------------------------------------------------
// `MessageList` derives the marker as `staticSourceTotal - countSourceMessages(visibleRows)`.
// It used to add "messages with no row" to "messages behind dropped rows", which agreed only while
// no message straddled the budget cut — and it reported a compact fold as hidden history.
const markerOf = (result, visibleCount) =>
  Math.max(0, result.staticSourceTotal - countSourceMessages(result.staticMessages.slice(-visibleCount)));

const foldedPair = [user, toolMsg("a1", [readFile("t1")]), toolMsg("a2", [readFile("t2")]), final("a3")];
const fullPair = getMessages(foldedPair, { mode: "full" });
const compactPair = getMessages(foldedPair, { mode: "compact" });
assert.equal(fullPair.staticSourceTotal, 3, "the static side is user + two tool sources");
assert.equal(compactPair.staticSourceTotal, 3, "the total is mode-independent");
assert.equal(markerOf(fullPair, fullPair.staticMessages.length), 0, "full mode hides nothing");
assert.equal(
  markerOf(compactPair, compactPair.staticMessages.length),
  0,
  "folding two tool messages is display, not truncation"
);

// A source that genuinely produces no row (thinking-only) still counts as hidden, in both modes.
const thinkingOnly = { id: "a0", role: "assistant", parts: [{ type: "thinking", content: "hm" }] };
const withUnrendered = [
  user,
  thinkingOnly,
  toolMsg("a1", [readFile("t1")]),
  toolMsg("a2", [readFile("t2")]),
  final("a4"),
];
for (const mode of ["full", "compact"]) {
  const result = getMessages(withUnrendered, { mode });
  assert.equal(result.staticSourceTotal, 4, `${mode}: the thinking-only message is on the static side`);
  assert.equal(markerOf(result, result.staticMessages.length), 1, `${mode}: it is hidden, and only it`);
}

// A budget cut INSIDE one message's parts does not over-report: the visible part represents it.
// (The old two-term formula counted it through the dropped-rows term.)
const splitRows = [rowOf("a1-d0"), rowOf("a1-d1")];
assert.equal(countSourceMessages(splitRows), 1, "both rows are one source message");
assert.equal(
  Math.max(0, 1 - countSourceMessages(splitRows.slice(-1))),
  0,
  "one visible part is enough for the message not to be hidden"
);

// The activity row records what it stands for, and the counter expands it (so a fold dropped by
// the budget reports every message behind it).
const activity = compactPair.staticMessages.find((m) => m.id.startsWith("display-activity:"));
assert.ok(activity, "the folded pair produced an activity row");
assert.deepEqual(activity.sourceMessageIds, ["a1", "a2"], "the row records its source messages");
assert.equal(countSourceMessages([activity]), 2, "the counter expands the fold");

// ---------------------------------------------------------------------------
// The synthetic-context predicate is CORE's, not a host copy.
//
// It answers "is this row a `<ctx kind=…>` context block?" — persisted for the model, hidden from
// every reader. Core owns the shell (`CONTEXT_OPEN_PREFIX`, `isContextUIMessage`), and ACP's
// `session/load` replay hides the same rows with it. A host that re-spells the marker drifts the
// moment the shell changes, and the drift shows up as injected context in someone's transcript.

{
  const source = readFileSync(new URL("../src/utils/get-messages.ts", import.meta.url), "utf8");
  assert.ok(source.includes("isContextUIMessage"), "the transcript asks core's predicate");
  // What must not come back is a host-side COMPARISON against the shell (the old
  // `content.startsWith("<ctx kind=")`); the same text in a comment is just prose.
  assert.ok(
    !/(startsWith|includes|indexOf)\(\s*["'`]<ctx kind=/.test(source),
    "and does not compare against a re-spelled shell marker"
  );
}

process.stdout.write("get-messages: ok\n");
