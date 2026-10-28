/**
 * Run lifecycle events must describe a run that exists.
 *
 * Two separate defects shared this root cause:
 *
 *   1. **Destroying an idle agent wrote `agent:abort`.** Every normal shutdown produced a `warn` row
 *      ("Agent aborted (Agent destroyed)") that read as a fault — measured across the workspace's
 *      own logs: 459 rows in 390 files, versus 58 real `user-cancelled` aborts. The signal must
 *      still be aborted (that cancels in-flight work such as memory extraction); only the *claim*
 *      that a run was aborted is wrong.
 *   2. **`forceSubmit` on an idle agent finalized a turn that never started.** `interruptCurrentRun`
 *      ran unconditionally, so a first-ever force-submit emitted `agent:abort` AND `agent:stop`
 *      (with no `turn:start`), inflating any consumer that counts runs by `agent:stop`.
 *
 * What this pins:
 *   1. idle abort (the destroy path) → no `agent:abort`
 *   2. abort while parked on the user (`waiting`) → exactly one
 *   3. abort while running → exactly one
 *   4. force-submit on idle → no abort/stop, and the message still starts a turn
 *   5. force-submit over a parked turn → exactly one abort and one stop
 *
 * Run: pnpm --filter @codent/core run validate:run-event-identity
 */

import assert from "node:assert/strict";

import { AgentLog, ManagedAgent } from "../dist/dev.mjs";

function makeAgent(name, options = {}) {
  const managed = new ManagedAgent(
    { name, model: "test-model" },
    { log: new AgentLog(), tools: {}, todoManager: null }
  );
  const events = [];
  // The runtime's one emission seam: every lifecycle event goes through it.
  managed.emitEvent = (type) => events.push(type);
  const chat = managed.initChat({});
  if (options.status) managed.setStatus(options.status, "test");
  return { managed, chat, events };
}

const count = (events, type) => events.filter((event) => event === type).length;

// ============================================================================
// 1. An idle abort claims nothing (this is the destroy path)
// ============================================================================
{
  const { managed, events } = makeAgent("idle-abort");
  managed.abort("Agent destroyed");
  assert.equal(count(events, "agent:abort"), 0, "an idle abort must not report an aborted run");
}

// ============================================================================
// 2. A turn parked on the user is still a run — and still the Esc target
// ============================================================================
{
  const { managed, events } = makeAgent("parked-abort", { status: "waiting" });
  managed.abort("user-cancelled");
  assert.equal(count(events, "agent:abort"), 1, "a parked turn is aborted exactly once");
}

// ============================================================================
// 3. A running turn aborts exactly once
// ============================================================================
{
  const { managed, events } = makeAgent("running-abort", { status: "running" });
  managed.abort("user-cancelled");
  assert.equal(count(events, "agent:abort"), 1, "a running turn is aborted exactly once");
}

// ============================================================================
// 4. forceSubmit on an idle agent: no fabricated run, message still delivered
// ============================================================================
{
  const { chat, events } = makeAgent("idle-force-submit");
  let pumps = 0;
  chat.pumpToolPhases = async () => {
    pumps += 1;
  };

  chat.forceSubmit("hello");
  await chat.runChain;

  assert.equal(pumps, 1, "the message still starts a turn");
  assert.equal(count(events, "agent:abort"), 0, "an idle force-submit must not emit agent:abort");
  assert.equal(count(events, "agent:stop"), 0, "…nor finalize a turn that never existed");
  assert.equal(
    chat
      .getUIChannel()
      .getMessages()
      .some((message) => message.role === "user"),
    true,
    "and the user message is in the transcript"
  );
}

// ============================================================================
// 5. forceSubmit over a parked turn still interrupts it, exactly once
// ============================================================================
{
  const { chat, events } = makeAgent("parked-force-submit", { status: "waiting" });
  let pumps = 0;
  chat.pumpToolPhases = async () => {
    pumps += 1;
  };
  chat.getUIChannel().setMessages([
    {
      id: "a1",
      role: "assistant",
      parts: [
        {
          id: "tc1",
          type: "tool-call",
          name: "run_command",
          arguments: JSON.stringify({ command: "ls" }),
          state: "input-complete",
          approval: { id: "ap1", needsApproval: true, approved: undefined },
        },
      ],
    },
  ]);

  chat.forceSubmit("next");
  await chat.runChain;

  assert.equal(count(events, "agent:abort"), 1, "the parked turn is interrupted once");
  assert.equal(count(events, "agent:stop"), 1, "and finalized once");
  assert.equal(pumps, 1, "then the new message starts its own turn");
}

// ============================================================================
// 6. Esc on a live pump reports the cancel
//
// `interruptCurrentRun` recorded status `aborted` BEFORE calling `abort()`, and the abort's
// "was there a run" test reads that same status — so the main cancel path emitted no
// `agent:abort`, while a parked agent (which `onUserCancel` ignores) did. The log bridge's
// abort row and `agent:abort` observers (memory-selection discard) never fired on a real Esc.
// ============================================================================
{
  const { managed, chat, events } = makeAgent("running-stop", { status: "running" });
  chat.pumpDepth = 1; // an in-flight pump — the state Esc actually interrupts

  chat.stop();

  assert.equal(count(events, "agent:abort"), 1, "Esc on a live pump reports the cancel exactly once");
  assert.equal(managed.getStatus(), "aborted", "and the turn ends aborted");
}

// ============================================================================
// 7. A settled turn is not "current": idle forceSubmit cannot erase its reading
//
// The run token stayed valid after a normal completion, so `forceSubmit`'s
// `isCurrentRunValid()` fallback treated an idle agent as running: it aborted the settled
// controller (cancelling finalize-time memory extraction that still held its signal) and reached
// `finalizeRun` with nothing to finalize — which cleared `lastIteration` (ACP's
// `max_turn_requests` reading) before the guard rejected it.
// ============================================================================
{
  const { managed, chat, events } = makeAgent("settled-force-submit");
  managed.setStatus("running", "test");
  managed.setIterationProgress({ current: 3, max: 3 });
  // Real pump, stubbed model call: the pump's `finally` is what retires the run token.
  chat.executeStream = async () => {};

  await chat.pumpToolPhases({ startsNewTurn: true });

  assert.equal(managed.run.isCurrentRunValid(), false, "a settled turn holds no current run");
  assert.deepEqual(managed.getL1State().lastIteration, { current: 3, max: 3 }, "the reading is published");
  assert.equal(managed.readIteration().current, 0, "and live progress is cleared");

  events.length = 0;
  chat.pumpToolPhases = async () => {};
  chat.forceSubmit("next");
  await chat.runChain;

  assert.equal(count(events, "agent:abort"), 0, "an idle force-submit does not abort a settled turn");
  assert.deepEqual(managed.getL1State().lastIteration, { current: 3, max: 3 }, "and does not erase lastIteration");
}

console.log("\nvalidate-run-event-identity: all assertions passed");
