/**
 * Validates mid-run queue deferral (pumpDepth vs stale status).
 *
 * Run: pnpm --filter @codent/core run validate:pump-continuation
 */
import assert from "node:assert/strict";

import { AgentLog, ManagedAgent, shouldDeferMidRunQueue } from "../dist/dev.mjs";

assert.equal(shouldDeferMidRunQueue({ pumpDepth: 1, status: "running" }), true, "active pump defers");
assert.equal(shouldDeferMidRunQueue({ pumpDepth: 0, status: "waiting" }), true, "approval wait defers");
assert.equal(shouldDeferMidRunQueue({ pumpDepth: 0, status: "awaiting_user" }), true, "ask_user defers");

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

console.log("validate:pump-continuation passed");
