/**
 * Validates the agent-status LOG policy: which transitions earn a row at all.
 *
 * A run's status flips many times per turn, and most of them are the pump's mechanical
 * bookkeeping — the `waiting ⇄ running` bracket around an approval, `reconcile` re-deriving a
 * status that is already held. Those transitions were the single largest block in a session log
 * (31.4% of 171,517 recorded entries), and every one of them was already described by the event
 * that caused it. The policy therefore *suppresses* the mechanical ones and records the outcomes.
 *
 * Three things are asserted, because they can break independently:
 *
 * 1. `ManagedAgent.setStatus` still PUBLISHES the transition as an event (a status change is a
 *    fact; whether it is recorded is not the setter's decision any more),
 * 2. the policy that receives it records / suppresses the right ones, and
 * 3. the level actually reaches the log with the originating event type stamped on it.
 *
 * Asserting only (2) would pass with a setter that emits nothing; asserting only (1) would pass
 * with a policy that records everything — which is exactly the state this change removed.
 *
 * Run: pnpm --filter @codent/core run validate:agent-status-log
 */

import assert from "node:assert/strict";

import { ManagedAgent, SPECIALIZED_EVENT_LOG_HANDLERS, logSubagentLifecycle } from "../dist/dev.mjs";

// Capture sink. Status rows go through `eventEntry` (the event bridge's write path), the subagent
// mirror through the plain level methods; keeping both lets one harness assert both policies.
function createCapture() {
  const written = [];
  const push = (level) => (category, message, data) => written.push({ level, category, message, data });
  return {
    written,
    log: {
      eventEntry: (level, category, eventType, message, data, error, run) =>
        written.push({ level, category, eventType, message, data, error, run }),
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

/** Drive the policy the way the Event→Log bridge does: one envelope in, rows out. */
function applyStatusPolicy(log, { from, to, trigger }) {
  SPECIALIZED_EVENT_LOG_HANDLERS["agent:status"](log, {
    type: "agent:status",
    ts: Date.now(),
    agentId: "agent-1",
    sessionId: "ses-1",
    runId: "run-1",
    payload: { from, to, ...(trigger ? { trigger } : {}) },
  });
}

// --- terminal outcomes stay visible, whatever moved the status there ---

for (const [to, trigger] of [
  ["error", "run-error"],
  ["error", "external-error"],
  ["aborted", "run-abort"],
  ["aborted", "user-cancel"],
]) {
  const { written, log } = createCapture();
  applyStatusPolicy(log, { from: "running", to, trigger });
  assert.equal(written.length, 1, `a failure/abort is the line a reader scans for (${to}/${trigger})`);
  assert.equal(written[0].level, "info");
  assert.equal(written[0].eventType, "agent:status", "the row is filterable by event type");
  assert.equal(written[0].data.trigger, trigger);
}

// --- the approval bracket is mechanical: the approval events are the record ---

// Two rows per approval, on top of the approval events themselves; this pair alone was
// ~12.5k entries across the recorded sessions.
for (const [from, to, trigger] of [
  ["running", "waiting", "approvals-pending"],
  ["waiting", "running", "approvals-cleared"],
  ["running", "running", "chunk:tool"],
  ["thinking", "thinking", "chunk:reasoning"],
  ["responding", "responding", "chunk:text"],
  ["running", "running", "run-start"],
  ["running", "running", "run-finish"],
  ["running", "running", "run-abort"],
  ["waiting", "waiting", "reconcile"],
  ["completed", "completed", "reconcile-after-run"],
  ["running", "running", "recovery-retry"],
  ["compacting", "compacting", "compaction:manual"],
  ["compacting", "compacting", "compaction:auto"],
  ["running", "running", "compaction-end"],
]) {
  const { written, log } = createCapture();
  applyStatusPolicy(log, { from, to, trigger });
  assert.equal(written.length, 0, `${trigger} is already described by the event that caused it`);
}

// --- a pause on a client tool has NO dedicated event ---
//
// `ask_user` is a client tool: it emits neither `agent:tool-start` nor `agent:tool-end`, and
// `session:interaction` is a suppressed projection. Suppressing both transitions left the pause
// with no trace at all, so they are recorded.
for (const [from, to, trigger] of [
  ["running", "awaiting_user", "client-tool-wait"],
  ["awaiting_user", "running", "client-tool-resume"],
]) {
  const { written, log } = createCapture();
  applyStatusPolicy(log, { from, to, trigger });
  assert.equal(written.length, 1, `${trigger} is the only record of the pause`);
  assert.equal(written[0].level, "info");
  assert.equal(written[0].eventType, "agent:status");
  assert.equal(written[0].data.from, from);
  assert.equal(written[0].data.to, to);
}

// --- the two escape hatches ---

{
  // A trigger nobody classified is recorded: silence must be a decision, never an omission.
  const { written, log } = createCapture();
  applyStatusPolicy(log, { from: "running", to: "running", trigger: "some-future-trigger" });
  assert.equal(written.length, 1, "an unrecognized trigger defaults to VISIBLE");
}

{
  // A set with no stated reason explains itself with nothing else — it stays.
  const { written, log } = createCapture();
  applyStatusPolicy(log, { from: "running", to: "completed" });
  assert.equal(written.length, 1, "a trigger-less set is not silently dropped");
  assert.equal(written[0].data.trigger, undefined);
  assert.equal(written[0].message, "Status: running → completed");
}

// --- setStatus publishes the transition (the policy's input) ---

{
  const { written, log } = createCapture();
  const managed = createManaged(log);
  const events = [];
  managed.dispatchEvent = (event) => events.push(event);

  managed.setStatus("running", "run-start");
  assert.equal(events.length, 1, "a transition is published, not written");
  assert.equal(events[0].type, "agent:status");
  assert.deepEqual(events[0].payload, { from: "idle", to: "running", trigger: "run-start" });
  assert.equal(written.length, 0, "setStatus writes no log row of its own — that is the policy's job");

  const before = events.length;
  managed.setStatus("running", "run-start");
  assert.equal(events.length, before, "a no-op set publishes nothing");

  managed.setStatus("aborted", "user-cancel");
  assert.equal(events.at(-1).payload.to, "aborted");
  assert.equal(managed.getStatus(), "aborted");
}

// --- the parent-log mirror: a subagent's lifecycle is recorded in the PARENT's file ---
//
// Bus events reach only the subagent's own log (the bridge scopes by `event.agentId`), so a
// child used to be invisible in the parent log and had to be correlated across files by
// timestamp. This one stays a direct write on purpose — see the allowlist reason in
// `validate-no-direct-agent-log.mjs`.
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
  const sink = {
    eventEntry: (level, _category, eventType) => written.push({ level, eventType }),
  };
  logSubagentLifecycle(sink, "created", { subagentId: "sub-3" });
  assert.deepEqual(
    written,
    [{ level: "debug", eventType: "subagent:created" }],
    "an index row names the subagent event it mirrors"
  );
  logSubagentLifecycle(null, "created", { subagentId: "sub-3" });
  logSubagentLifecycle(undefined, "stopped", { subagentId: "sub-3", stopReason: "user" });
  assert.equal(written.length, 1, "a missing log writes nothing and does not throw");
}

console.log("agent-status-log validation passed");
