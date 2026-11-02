/**
 * Validates whether a `task` row renders as in-progress — the one answer the transcript uses for the
 * live clock, the summary stream, and whether the finished-output block may be drawn.
 *
 * A background task is the case that breaks the obvious rule. `run_in_background` settles the tool
 * call the instant the child STARTS (it returns a handle), so `isExecuting` is already false while
 * the work is still going. Reading only that flag froze the elapsed time, hid the summary preview,
 * and rendered the row as a result — a task that looks done for the whole of its run.
 *
 * Three signals, and the third is easy to miss: a QUEUED background task has no child row yet (spawn
 * order admits it when a concurrency slot frees), so "no agent" must not read as "finished".
 *
 * Run: node --test test/task-background-row.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";

// The module graph reaches CoreEnv-independent code, so register a stub as the other app tests do.
const { registerCoreEnv } = await import(new URL("../../core/dist/index.mjs", import.meta.url).href);
registerCoreEnv({ rootPath: "/repo" });

const { isTaskRowLive } = await import("../dist/index.mjs");

/** A child row, as the snapshot carries it (only `status` is read here). */
const agent = (status) => ({ status });

test("a blocking call in flight is live", () => {
  assert.equal(isTaskRowLive({ isExecuting: true }), true);
});

test("a settled blocking call with no child is not live", () => {
  assert.equal(isTaskRowLive({ isExecuting: false }), false);
});

test("a background start handle is live even though the call already settled", () => {
  assert.equal(isTaskRowLive({ isExecuting: false, outputStatus: "running" }), true);
});

test("a queued background task is live without a child row", () => {
  // The trap: no agent yet is not evidence of completion.
  assert.equal(isTaskRowLive({ isExecuting: false, outputStatus: "running", agent: undefined }), true);
  assert.equal(isTaskRowLive({ isExecuting: false, outputStatus: "running", agent: null }), true);
});

test("the settle handler's write ends the live state", () => {
  // `status: "completed"` (or an absent status, for a blocking result) is the transition — not a
  // timer, and not the child's own status.
  assert.equal(isTaskRowLive({ isExecuting: false, outputStatus: "completed" }), false);
  assert.equal(isTaskRowLive({ isExecuting: false }), false);
});

test("a child that is still active is live on its own", () => {
  // The part can be rewritten a moment before the child's final event lands; a live child is the
  // strongest evidence, so it outranks the settled output.
  assert.equal(isTaskRowLive({ isExecuting: false, outputStatus: "completed", agent: agent("running") }), true);
});

test("a stopped child does not keep a finished row live", () => {
  for (const status of ["completed", "failed", "aborted", "error"]) {
    assert.equal(
      isTaskRowLive({ isExecuting: false, outputStatus: "completed", agent: agent(status) }),
      false,
      `${status} must not read as in-progress`
    );
  }
});
