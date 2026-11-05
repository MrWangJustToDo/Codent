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

import { ManagedAgent, SPECIALIZED_EVENT_LOG_HANDLERS } from "../dist/dev.mjs";

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
function applyStatusPolicy(log, { from, to, event, wait }) {
  SPECIALIZED_EVENT_LOG_HANDLERS["agent:status"](log, {
    type: "agent:status",
    ts: Date.now(),
    agentId: "agent-1",
    sessionId: "ses-1",
    runId: "run-1",
    payload: { from, to, ...(event ? { event } : {}), ...(wait ? { wait } : {}) },
  });
}

// --- terminal outcomes stay visible, whatever moved the status there ---

for (const [to, event] of [
  ["error", "fail"],
  ["error", "stream-end"],
  ["aborted", "interrupt"],
]) {
  const { written, log } = createCapture();
  applyStatusPolicy(log, { from: "running", to, event });
  assert.equal(written.length, 1, `a failure/abort is the line a reader scans for (${to}/${event})`);
  assert.equal(written[0].level, "info");
  assert.equal(written[0].eventType, "agent:status", "the row is filterable by event type");
  assert.equal(written[0].data.event, event);
}

// --- the approval bracket is mechanical: the approval events are the record ---

for (const [from, to, event, wait] of [
  ["running", "waiting", "pause", "approval"],
  ["waiting", "running", "resume", "approval"],
  ["running", "running", "stream-chunk"],
  ["thinking", "thinking", "stream-chunk"],
  ["running", "running", "prepare"],
  ["running", "completed", "settle"],
  ["running", "idle", "reset"],
  ["compacting", "compacting", "compaction-start"],
  ["running", "running", "compaction-end"],
]) {
  const { written, log } = createCapture();
  applyStatusPolicy(log, { from, to, event, ...(wait ? { wait } : {}) });
  assert.equal(written.length, 0, `${event} is already described by the event that caused it`);
}

// --- a pause on a client tool has NO dedicated event ---
//
// `ask_user` is a client tool: it emits neither `agent:tool-start` nor `agent:tool-end`, and
// `session:interaction` is a suppressed projection. Suppressing both transitions left the pause
// with no trace at all, so they are recorded.
for (const [from, to, event] of [
  ["running", "awaiting_user", "pause"],
  ["awaiting_user", "running", "resume"],
]) {
  const { written, log } = createCapture();
  applyStatusPolicy(log, { from, to, event, wait: "question" });
  assert.equal(written.length, 1, `${event} is the only record of the question`);
  assert.equal(written[0].level, "info");
  assert.equal(written[0].eventType, "agent:status");
  assert.equal(written[0].data.from, from);
  assert.equal(written[0].data.to, to);
}

// --- the two escape hatches ---

{
  // An event nobody classified is recorded: silence must be a decision, never an omission.
  const { written, log } = createCapture();
  applyStatusPolicy(log, { from: "running", to: "running", event: "some-future-event" });
  assert.equal(written.length, 1, "an unrecognized event defaults to VISIBLE");
}

{
  // A set with no stated reason explains itself with nothing else — it stays.
  const { written, log } = createCapture();
  applyStatusPolicy(log, { from: "running", to: "completed" });
  assert.equal(written.length, 1, "a reason-less set is not silently dropped");
  assert.equal(written[0].data.event, undefined);
  assert.equal(written[0].message, "Status: running → completed");
}

// --- setStatus publishes the transition (the policy's input) ---

{
  const { written, log } = createCapture();
  const managed = createManaged(log);
  const events = [];
  managed.dispatchEvent = (event) => events.push(event);

  managed.setStatus("running", "prepare");
  assert.equal(events.length, 1, "a transition is published, not written");
  assert.equal(events[0].type, "agent:status");
  assert.deepEqual(events[0].payload, { from: "idle", to: "running", event: "prepare" });
  assert.equal(written.length, 0, "setStatus writes no log row of its own — that is the policy's job");

  const before = events.length;
  managed.setStatus("running", "prepare");
  assert.equal(events.length, before, "a no-op set publishes nothing");

  managed.setStatus("aborted", "user-cancel");
  assert.equal(events.at(-1).payload.to, "aborted");
  assert.equal(managed.getStatus(), "aborted");
}

console.log("agent-status-log validation passed");
