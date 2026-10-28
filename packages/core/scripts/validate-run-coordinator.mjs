/**
 * Validates RunCoordinator abort wiring and pending abort, plus the
 * CompactionService reactive-compact retry budget.
 *
 * Run: pnpm --filter @codent/core run validate:run-coordinator
 */
/* eslint-disable no-undef */
import assert from "node:assert/strict";

import { AgentRunner, RunCoordinator, CompactionService } from "../dist/dev.mjs";

const coordinator = new RunCoordinator();

assert.equal(coordinator.isAbortError(new DOMException("aborted", "AbortError")), true);
assert.equal(coordinator.isAbortError(new Error("network timeout")), false);

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
