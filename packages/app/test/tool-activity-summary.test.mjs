/**
 * Validates tool activity summary helpers.
 *
 * Run: node packages/app/test/tool-activity-summary.test.mjs
 */
import { getBuiltinToolPresentation } from "@codent/core";
import assert from "node:assert/strict";

import { keepsCompactRow } from "../dist/index.mjs";
import {
  collectOtherToolNames,
  countToolActivity,
  extractActivityLabel,
  extractActivityLabelInfo,
  formatExploredActivitySummary,
  formatToolActivitySummary,
  getToolActivityBucket,
  shouldFoldToolRow,
  shouldKeepToolRow,
  summarizeToolActivity,
} from "../dist/utils/tool-activity-summary.mjs";

assert.equal(getToolActivityBucket("read_file"), "reads");
assert.equal(getToolActivityBucket("list_file"), "reads");
assert.equal(getToolActivityBucket("tree"), "reads");
assert.equal(getToolActivityBucket("edit_file"), "edits");
assert.equal(getToolActivityBucket("write_file"), "edits");
assert.equal(getToolActivityBucket("delete_file"), "edits");
assert.equal(getToolActivityBucket("grep"), "searches");
assert.equal(getToolActivityBucket("glob"), "searches");
assert.equal(getToolActivityBucket("websearch"), "searches");
assert.equal(getToolActivityBucket("webfetch"), "searches");
assert.equal(getToolActivityBucket("run_command"), "commands");
assert.equal(getToolActivityBucket("task"), "tasks");
assert.equal(getToolActivityBucket("todo"), "other");

// Completed tools (incl. edit_file) fold; only lifecycle states keep rows.
assert.equal(
  shouldKeepToolRow({ id: "1", name: "edit_file", type: "tool-call", state: "complete", output: {} }),
  false
);
assert.equal(shouldFoldToolRow({ id: "2", name: "read_file", type: "tool-call", state: "complete", output: {} }), true);
assert.equal(shouldKeepToolRow({ id: "3", name: "read_file", type: "tool-call", state: "input-complete" }), true);
assert.equal(
  shouldKeepToolRow({ id: "4", name: "read_file", type: "tool-call", state: "error", output: { error: "x" } }),
  false
);
// Errored rows fold too (counted as errors), not kept as standalone rows.
assert.equal(
  shouldFoldToolRow({ id: "5", name: "read_file", type: "tool-call", state: "error", output: { error: "x" } }),
  true
);

const parts = [
  { id: "1", name: "read_file", type: "tool-call" },
  { id: "2", name: "read_file", type: "tool-call" },
  { id: "3", name: "edit_file", type: "tool-call" },
  { id: "1", name: "read_file", type: "tool-call" }, // dedupe
  { id: "4", name: "grep", type: "tool-call" },
];

const counts = countToolActivity(parts);
assert.deepEqual(counts, {
  reads: 2,
  edits: 1,
  searches: 1,
  commands: 0,
  tasks: 0,
  other: 0,
  errors: 0,
});

assert.equal(formatToolActivitySummary(counts), "2 reads, 1 edit, 1 search");
assert.equal(
  formatToolActivitySummary({ reads: 1, edits: 0, searches: 0, commands: 0, tasks: 0, other: 0, errors: 0 }),
  "1 read"
);
assert.equal(
  formatToolActivitySummary({ reads: 0, edits: 0, searches: 0, commands: 0, tasks: 0, other: 0, errors: 0 }),
  null
);
assert.equal(summarizeToolActivity([]), null);
assert.equal(summarizeToolActivity(parts), "2 reads, 1 edit, 1 search");

// Errored rows count as errors only (not double-counted in their own bucket).
const withErrors = countToolActivity([
  { id: "e1", name: "read_file", type: "tool-call", state: "error", output: { error: "boom" } },
  { id: "e2", name: "edit_file", type: "tool-call", state: "error", output: { error: "nope" } },
]);
assert.deepEqual(withErrors, {
  reads: 0,
  edits: 0,
  searches: 0,
  commands: 0,
  tasks: 0,
  other: 0,
  errors: 2,
});
assert.equal(formatToolActivitySummary(withErrors), "2 errors");

assert.equal(
  extractActivityLabel({
    id: "x",
    name: "read_file",
    type: "tool-call",
    arguments: JSON.stringify({ path: "packages/app/src/foo.ts" }),
  }),
  "foo.ts"
);

// Label tiers: file basenames outrank directory basenames.
assert.equal(
  extractActivityLabelInfo({
    id: "x",
    name: "read_file",
    type: "tool-call",
    arguments: JSON.stringify({ path: "packages/app/src/foo.ts" }),
  }).tier,
  0
);
assert.equal(
  extractActivityLabelInfo({
    id: "x",
    name: "tree",
    type: "tool-call",
    arguments: JSON.stringify({ path: "packages/app" }),
  }).tier,
  2
);
assert.equal(
  extractActivityLabelInfo({
    id: "x",
    name: "grep",
    type: "tool-call",
    arguments: JSON.stringify({ pattern: "compact", path: "packages/app/src" }),
  }).tier,
  1
);

assert.equal(
  formatExploredActivitySummary([
    {
      id: "1",
      name: "read_file",
      type: "tool-call",
      arguments: JSON.stringify({ path: "a.ts" }),
      output: { durationMs: 300 },
    },
    {
      id: "2",
      name: "read_file",
      type: "tool-call",
      arguments: JSON.stringify({ path: "b.ts" }),
      output: { durationMs: 700 },
    },
    {
      id: "3",
      name: "read_file",
      type: "tool-call",
      arguments: JSON.stringify({ path: "c.ts" }),
      output: { durationMs: 500 },
    },
  ]),
  "Explored 3 files · a.ts, b.ts, +1 · 1.5s"
);

// Directory labels (tree) must not crowd out file labels.
assert.equal(
  formatExploredActivitySummary([
    {
      id: "1",
      name: "tree",
      type: "tool-call",
      arguments: JSON.stringify({ path: "packages/app" }),
      output: { durationMs: 10 },
    },
    {
      id: "2",
      name: "read_file",
      type: "tool-call",
      arguments: JSON.stringify({ path: "src/a.ts" }),
      output: { durationMs: 20 },
    },
    {
      id: "3",
      name: "read_file",
      type: "tool-call",
      arguments: JSON.stringify({ path: "src/b.ts" }),
      output: { durationMs: 20 },
    },
  ]),
  "Explored 3 files · a.ts, b.ts, +1"
);

// Errored rows surface in the summary count with labels.
assert.equal(
  formatExploredActivitySummary([
    {
      id: "1",
      name: "read_file",
      type: "tool-call",
      arguments: JSON.stringify({ path: "a.ts" }),
      output: { durationMs: 400 },
    },
    {
      id: "2",
      name: "read_file",
      type: "tool-call",
      state: "error",
      arguments: JSON.stringify({ path: "b.ts" }),
      output: { error: "boom", durationMs: 600 },
    },
  ]),
  "1 read, 1 error · a.ts, b.ts · 1.0s"
);

// Duration below threshold is not shown.
assert.equal(
  formatExploredActivitySummary([
    {
      id: "1",
      name: "read_file",
      type: "tool-call",
      arguments: JSON.stringify({ path: "a.ts" }),
      output: { durationMs: 10 },
    },
  ]),
  "Explored 1 file · a.ts"
);

// --- Extension tools: named `other` bucket, display metadata, curated toUI rows -------

// Tools without a bucket of their own are named instead of collapsing into `N other`.
const unnamed = [
  { id: "1", name: "ext_echo", type: "tool-call", arguments: JSON.stringify({ message: "hi" }), output: {} },
  { id: "2", name: "ext_echo", type: "tool-call", arguments: JSON.stringify({ message: "ho" }), output: {} },
  { id: "3", name: "weird_tool", type: "tool-call", arguments: "{}", output: {} },
  { id: "1", name: "ext_echo", type: "tool-call", arguments: JSON.stringify({ message: "hi" }), output: {} },
  { id: "4", name: "read_file", type: "tool-call", arguments: JSON.stringify({ path: "a.ts" }), output: {} },
  { id: "5", name: "ext_echo", type: "tool-call", state: "error", arguments: "{}", output: { error: "x" } },
];
assert.deepEqual(collectOtherToolNames(unnamed), [
  { name: "ext_echo", count: 2 },
  { name: "weird_tool", count: 1 },
]);
assert.equal(
  formatToolActivitySummary(countToolActivity(unnamed), collectOtherToolNames(unnamed)),
  "1 read, ext_echo ×2, weird_tool, 1 error"
);
assert.equal(
  formatExploredActivitySummary(unnamed.filter((p) => p.name !== "read_file")),
  "ext_echo ×2, weird_tool, 1 error"
);
// Built-in labels still lead the label list.
assert.equal(
  formatExploredActivitySummary([
    { id: "1", name: "read_file", type: "tool-call", arguments: JSON.stringify({ path: "a.ts" }), output: {} },
    { id: "2", name: "ext_echo", type: "tool-call", arguments: JSON.stringify({ message: "hi" }), output: {} },
  ]),
  "1 read, ext_echo · a.ts"
);

// A session descriptor wins over the built-in table and supplies labels.
const labelOnly = { category: "searches", label: (input) => input?.message };
const resolveLabel = (name) => (name === "ext_echo" ? labelOnly : getBuiltinToolPresentation(name));
assert.equal(getToolActivityBucket("ext_echo", resolveLabel), "searches");
assert.equal(getToolActivityBucket("read_file", resolveLabel), "reads");
assert.equal(getToolActivityBucket("never_registered_tool", resolveLabel), "other");
const curated = extractActivityLabelInfo(
  {
    id: "1",
    name: "ext_echo",
    type: "tool-call",
    arguments: JSON.stringify({ message: "hi" }),
  },
  resolveLabel
);
assert.equal(curated.text, "hi");
assert.ok(curated.tier < 0, "curated labels outrank file basenames");
assert.equal(
  formatExploredActivitySummary(
    [
      { id: "1", name: "ext_echo", type: "tool-call", arguments: JSON.stringify({ message: "hi" }), output: {} },
      { id: "2", name: "ext_echo", type: "tool-call", arguments: JSON.stringify({ message: "ho" }), output: {} },
      { id: "3", name: "run_command", type: "tool-call", arguments: JSON.stringify({ command: "ls" }), output: {} },
    ],
    resolveLabel
  ),
  "2 searches, 1 command · hi, ho"
);

// A curated present.text line means the tool owns its compact row (metadata alone does not).
assert.equal(keepsCompactRow("read_file"), false);
assert.equal(keepsCompactRow("todo"), true);
assert.equal(keepsCompactRow("ext_echo"), false);
const extPresentation = {
  ...labelOnly,
  text: (result) => `echo → ${result?.echoed ?? ""}`,
};
const resolveExt = (name) => (name === "ext_echo" ? extPresentation : getBuiltinToolPresentation(name));
assert.equal(keepsCompactRow("ext_echo", resolveExt), true);

const completed = (name) => ({
  id: "1",
  name,
  type: "tool-call",
  state: "complete",
  arguments: "{}",
  output: {},
});

// Structured tools stay as rows once completed; curated-toUI rows do too.
assert.equal(shouldKeepToolRow(completed("todo")), true);
assert.equal(shouldFoldToolRow(completed("todo")), false);
assert.equal(shouldKeepToolRow(completed("ask_user")), true);
assert.equal(shouldKeepToolRow(completed("complete_plan")), true);
assert.equal(shouldKeepToolRow(completed("ext_echo"), resolveExt), true);
assert.equal(shouldKeepToolRow(completed("run_command")), false);
assert.equal(shouldFoldToolRow(completed("edit_file")), true);
// Errored rows still fold (the render layer hides them in compact).
assert.equal(shouldKeepToolRow({ ...completed("todo"), state: "error", output: { error: "x" } }), false);
assert.equal(
  shouldKeepToolRow({ ...completed("ext_echo"), state: "error", output: { error: "x" } }, resolveExt),
  false
);

assert.equal(getToolActivityBucket("ext_echo"), "other");

console.log("tool-activity-summary.test.mjs: ok");
