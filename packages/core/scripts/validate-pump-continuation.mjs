/**
 * Validates mid-run queue deferral (pumpDepth vs stale status).
 *
 * Run: pnpm --filter @codent/core run validate:pump-continuation
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { AgentLog, ManagedAgent, shouldDeferMidRunQueue } from "../dist/dev.mjs";

assert.equal(shouldDeferMidRunQueue({ pumpDepth: 1, status: "running" }), true, "active pump defers");
assert.equal(shouldDeferMidRunQueue({ pumpDepth: 0, status: "waiting" }), true, "approval wait defers");
assert.equal(shouldDeferMidRunQueue({ pumpDepth: 0, status: "awaiting_user" }), true, "ask_user defers");
// A manual `/compact` has no pump, so `pumpDepth` cannot cover it. Starting a turn here appends the
// summary checkpoint inside a half-finished turn and resets the window usage the new turn is
// accumulating — the message must queue until the compaction ends.
assert.equal(shouldDeferMidRunQueue({ pumpDepth: 0, status: "compacting" }), true, "manual compaction defers");
assert.equal(shouldDeferMidRunQueue({ pumpDepth: 1, status: "compacting" }), true, "auto compaction defers too");

assert.equal(
  shouldDeferMidRunQueue({ pumpDepth: 0, status: "running" }),
  false,
  "stale running after pump exit must not defer"
);
assert.equal(shouldDeferMidRunQueue({ pumpDepth: 0, status: "responding" }), false, "stale responding must not defer");
assert.equal(shouldDeferMidRunQueue({ pumpDepth: 0, status: "completed" }), false, "completed allows send");
assert.equal(shouldDeferMidRunQueue({ pumpDepth: 0, status: "idle" }), false, "idle allows send");

// A queued pump belongs to the transcript generation it was scheduled for. A
// clear/resume must invalidate it before it can begin a real model turn.
{
  const managed = new ManagedAgent(
    { name: "pump-epoch", model: "test-model" },
    { log: new AgentLog(), tools: {}, todoManager: null }
  );
  const chat = managed.initChat({});
  let pumps = 0;
  chat.pumpToolPhases = async () => {
    pumps += 1;
  };

  const queued = chat.enqueueRunOnce();
  assert.equal(chat.isRunActive(), true, "a queued pump counts as active");
  chat.clearTranscript();
  await queued;
  assert.equal(pumps, 0, "a pump queued before clearTranscript must not start");

  const stopped = chat.enqueueRunOnce();
  chat.stopIfActive("session-switch");
  await stopped;
  assert.equal(pumps, 0, "a pump queued before stopIfActive must not start");
}

// A stale callback must not consume the NEW epoch's pending slot. Without epoch ownership,
// A (old) decrements the shared count after clear, B is still queued but looks absent, and a
// third enqueue starts a second pump.
{
  const managed = new ManagedAgent(
    { name: "pump-epoch-race", model: "test-model" },
    { log: new AgentLog(), tools: {}, todoManager: null }
  );
  const chat = managed.initChat({});
  let pumps = 0;
  let releasePump;
  const pumpGate = new Promise((resolve) => {
    releasePump = resolve;
  });
  chat.pumpToolPhases = async () => {
    pumps += 1;
    await pumpGate;
  };

  const oldRun = chat.enqueueRunOnce();
  let newPendingAfterOld = false;
  let duplicate;
  const observedOld = oldRun.then(() => {
    // Runs after A's stale callback, before B (the fresh run) starts.
    newPendingAfterOld = chat.isRunActive();
    duplicate = chat.enqueueRunOnce();
  });
  chat.clearTranscript();
  const freshRun = chat.enqueueRunOnce();

  await observedOld;
  assert.equal(newPendingAfterOld, true, "a stale callback must not clear the fresh pending slot");
  releasePump();
  await freshRun;
  await duplicate;
  assert.equal(pumps, 1, "only the fresh epoch's pump may run");
}

// A pump queued while another was live must not start a model call over a settled turn.
//
// An approval answered during `applyCommandSafetyPolicy` (an awaited CoreEnv call), or a late
// auto-mode batch, enqueues a pump even though the LIVE pump is about to finish the turn itself.
// The queued pump used to run `executeStream` unconditionally: `completed` became `running` again
// and a whole model call was spent re-asking a transcript that already had its answer.
{
  const managed = new ManagedAgent(
    { name: "pump-admission", model: "test-model" },
    { log: new AgentLog(), tools: {}, todoManager: null }
  );
  const chat = managed.initChat({});
  const channel = chat.getUIChannel();
  let streams = 0;
  chat.executeStream = async () => {
    streams += 1;
  };

  channel.setMessages([
    { id: "u1", role: "user", parts: [{ type: "text", content: "run it" }] },
    {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: "call_1",
          name: "run_command",
          arguments: "{}",
          state: "complete",
          output: { success: true, stdout: "ok", exitCode: 0 },
        },
      ],
    },
    { id: "a2", role: "assistant", parts: [{ type: "text", content: "done" }] },
  ]);

  await chat.pumpToolPhases?.();
  assert.equal(streams, 0, "nothing left to continue ⇒ no model call");
  assert.equal(managed.getStatus(), "idle", "…and the turn is not reopened");

  channel.addUserMessage("next");
  await chat.pumpToolPhases?.();
  assert.equal(streams, 1, "a user message still starts the model call");
}

// A throw during pump SETUP (before the loop's try block) used to skip the finally: pumpDepth
// stayed > 0, the run token stayed valid, and every later message queued with nothing to drain
// it — plus `enqueueRunOnce`'s promise rejected with no handler. The setup belongs inside the
// guard, and the catch must finalize the turn as an error.
{
  const managed = new ManagedAgent(
    { name: "pump-setup-throw", model: "test-model" },
    { log: new AgentLog(), tools: {}, todoManager: null }
  );
  const chat = managed.initChat({});
  const channel = chat.getUIChannel();
  channel.addUserMessage("start");

  const originalPrepare = managed.statusController.prepareRunPhase;
  managed.statusController.prepareRunPhase = () => {
    throw new Error("prepare exploded");
  };

  await chat.pumpToolPhases?.();
  assert.equal(chat.isRunActive(), false, "a setup throw must leave no live/queued pump");
  assert.equal(managed.getStatus(), "error", "and the turn settles as a failed run");

  // The agent is usable again instead of queueing forever.
  managed.statusController.prepareRunPhase = originalPrepare;
  let streams = 0;
  chat.executeStream = async () => {
    streams += 1;
  };
  channel.addUserMessage("again");
  await chat.pumpToolPhases?.();
  assert.equal(streams, 1, "the next turn still runs");
}

// ---------------------------------------------------------------------------
// Wiring guards for the state-transition convergence points.
//
// These are source assertions on purpose: each one is an ORDER/ownership rule inside the pump
// (private methods, no seam a unit test can drive), and the failure they prevent is silent.
// ---------------------------------------------------------------------------
{
  const src = readFileSync(fileURLToPath(new URL("../src/agent/run/chat-controller.ts", import.meta.url)), "utf8");

  // One preserve rule: the abort fallback and `interruptCurrentRun` used to disagree, and the
  // fallback undid the park. Assert the default is FORWARDED to `settleToolCalls`, not merely that
  // the string `?? true` exists.
  assert.match(
    src,
    /\(options\.preservePendingAskUser \?\? true\) \? \{ preservePendingAskUser: true \}/,
    "the default is forwarded to settleToolCalls"
  );

  // A chain pump admits on queued input; it must deliver that input BEFORE the first model call,
  // and must not do it while tools still need to run (that would put user text before the result).
  const phaseZero = src.slice(src.indexOf("} else if ("), src.indexOf("await this.executeStream"));
  assert.match(phaseZero, /needsToolPhaseContinue\(currentMessages\)/, "a settled TOOL turn is not drained");
  assert.match(phaseZero, /drainSteerIntoChannel\(\)/, "phase 0 drains steering");
  assert.match(phaseZero, /if \(!steered\) this\.drainFollowUpIntoChannel\(\)/, "follow-up only when no steer");

  // Esc is a turn outcome: it goes through the shared finalizer (status + finalizeRun + summary),
  // not a hand-rolled sequence that skipped `turn:summary`.
  const start = src.indexOf("private interruptCurrentRun");
  const end = src.indexOf("setSteeringMode", start);
  assert.ok(start !== -1 && end > start, "interruptCurrentRun is present");
  const interrupt = src.slice(start, end);
  assert.match(interrupt, /finalizeChat\(\{[\s\S]{0,600}?kind,/, "Esc finalizes through the shared finalizer");
  assert.match(
    interrupt,
    /kind = deriveCancelVerdict\(this\.managed\.getAgentState\(\)\)/,
    "a failed run keeps `error` (read from the AXIS: `wait=question` hides it in the projection)"
  );
  assert.match(interrupt, /usageBefore: baselines\.usage/, "the summary uses the pump's usage baseline");
  assert.match(interrupt, /costBefore: baselines\.cost/, "…cost baseline");
  assert.match(interrupt, /toolCallsBefore: baselines\.toolCalls/, "…tool-call baseline");
}

console.log("validate:pump-continuation passed");
