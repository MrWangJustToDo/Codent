/**
 * Validates compact transcript projection.
 *
 * Run: node packages/app/test/project-transcript.test.mjs
 */
import assert from "node:assert/strict";

import {
  ACTIVITY_SUMMARY_ID_PREFIX,
  isActivitySummaryMessage,
  projectTranscriptForDisplay,
} from "../dist/utils/project-transcript.mjs";

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
      approval: t.approval,
    })),
  };
}

const user = textMsg("u1", "user", "fix the bug");
const tools = toolMsg("a1", [
  { id: "t1", name: "read_file", arguments: JSON.stringify({ path: "src/a.ts" }), output: {} },
  { id: "t2", name: "edit_file", arguments: JSON.stringify({ path: "src/a.ts" }), output: {} },
]);
const final = textMsg("a2", "assistant", "Done.");

// Even a single completed tool folds into an activity summary (no count threshold).
const below = projectTranscriptForDisplay([user, tools, final], { mode: "compact" });
assert.equal(below.length, 3);
assert.equal(below[0].id, "u1");
assert.ok(isActivitySummaryMessage(below[1]));
assert.equal(below[1].parts[0].content, "1 read, 1 edit · a.ts");
assert.equal(below[2].id, "a2-d0");

// 3+ consecutive completed tools (incl. edit_file — no high-signal exemption) fold into a path-aware summary.
const manyReads = projectTranscriptForDisplay(
  [
    user,
    toolMsg("a1", [
      { id: "r1", name: "read_file", arguments: JSON.stringify({ path: "src/a.ts" }), output: {} },
      { id: "r2", name: "read_file", arguments: JSON.stringify({ path: "src/b.ts" }), output: {} },
      { id: "r3", name: "read_file", arguments: JSON.stringify({ path: "src/c.ts" }), output: {} },
      { id: "e1", name: "edit_file", arguments: JSON.stringify({ path: "src/a.ts" }), output: {} },
    ]),
    final,
  ],
  { mode: "compact" }
);
assert.equal(manyReads[0].id, "u1");
assert.ok(isActivitySummaryMessage(manyReads[1]));
assert.ok(manyReads[1].id.startsWith(`${ACTIVITY_SUMMARY_ID_PREFIX}u1`));
assert.equal(manyReads[1].parts[0].content, "3 reads, 1 edit · a.ts, b.ts, +1");
assert.equal(manyReads[2].parts[0].content, "Done.");

// In-progress read after 3 completed: fold completed, keep executing.
const liveExec = projectTranscriptForDisplay(
  [
    user,
    toolMsg("a1", [
      { id: "t1", name: "read_file", arguments: JSON.stringify({ path: "a.ts" }), output: {} },
      { id: "t2", name: "read_file", arguments: JSON.stringify({ path: "b.ts" }), output: {} },
      { id: "t3", name: "read_file", arguments: JSON.stringify({ path: "c.ts" }), output: {} },
      { id: "t4", name: "read_file", state: "input-complete", arguments: JSON.stringify({ path: "d.ts" }) },
    ]),
  ],
  { mode: "compact" }
);
assert.ok(isActivitySummaryMessage(liveExec[1]));
assert.match(liveExec[1].parts[0].content, /^Explored 3 files/);
assert.equal(liveExec[2].parts[0].id, "t4");

const full = projectTranscriptForDisplay([user, tools, final], { mode: "full" });
assert.equal(full.length, 3);
assert.equal(full[1].id, "a1");

// Pending approval stays as a real tool row.
const pending = projectTranscriptForDisplay(
  [
    user,
    toolMsg("a1", [
      {
        id: "t1",
        name: "edit_file",
        state: "approval-requested",
        approval: { id: "ap1", needsApproval: true },
      },
    ]),
  ],
  { mode: "compact" }
);
assert.equal(pending[1].parts[0].id, "t1");
assert.ok(!isActivitySummaryMessage(pending[1]));

// Abort mid-tool: the completed read still folds; the in-flight read (no output) stays a row.
const aborted = projectTranscriptForDisplay(
  [
    user,
    toolMsg("a1", [
      { id: "t1", name: "read_file", output: {} },
      { id: "t2", name: "read_file", state: "input-complete" },
    ]),
  ],
  { mode: "compact" }
);
assert.ok(isActivitySummaryMessage(aborted[1]));
assert.equal(aborted[1].parts[0].content, "Explored 1 file");
assert.equal(aborted[2].parts[0].id, "t2");

// Error on foldable tool folds into the summary as an error count (3 reads + 1 error);
// the errored row no longer surfaces as a standalone row.
const errored = projectTranscriptForDisplay(
  [
    user,
    toolMsg("a1", [
      { id: "t1", name: "read_file", arguments: JSON.stringify({ path: "a.ts" }), output: {} },
      { id: "t2", name: "read_file", arguments: JSON.stringify({ path: "b.ts" }), output: {} },
      { id: "t3", name: "read_file", arguments: JSON.stringify({ path: "c.ts" }), output: {} },
      { id: "t4", name: "read_file", state: "error", output: { error: "boom" } },
    ]),
  ],
  { mode: "compact" }
);
assert.ok(isActivitySummaryMessage(errored[1]));
assert.equal(errored[1].parts[0].content, "3 reads, 1 error · a.ts, b.ts, +1");
assert.equal(errored.length, 2);

const noTools = projectTranscriptForDisplay([user, final], { mode: "compact" });
assert.equal(noTools.length, 2);
assert.ok(!noTools.some(isActivitySummaryMessage));

// Intermediate text splits segments; a lone read+edit pair between texts still folds.
const withMidText = projectTranscriptForDisplay(
  [
    user,
    textMsg("a0", "assistant", "Looking around…"),
    toolMsg("a1", [
      { id: "t1", name: "read_file", output: {} },
      { id: "t2", name: "edit_file", output: {} },
    ]),
    textMsg("a2", "assistant", "Done."),
  ],
  { mode: "compact" }
);
assert.equal(withMidText[0].id, "u1");
assert.equal(withMidText[1].id, "a0-d0");
assert.ok(isActivitySummaryMessage(withMidText[2]));
assert.equal(withMidText[2].parts[0].content, "1 read, 1 edit");
assert.equal(withMidText[3].id, "a2-d0");

// Sparse parts: a single completed read still folds (no count threshold).
const sparse = projectTranscriptForDisplay(
  [
    user,
    {
      id: "a-sparse",
      role: "assistant",
      parts: [
        undefined,
        { type: "tool-call", id: "t1", name: "read_file", state: "complete", arguments: "{}", output: {} },
        null,
      ],
    },
    final,
  ],
  { mode: "compact" }
);
assert.ok(isActivitySummaryMessage(sparse[1]));
assert.equal(sparse[1].parts[0].content, "Explored 1 file");
assert.equal(sparse[2].id, "a2-d0");

// Extension-injected tools: named in the folded summary, and their declared
// metadata/`toUI` decide whether they fold at all.
const extTools = toolMsg("a-ext", [
  { id: "e1", name: "ext_echo", arguments: JSON.stringify({ message: "hi" }), output: { echoed: "hi" } },
  { id: "e2", name: "ext_echo", arguments: JSON.stringify({ message: "ho" }), output: { echoed: "ho" } },
]);
const extFolded = projectTranscriptForDisplay([user, extTools, final], { mode: "compact" });
assert.ok(isActivitySummaryMessage(extFolded[1]));
assert.equal(extFolded[1].parts[0].content, "ext_echo ×2");

// Structured tools keep their row once completed instead of folding away.
const structured = projectTranscriptForDisplay(
  [user, toolMsg("a-todo", [{ id: "s1", name: "todo", arguments: "{}", output: { items: [] } }]), final],
  { mode: "compact" }
);
assert.equal(structured[1].id, "a-todo");

// A curated present.text line is the tool's compact representation — the row survives.
const extPresentation = { text: (result) => `echo → ${result?.echoed ?? ""}` };
const resolveExt = (name) => (name === "ext_echo" ? extPresentation : undefined);
const extKept = projectTranscriptForDisplay([user, extTools, final], {
  mode: "compact",
  resolvePresentation: resolveExt,
});
assert.equal(extKept[1].id, "a-ext");

console.log("project-transcript.test.mjs: ok");
