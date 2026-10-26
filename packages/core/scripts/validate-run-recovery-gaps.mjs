/**
 * Regression gate for the P1 concurrency/state fixes from the core review.
 *
 * 1. **Steering is not stranded while waiting (P1-4).** With a pending approval and
 *    no pump running, typed input used to sit in the steering queue until the
 *    approval was answered. `shouldDeferMidRunQueue` already treats `waiting` as
 *    "queue it" — this pins the *classification*, which is the whole mechanism: the
 *    message is deferred so the resume pump drains it.
 * 2. **Interceptors are isolated (P1-11).** A throwing `tool:before:*` interceptor
 *    must not fail the tool call it wraps — the other extension channels
 *    (transformers, context providers, wildcard observers) were already isolated.
 * 3. **An exhausted truncation is not reported as a clean stop (P1-5).** The
 *    recovery layer swallowed the original `RUN_FINISHED` and, once the continuation
 *    budget ran out, ended the stream with no terminal chunk. Consumers that read
 *    the finish reason (subagent run stats) then saw a complete run.
 *
 * Run: pnpm --filter @codent/core run validate-run-recovery-gaps
 */

import assert from "node:assert/strict";

import {
  createAgentEventBus,
  createTruncationState,
  handleMaxTokensTruncation,
  shouldDeferMidRunQueue,
} from "../dist/dev.mjs";

// ---------------------------------------------------------------------------
// 1. Mid-run input while waiting is queued, not lost (P1-4)
// ---------------------------------------------------------------------------
{
  // Waiting on an approval with no pump: `pumpDepth` is 0, but the message must be
  // deferred to the queue the resume pump will drain.
  assert.equal(
    shouldDeferMidRunQueue({ pumpDepth: 0, status: "waiting" }),
    true,
    "input while waiting on approval is queued for the resume pump"
  );
  assert.equal(
    shouldDeferMidRunQueue({ pumpDepth: 0, status: "awaiting_user" }),
    true,
    "input while awaiting the user is queued"
  );
  // A live pump always queues.
  assert.equal(shouldDeferMidRunQueue({ pumpDepth: 1, status: "running" }), true);
  // A stale active status with no pump must send immediately, or the message would
  // be trapped in a queue nothing drains.
  assert.equal(
    shouldDeferMidRunQueue({ pumpDepth: 0, status: "running" }),
    false,
    "a stale running status with no pump does not trap input"
  );
}

// ---------------------------------------------------------------------------
// 2. A throwing interceptor is contained (P1-11)
// ---------------------------------------------------------------------------
{
  const seen = [];
  const bus = createAgentEventBus("test", (info) => seen.push(info));

  const order = [];
  bus.onIntercept("tool:before:*", () => {
    order.push("throwing");
    throw new Error("broken extension");
  });
  bus.onIntercept("tool:before:*", () => {
    order.push("healthy");
    return undefined;
  });

  // Must not reject: the throw is contained and the chain continues.
  const result = await bus.intercept({
    type: "tool:before:run_command",
    payload: { args: {} },
    defaultReturn: undefined,
  });

  assert.equal(result, undefined);
  assert.deepEqual(order, ["throwing", "healthy"], "the chain continues past the throwing interceptor");
  assert.equal(seen.length, 1, "the failure is reported");
  assert.equal(seen[0].pattern, "tool:before:*");
  assert.equal(seen[0].event, "tool:before:run_command");
  assert.match(String(seen[0].error.message), /broken extension/);

  // A healthy interceptor that cancels still cancels.
  const cancelBus = createAgentEventBus();
  cancelBus.onIntercept("tool:before:*", () => false);
  const cancelled = await cancelBus.intercept({
    type: "tool:before:read_file",
    payload: { args: {} },
    defaultReturn: { ok: true },
  });
  assert.equal(cancelled, undefined, "an explicit cancel still short-circuits");
}

// ---------------------------------------------------------------------------
// 3. Truncation budget exhaustion is distinguishable (P1-5)
// ---------------------------------------------------------------------------
{
  // A minimal managed stub: `handleMaxTokensTruncation` only touches `log`,
  // `run.setWireContinuationArmed`, and the runner's max output tokens.
  const observed = { continuationArmed: false, maxOutputTokens: 0 };
  const managed = {
    log: { debug() {}, warn() {} },
    run: {
      setWireContinuationArmed(value) {
        observed.continuationArmed = value;
      },
      setMaxOutputTokensOverride(value) {
        observed.maxOutputTokens = value;
      },
    },
  };
  const runner = {};

  const truncation = createTruncationState();

  // 1st: escalate. 2nd+: continue.
  const first = handleMaxTokensTruncation({ managed, runner, truncation });
  assert.equal(first.shouldRetry, true, "first truncation escalates max_tokens");
  assert.ok(observed.maxOutputTokens > 0, "the escalation reached the run scope");

  let continuations = 0;
  while (handleMaxTokensTruncation({ managed, runner, truncation }).shouldRetry) {
    continuations += 1;
    assert.ok(continuations < 20, "the continuation budget is finite");
  }
  assert.ok(continuations > 0, "continuations were attempted");
  assert.equal(observed.continuationArmed, true, "a continuation armed the wire prompt");

  // Exhausted: this is the state the recovery layer used to swallow silently — it
  // must be reported as "no retry", which is what makes the caller emit a terminal
  // truncated finish instead of a clean one.
  const exhausted = handleMaxTokensTruncation({ managed, runner, truncation });
  assert.equal(exhausted.shouldRetry, false, "an exhausted budget stops retrying (not silently retried)");
}

console.log("run-recovery-gaps validation passed");
