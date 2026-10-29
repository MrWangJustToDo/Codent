/**
 * Validates RunCoordinator abort wiring and pending abort, plus the
 * CompactionService reactive-compact retry budget.
 *
 * Run: pnpm --filter @codent/core run validate:run-coordinator
 */
/* eslint-disable no-undef */
import assert from "node:assert/strict";

import {
  AgentRunner,
  RunCoordinator,
  CompactionService,
  compactionAbortError,
  isAbortError,
  isCompactionCancel,
} from "../dist/dev.mjs";

const coordinator = new RunCoordinator();

assert.equal(coordinator.isAbortError(new DOMException("aborted", "AbortError")), true);
assert.equal(coordinator.isAbortError(new Error("network timeout")), false);

// Compaction's cancel rule is stricter than the general predicate: its summarizer's "no summary"
// error names its own flag (`wasAborted=false`), and the network stack raises `AbortError` for its
// own timeouts. Treating either as a cancel released the lease without arming the retry backoff,
// so every later model call started another full summarizer. Only the compaction signal or the
// tagged error the summarizer boundary raises counts.
const liveSignal = new AbortController().signal;
assert.equal(
  isCompactionCancel(new Error("upstream request aborted"), liveSignal),
  false,
  "a message containing 'aborted' under a live signal is a failure"
);
assert.equal(
  isCompactionCancel(new Error("Compaction subagent returned no summary (wasAborted=false)"), liveSignal),
  false,
  "the summarizer's own diagnostic is not a cancel"
);
assert.equal(
  isCompactionCancel(new DOMException("aborted", "AbortError"), liveSignal),
  false,
  "a bare AbortError (network timeout) is not a compaction cancel"
);
assert.equal(isCompactionCancel(compactionAbortError(), liveSignal), true, "the tagged summarizer cancel is");
assert.equal(isCompactionCancel(new Error("boom"), AbortSignal.abort()), true, "an aborted compaction signal is");
assert.equal(
  isAbortError(new Error("aborted"), liveSignal),
  true,
  "the general predicate keeps its documented message fallback"
);

// Reactive-compact retry budget (CompactionService)
const compaction = new CompactionService();
assert.equal(compaction.canRetryReactiveCompact(), true);
assert.equal(compaction.recordReactiveCompactRetry(), 1);
compaction.resetReactiveCompactRetries();
assert.equal(compaction.canRetryReactiveCompact(), true);
assert.equal(compaction.getMaxReactiveCompactRetries() > 0, true);

{
  let status = "running";
  coordinator.setupAbortController(undefined, {
    onAborted: () => {
      status = "aborted";
    },
  });
  const pending = new AbortController();
  coordinator.addPendingAbortController(pending);
  const runController = coordinator.currentAbortController;
  assert.ok(runController);

  // AgentRunner must reuse the RunCoordinator controller identity (main/subagent abort path).
  const chatController = AgentRunner.resolveAbortController({ abortController: runController });
  assert.equal(chatController, runController);

  coordinator.abort("user-cancelled");
  assert.equal(status, "aborted");
  assert.equal(runController.signal.aborted, true);
  assert.equal(pending.signal.aborted, true);
}

// An abort that lands in a LATER task must target the run it belongs to. The timer used to read
// `this.currentAbortController` when it fired, so a run prepared in between was aborted instead.
{
  const late = new RunCoordinator();
  const external = new AbortController();
  late.setupAbortController(external.signal, { onAborted: () => {} });
  const first = late.currentAbortController;

  // This aborts the first run's external signal: the listener schedules a `setTimeout` for it.
  external.abort("user-cancelled");

  // A new run starts before that timer fires.
  let secondAborted = false;
  late.setupAbortController(undefined, {
    onAborted: () => {
      secondAborted = true;
    },
  });
  const second = late.currentAbortController;

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(first.signal.aborted, true, "the first run's controller is the one the timer aborts");
  assert.equal(second.signal.aborted, false, "a late abort timer must not abort the next run");
  assert.equal(secondAborted, false, "…nor trip its aborted listener");
}

console.log("run-coordinator validation passed");
