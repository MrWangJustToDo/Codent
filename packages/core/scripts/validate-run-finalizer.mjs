/**
 * Validates the end-of-run finalization transaction:
 * - outcome derivation precedence (aborted > error > waiting > finished)
 * - chat ordering: discard (unless waiting) → apply outcome → persist → finalize → turn summary
 * - detached path: apply with path "detached" → finalize
 * - status-only paths use the same status entry
 *
 * Run: pnpm --filter @codent/core run validate:run-finalizer
 */

import assert from "node:assert/strict";

import { RunFinalizer } from "../dist/dev.mjs";

const messages = [
  { id: "u1", role: "user", parts: [{ type: "text", content: "do work" }] },
  {
    id: "a1",
    role: "assistant",
    parts: [
      { type: "text", content: "working" },
      { type: "tool-call", id: "call_1", name: "run_command", arguments: "{}", state: "input-complete" },
    ],
  },
];

/** Baselines for a pump that started with nothing recorded yet. */
const FROM_ZERO = {
  usageBefore: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  costBefore: 0,
  toolCallsBefore: 0,
};

function makeFinalizer({ status = "running", error = "", total } = {}) {
  let currentStatus = status;
  let currentError = error;
  const calls = [];
  const finalizer = new RunFinalizer({
    status: {
      applyRunOutcome: (outcome) => calls.push({ op: "apply", outcome }),
    },
    getStatus: () => currentStatus,
    getError: () => currentError,
    finalizeRun: (reason) => calls.push({ op: "finalize", reason }),
    discardPreforkRuns: (cause) => calls.push({ op: "discard", cause }),
    emitEvent: (type, data) => calls.push({ op: "event", type, data }),
    usage: {
      getTotal: () =>
        total?.current ?? {
          inputTokens: 11,
          outputTokens: 22,
          cacheReadTokens: 33,
          cacheWriteTokens: 44,
        },
      getTotalCostUsd: () => total?.cost ?? 0.5,
    },
  });
  return {
    finalizer,
    calls,
    get status() {
      return currentStatus;
    },
    set status(next) {
      currentStatus = next;
    },
    set error(next) {
      currentError = next;
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Derivation precedence
// ---------------------------------------------------------------------------
{
  const ctrl = makeFinalizer({ status: "aborted" });
  assert.equal(
    ctrl.finalizer.deriveChatOutcome({ hasError: true, waitingForUser: true }),
    "aborted",
    "aborted outranks error/waiting"
  );
}
{
  const ctrl = makeFinalizer({ status: "running" });
  assert.equal(ctrl.finalizer.deriveChatOutcome({ hasError: true, waitingForUser: true }), "error");
  assert.equal(ctrl.finalizer.deriveChatOutcome({ hasError: false, waitingForUser: true }), "waiting");
  assert.equal(ctrl.finalizer.deriveChatOutcome({ hasError: false, waitingForUser: false }), "finished");
  ctrl.status = "error";
  assert.equal(ctrl.finalizer.deriveChatOutcome({ hasError: false, waitingForUser: false }), "error");
}

// ---------------------------------------------------------------------------
// 2. Chat terminal ordering + summary payload
// ---------------------------------------------------------------------------
{
  const ctrl = makeFinalizer();
  let persisted = 0;
  const kind = ctrl.finalizer.finalizeChat({
    kind: "finished",
    messages,
    waitingForUser: false,
    phases: 2,
    turnStartedAt: Date.now() - 25,
    ...FROM_ZERO,
    persist: () => {
      persisted += 1;
      ctrl.calls.push({ op: "persist" });
    },
  });
  assert.equal(kind, "finished");
  assert.deepEqual(
    ctrl.calls.map((call) => call.op),
    ["discard", "apply", "persist", "finalize", "event"],
    "discard → apply → persist → finalize → summary"
  );
  assert.equal(persisted, 1);
  assert.equal(ctrl.calls[0].cause, "run-finish");
  assert.equal(ctrl.calls[1].outcome.path, "chat");
  assert.equal(ctrl.calls[1].outcome.kind, "finished");
  assert.equal(ctrl.calls[3].reason, "finished");
  const summary = ctrl.calls[4].data;
  assert.equal(ctrl.calls[4].type, "turn:summary");
  assert.equal(summary.outcome, "finished");
  assert.equal(summary.phases, 2);
  assert.equal(summary.toolCalls, 1);
  assert.equal(summary.inputTokens, 11);
  assert.equal(summary.outputTokens, 22);
  assert.equal(summary.cacheReadTokens, 33);
  assert.equal(summary.cacheWriteTokens, 44);
  assert.equal(summary.costUsd, 0.5);
  assert.ok(summary.durationMs >= 0);
}

{
  const ctrl = makeFinalizer();
  ctrl.finalizer.finalizeChat({
    kind: "waiting",
    messages,
    waitingForUser: true,
    phases: 1,
    turnStartedAt: Date.now(),
    ...FROM_ZERO,
    persist: () => ctrl.calls.push({ op: "persist" }),
  });
  assert.deepEqual(
    ctrl.calls.map((call) => call.op),
    ["apply", "persist", "event"],
    "a wait is not a turn end: no discard, no finalize"
  );
  assert.equal(ctrl.calls[0].outcome.kind, "waiting");
  assert.equal("outcome" in ctrl.calls[2].data, false, "waiting summary carries no outcome");
}

// ---------------------------------------------------------------------------
// 2b. The summary reports THIS pump, not the session
// ---------------------------------------------------------------------------
{
  // Second pump of the same user turn: the session already carries the first pump's usage and
  // tool calls, so reporting totals would double-count everything the turn has done so far.
  const total = {
    current: { inputTokens: 900, outputTokens: 80, cacheReadTokens: 800, cacheWriteTokens: 0 },
    cost: 0.9,
  };
  const ctrl = makeFinalizer({ total });
  ctrl.finalizer.finalizeChat({
    kind: "waiting",
    messages,
    waitingForUser: true,
    phases: 3,
    turnStartedAt: Date.now(),
    usageBefore: { inputTokens: 800, outputTokens: 60, cacheReadTokens: 700, cacheWriteTokens: 0 },
    costBefore: 0.8,
    toolCallsBefore: 1,
    persist: () => {},
  });
  const summary = ctrl.calls.find((call) => call.op === "event").data;
  assert.equal(summary.inputTokens, 100, "input tokens are the pump's delta");
  assert.equal(summary.outputTokens, 20, "output tokens are the pump's delta");
  assert.equal(summary.cacheReadTokens, 100, "cache reads are the pump's delta");
  assert.equal(summary.toolCalls, 0, "tool calls are the pump's delta, not the channel's total");
  assert.ok(Math.abs(summary.costUsd - 0.1) < 1e-9, "cost is the pump's delta");
}

{
  // A pump that ran nothing (the second approval of a batch) reports zeros, not the session.
  const total = { current: { inputTokens: 900, outputTokens: 80 }, cost: 0.9 };
  const ctrl = makeFinalizer({ total });
  ctrl.finalizer.finalizeChat({
    kind: "waiting",
    messages,
    waitingForUser: true,
    phases: 0,
    turnStartedAt: Date.now(),
    usageBefore: { inputTokens: 900, outputTokens: 80 },
    costBefore: 0.9,
    toolCallsBefore: 1,
    persist: () => {},
  });
  const summary = ctrl.calls.find((call) => call.op === "event").data;
  assert.deepEqual(
    [summary.inputTokens, summary.outputTokens, summary.toolCalls, summary.costUsd],
    [0, 0, 0, 0],
    "an empty pump summarizes as nothing rather than repeating the session totals"
  );
}

// ---------------------------------------------------------------------------
// 3. Error message ownership
// ---------------------------------------------------------------------------
{
  const ctrl = makeFinalizer({ status: "running", error: "boom" });
  ctrl.finalizer.finalizeChat({
    kind: "error",
    messages,
    waitingForUser: false,
    phases: 0,
    turnStartedAt: Date.now(),
    ...FROM_ZERO,
    persist: () => {},
  });
  assert.equal(ctrl.calls.find((call) => call.op === "apply").outcome.errorMessage, "boom");
}

{
  const ctrl = makeFinalizer({ status: "running" });
  ctrl.finalizer.finalizeChat({
    kind: "error",
    messages,
    waitingForUser: false,
    phases: 0,
    turnStartedAt: Date.now(),
    ...FROM_ZERO,
    persist: () => {},
  });
  assert.equal(
    ctrl.calls.find((call) => call.op === "apply").outcome.errorMessage,
    "Stream execution failed",
    "a failed outcome without a recorded message still reports one"
  );
}

{
  const ctrl = makeFinalizer({ status: "error", error: "already recorded" });
  ctrl.finalizer.finalizeChat({
    kind: "error",
    messages,
    waitingForUser: false,
    phases: 0,
    turnStartedAt: Date.now(),
    ...FROM_ZERO,
    persist: () => {},
  });
  assert.equal(
    "errorMessage" in ctrl.calls.find((call) => call.op === "apply").outcome,
    false,
    "an already-recorded stream error is not re-emitted"
  );
}

// ---------------------------------------------------------------------------
// 4. Detached + status-only paths
// ---------------------------------------------------------------------------
{
  const ctrl = makeFinalizer();
  ctrl.finalizer.finalizeDetached({ kind: "aborted", messages });
  assert.deepEqual(
    ctrl.calls.map((call) => call.op),
    ["apply", "finalize"],
    "detached runs apply status then finalize"
  );
  assert.equal(ctrl.calls[0].outcome.path, "detached");
  assert.equal(ctrl.calls[0].outcome.kind, "aborted");
  assert.equal(ctrl.calls[1].reason, "aborted");
}

{
  const ctrl = makeFinalizer();
  ctrl.finalizer.finalizeSnapshot(messages);
  assert.equal(ctrl.calls.length, 1);
  assert.deepEqual(ctrl.calls[0].outcome, { kind: "finished", messages, path: "chat" });
}

{
  const ctrl = makeFinalizer();
  const outcome = { kind: "waiting", messages, path: "chat" };
  ctrl.finalizer.applyOutcome(outcome);
  assert.deepEqual(ctrl.calls, [{ op: "apply", outcome }], "applyOutcome only touches status");
}

console.log("run-finalizer validation passed");
