/**
 * Validates turn-level finalize is idempotent and clears continuation marks.
 *
 * Run: pnpm --filter @codent/core run validate:run-finalize
 */

import assert from "node:assert/strict";

import { finalizeManagedAgentRun } from "../dist/dev.mjs";

function createHost() {
  // setCurrentRunId / setRun are part of the RunLifecycleHost contract (run scoping).
  const setCurrentRunIdCalls = [];
  let turnLifecycleFinalized = false;
  let prepareAsContinuation = true;
  let clearTurnContextCalls = 0;
  let stopEvents = 0;
  let persistCalls = 0;
  let extractCalls = 0;

  let promptless = false;
  const host = {
    id: "agent-1",
    context: {},
    // Finalize passes the run's abort signal through to memory extraction
    // (see `finalizeManagedAgentRun`) and consumes the promptless-turn mark.
    run: {
      currentAbortController: undefined,
      consumePromptlessTurn: () => {
        const value = promptless;
        promptless = false;
        return value;
      },
    },
    setPromptless(next) {
      promptless = next;
    },
    memory: {
      runExtraction: () => {
        extractCalls += 1;
      },
    },
    log: null,
    setCurrentRunId(runId) {
      setCurrentRunIdCalls.push(runId);
    },
    beginTurnFinalize() {
      if (turnLifecycleFinalized) return false;
      turnLifecycleFinalized = true;
      return true;
    },
    resetTurnLifecycle() {
      turnLifecycleFinalized = false;
    },
    clearPrepareAsContinuation() {
      prepareAsContinuation = false;
    },
    recordStreamDuration() {},
    persistSession() {
      persistCalls += 1;
    },
    clearTurnContext() {
      clearTurnContextCalls += 1;
    },
    emitEvent(type) {
      if (type === "agent:stop") stopEvents += 1;
    },
    getContinuation() {
      return prepareAsContinuation;
    },
    stats() {
      return { clearTurnContextCalls, stopEvents, persistCalls, extractCalls, prepareAsContinuation };
    },
  };

  return host;
}

const host = createHost();
finalizeManagedAgentRun(host, "finished");
finalizeManagedAgentRun(host, "finished");
let stats = host.stats();
assert.equal(stats.clearTurnContextCalls, 1);
assert.equal(stats.stopEvents, 1);
assert.equal(stats.persistCalls, 1);
assert.equal(stats.extractCalls, 1);
assert.equal(stats.prepareAsContinuation, false);

host.resetTurnLifecycle();
finalizeManagedAgentRun(host, "aborted");
stats = host.stats();
assert.equal(stats.clearTurnContextCalls, 2);
assert.equal(stats.stopEvents, 2);
assert.equal(stats.extractCalls, 1);

// A wake turn (no user prompt) settles as `finished` but must not run memory extraction: there is
// nothing the user said to remember, and the notification + reply are not worth a side query.
host.resetTurnLifecycle();
host.setPromptless(true);
finalizeManagedAgentRun(host, "finished");
stats = host.stats();
assert.equal(stats.stopEvents, 3, "the promptless turn still finalizes normally");
assert.equal(stats.extractCalls, 1, "…but skips memory extraction");

// The mark is consumed, not sticky: the NEXT turn extracts again.
host.resetTurnLifecycle();
finalizeManagedAgentRun(host, "finished");
assert.equal(host.stats().extractCalls, 2, "the removal of the mark restores extraction");
// An aborted turn consumes it too, so a later turn cannot inherit it.
host.resetTurnLifecycle();
host.setPromptless(true);
finalizeManagedAgentRun(host, "aborted");
host.resetTurnLifecycle();
finalizeManagedAgentRun(host, "finished");
assert.equal(host.stats().extractCalls, 3, "an aborted promptless turn does not leak the mark");

console.log("run-finalize validation passed");
