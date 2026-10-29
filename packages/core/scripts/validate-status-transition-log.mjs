/**
 * Validates the status-transition log policy: which transitions earn an `info` line.
 *
 * A run's status flips many times per turn, and most of them are the pump's mechanical
 * bookkeeping — the `waiting ⇄ running` bracket around an approval, `reconcile`
 * re-deriving a status that is already held. Logged at `info`, status was the single
 * largest block in a session log (29.6k of 92.6k lines, 31.9%). The policy moves the
 * mechanical ones to `debug` and keeps the terminal outcomes and user-driven changes
 * visible.
 *
 * Two things are asserted, because they can break independently:
 *
 * 1. the policy table itself (which trigger → which level), and
 * 2. that the level actually reaches the log through `ManagedAgent.setStatus` — a
 *    policy nobody consults would pass (1) and change nothing.
 *
 * Run: pnpm --filter @codent/core run validate:status-transition-log
 */

import assert from "node:assert/strict";

import { ManagedAgent, statusTransitionLogLevel, logSubagentLifecycle } from "../dist/dev.mjs";

// Capture sink. `setStatus` writes under `agent`, the mirror under `system`; keeping both
// lets one harness assert the two policies without them shadowing each other.
function createCapture() {
  const written = [];
  const push = (level) => (category, message, data) => written.push({ level, category, message, data });
  return {
    written,
    log: {
      debug: push("debug"),
      info: push("info"),
      warn: push("warn"),
      error: push("error"),
      agent: () => {},
      clear: () => {},
    },
  };
}

function createManaged(log) {
  return new ManagedAgent(
    { name: "test", model: "gpt-4" },
    {
      context: {
        getMessages: () => [],
        getUIMessages: () => [],
        reset: () => {},
        setMessages: () => {},
        setUIMessages: () => {},
        getMessagesForLLM: () => [],
      },
      log,
      tools: {},
      todoManager: null,
    }
  );
}

// --- terminal outcomes stay visible, whatever moved the status there ---

assert.equal(statusTransitionLogLevel("error", "run-error"), "info", "a failure is the line a reader scans for");
assert.equal(statusTransitionLogLevel("error", "external-error"), "info", "…including one from outside the run");
assert.equal(statusTransitionLogLevel("aborted", "run-abort"), "info", "an abort stays visible");
assert.equal(statusTransitionLogLevel("aborted", "user-cancel"), "info", "…and so does the user's cancel");

// --- the approval bracket is mechanical ---

// Two lines per approval, on top of the approval events themselves; this pair alone was
// ~12.5k lines across the recorded sessions.
assert.equal(statusTransitionLogLevel("waiting", "approvals-pending"), "debug");
assert.equal(statusTransitionLogLevel("running", "approvals-cleared"), "debug");

// --- pump bookkeeping ---

assert.equal(statusTransitionLogLevel("running", "chunk:tool"), "debug", "status derived from the chunk type");
assert.equal(statusTransitionLogLevel("thinking", "chunk:reasoning"), "debug");
assert.equal(statusTransitionLogLevel("responding", "chunk:text"), "debug");
assert.equal(statusTransitionLogLevel("running", "run-start"), "debug", "the run's own events bracket this");
assert.equal(statusTransitionLogLevel("running", "run-finish"), "debug");
assert.equal(statusTransitionLogLevel("running", "run-abort"), "debug");
assert.equal(statusTransitionLogLevel("running", "reconcile"), "debug", "re-derivation, usually a no-op in effect");
assert.equal(statusTransitionLogLevel("waiting", "reconcile"), "debug");
assert.equal(statusTransitionLogLevel("completed", "reconcile-after-run"), "debug");
assert.equal(statusTransitionLogLevel("awaiting_user", "client-tool-wait"), "debug");
assert.equal(statusTransitionLogLevel("completed", "client-tool-resume"), "debug");
assert.equal(statusTransitionLogLevel("running", "recovery-retry"), "debug");

// --- dynamic spellings share a prefix ---

assert.equal(
  statusTransitionLogLevel("compacting", "compaction:manual"),
  "debug",
  "a manual compact's own events are the record; the status line is a duplicate"
);
assert.equal(statusTransitionLogLevel("compacting", "compaction:auto"), "debug");
assert.equal(statusTransitionLogLevel("compacting", "compaction:reactive"), "debug");
assert.equal(statusTransitionLogLevel("running", "compaction-end"), "debug");

// --- the two escape hatches ---

assert.equal(
  statusTransitionLogLevel("running", undefined),
  "info",
  "a direct set with no stated reason is rare and unexplained by anything else"
);
assert.equal(
  statusTransitionLogLevel("running", "some-future-trigger"),
  "info",
  "an unrecognized trigger defaults to VISIBLE — silence must be a decision, never an omission"
);

// --- the policy reaches the log through setStatus ---

{
  const { written, log } = createCapture();
  const managed = createManaged(log);

  managed.setStatus("running", "run-start");
  assert.equal(written.at(-1)?.level, "debug", "a mechanical transition is written at debug, not info");
  assert.equal(written.at(-1)?.message, "Status: idle → running");
  assert.equal(written.at(-1)?.data?.trigger, "run-start", "the trigger is still recorded — only the level moved");

  managed.setStatus("waiting", "approvals-pending");
  assert.equal(written.at(-1)?.level, "debug");

  // The survival case: the same funnel must still produce an info line for the outcome.
  managed.setStatus("aborted", "user-cancel");
  assert.equal(written.at(-1)?.level, "info", "the abort is the line that survives the denoise");

  // A no-op set is silent either way (unchanged behaviour, asserted so a later edit that
  // moves the level cannot also lose the guard).
  const count = written.length;
  managed.setStatus("aborted", "user-cancel");
  assert.equal(written.length, count, "a no-op set writes nothing");

  // A direct set with no trigger stays visible — the transition must not disappear.
  managed.setStatus("completed");
  assert.equal(managed.getStatus(), "completed");
  assert.equal(written.at(-1)?.level, "info", "a trigger-less set is not silently dropped");
  assert.equal(written.at(-1)?.data?.trigger, undefined);
}

// --- the parent-log mirror: a subagent's lifecycle is recorded in the PARENT's file ---
//
// Bus events reach only the subagent's own log (the bridge scopes by `event.agentId`), so a
// child used to be invisible in the parent log and had to be correlated across files by
// timestamp.
//
// These go through `ManagedAgent.logSubagentLifecycle` — the method `run-subagent` actually
// calls — and not through the helper it delegates to. That distinction is the whole point:
// a first version of this file asserted the free function while the method still carried an
// inlined COPY of the wording, so the test was green against code nothing ran, and the two
// had already drifted ("Subagent created" vs "Subagent spawn"). Asserting the method makes
// the delegation itself the thing under test.
{
  const { written, log } = createCapture();
  const managed = createManaged(log);

  managed.logSubagentLifecycle("created", { subagentId: "sub-1", parentTaskToolCallId: "call-01" });
  const made = written.at(-1);
  assert.equal(made?.level, "debug", "a spawn is bookkeeping — the child's own file has the detail");
  assert.equal(made?.category, "system");
  assert.ok(made.message.includes("sub-1") && made.message.includes("[task call-01]"), "id + call id");

  managed.logSubagentLifecycle("started", {
    subagentId: "sub-1",
    parentTaskToolCallId: "call-01",
    description: "audit the manager",
  });
  assert.ok(written.at(-1).message.includes("audit the manager"), "the description is carried");

  managed.logSubagentLifecycle("completed", {
    subagentId: "sub-1",
    parentTaskToolCallId: "call-01",
    iterations: 15,
    maxIterations: 50,
    durationMs: 85600,
  });
  const completed = written.at(-1);
  assert.equal(completed.level, "info", "the outcome stays visible");
  assert.ok(completed.message.includes("15/50 iterations"), "with the run stats");
  assert.ok(completed.message.includes("85600ms"));

  // A stopped child is the line a reader scans for, so its reason is the message.
  managed.logSubagentLifecycle("stopped", {
    subagentId: "sub-2",
    parentTaskToolCallId: "call-01",
    stopReason: "parent-run",
  });
  const stopped = written.at(-1);
  assert.equal(stopped.level, "info");
  assert.match(stopped.message, /^Subagent parent-run:/, "the stop reason is named, not guessed as a cancel");

  // An internal worker has no task call — the mirror records it without a fabricated binding.
  managed.logSubagentLifecycle("created", { subagentId: "worker-1" });
  assert.equal(written.at(-1).message, "Subagent created: subagent worker-1");
  assert.ok(!written.at(-1).message.includes("[task"), "no fabricated call binding");
}

// --- no sink, no crash: the mirror is a no-op without a parent log ---
{
  const written = [];
  const sink = { debug: () => written.push("debug"), info: () => written.push("info") };
  logSubagentLifecycle(sink, "created", { subagentId: "sub-3" });
  assert.deepEqual(written, ["debug"]);
  logSubagentLifecycle(null, "created", { subagentId: "sub-3" });
  logSubagentLifecycle(undefined, "stopped", { subagentId: "sub-3", stopReason: "user" });
  assert.deepEqual(written, ["debug"], "a missing log writes nothing and does not throw");
}

console.log("status-transition-log validation passed");
