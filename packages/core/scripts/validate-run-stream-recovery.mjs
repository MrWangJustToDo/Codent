/**
 * Validates stream recovery orchestrator (runStreamWithRecovery + helpers).
 *
 * Run: pnpm --filter @codent/core run validate:run-stream-recovery
 */

import assert from "node:assert/strict";

import {
  AgentUIChannel,
  armCapabilityStrip,
  extractRetryAfterSeconds,
  isTransientRetryableError,
  retryDelayMs,
  runStreamWithRecovery,
} from "../dist/dev.mjs";

// --- detectors ---

assert.equal(isTransientRetryableError(new Error("429 Too Many Requests")), true);
assert.equal(isTransientRetryableError(new Error("rate_limit_exceeded")), true);
assert.equal(isTransientRetryableError({ status: 429, message: "busy" }), true);
assert.equal(isTransientRetryableError(new Error("503 Service Unavailable")), true);
assert.equal(isTransientRetryableError(new Error("fetch failed")), true);
assert.equal(isTransientRetryableError(new Error("quota exceeded")), false);
assert.equal(isTransientRetryableError(new Error("insufficient_quota")), false);
assert.equal(isTransientRetryableError(new Error("invalid api key")), false);

// --- transport failures that arrive as the SDK's GENERIC sentinel ---------------
//
// The OpenAI SDK reports "the request never got a response" as the uninformative
// `Connection error.` and puts the actual cause on `error.cause`. That cause chain is
// dropped at the TanStack boundary (`toRunErrorPayload` keeps only `{ message, code }`,
// deliberately — it must not leak SDK state), so this predicate is the last place that can
// recognize the failure at all. These two assertions are the measured shapes: the first is
// literally what a run against an unreachable port produced, `code` included.

assert.equal(
  isTransientRetryableError({ message: "Connection error.", code: "undefined" }),
  true,
  "the SDK's generic connection sentinel is transient (code is stringified undefined)"
);
assert.equal(
  isTransientRetryableError(new Error("Connection error.")),
  true,
  "the bare Error form of the same sentinel is transient"
);

// A `cause`-only failure must still be caught — not by reading `cause` (it never reaches
// here), but because the SDK's own message for this case is the sentinel above.
assert.equal(
  isTransientRetryableError(Object.assign(new Error("Connection error."), { cause: new TypeError("fetch failed") })),
  true,
  "a cause-carrying connection error is matched on its message, not by walking cause"
);

// The undici / socket-level codes that survive as text when a provider passes them through.
for (const transport of [
  "ECONNREFUSED",
  "UND_ERR_SOCKET: other side closed",
  "socket hang up",
  "getaddrinfo ENOTFOUND upstream",
]) {
  assert.equal(isTransientRetryableError(new Error(transport)), true, `\`${transport}\` is transient`);
}

// The bare word "error" must NOT be swept up — a permanent rejection has to stay permanent,
// or a bad key turns into three pointless retries.
assert.equal(isTransientRetryableError(new Error("there was an error with your request")), false);
assert.equal(isTransientRetryableError(new Error("connection reset by peer is not a sentinel")), false);
assert.equal(isTransientRetryableError(new Error("billing hard limit reached")), false);

assert.equal(extractRetryAfterSeconds(new Error("please retry after 12 seconds")), 12);
assert.equal(extractRetryAfterSeconds({ retryAfter: 3, message: "429" }), 3);
assert.equal(extractRetryAfterSeconds(new Error("no hint")), undefined);

const delay0 = retryDelayMs(0);
assert.ok(delay0 >= 2000 && delay0 <= 2000 * 1.25);
assert.equal(retryDelayMs(0, 2), 2000);

// --- non-retryable RUN_ERROR still throws ---

async function* onlyRunError() {
  yield { type: "RUN_ERROR", message: "quota exceeded" };
}

let threw = false;
try {
  for await (const chunk of runStreamWithRecovery({
    managed: { parentId: "sub", run: makeRunCoordinatorStub(), usage: { hasCapability: () => true } },
    manager: {},
    getMessages: () => [],
    run: () => onlyRunError(),
  })) {
    assert.ok(chunk.type !== "RUN_ERROR");
  }
} catch (error) {
  threw = true;
  assert.equal(error instanceof Error ? error.message : String(error), "quota exceeded");
}
assert.equal(threw, true);

// --- the PRODUCTION shape: a transient RUN_ERROR chunk retries instead of dying ---
//
// The case above proves a permanent failure still throws. This is its counterpart, and it
// is the shape that actually reaches recovery in production: TanStack reports a failed
// request as a `RUN_ERROR` *chunk* (not a throw), carrying only `{ message, code }` after
// `toRunErrorPayload` drops the SDK error. Before the network sentinel covered `Connection
// error.`, this run died — two real turns were lost to exactly this, one after 932s.

let sentinelAttempts = 0;
async function* sentinelThenOk() {
  sentinelAttempts += 1;
  if (sentinelAttempts === 1) {
    yield { type: "RUN_ERROR", message: "Connection error.", code: "undefined" };
    return;
  }
  yield { type: "TEXT_MESSAGE_CONTENT", delta: "recovered" };
  yield { type: "RUN_FINISHED", finishReason: "stop" };
}

const sentinelManaged = {
  parentId: "sub-agent",
  run: makeRunCoordinatorStub(),
  usage: null,
  log: { warn() {}, debug() {}, error() {} },
  getUI: () => undefined,
  setError() {},
  setRetry() {},
  emitEvent() {},
};

const sentinelOut = [];
for await (const chunk of runStreamWithRecovery({
  managed: sentinelManaged,
  manager: {},
  getMessages: () => [{ role: "user", content: "hi" }],
  run: () => sentinelThenOk(),
})) {
  sentinelOut.push(chunk.type);
}

assert.equal(sentinelAttempts, 2, "the connection sentinel triggered a retry rather than ending the run");
assert.deepEqual(sentinelOut, ["TEXT_MESSAGE_CONTENT", "RUN_FINISHED"], "the retried stream is forwarded");

// --- 429 retries then succeeds (subagent-shaped managed; short Retry-After) ---

class RateLimitError extends Error {
  status = 429;
  retryAfter = 0.01;
  constructor() {
    super("429 Too Many Requests");
    this.name = "RateLimitError";
  }
}

let attempts = 0;
async function* flakyThenOk() {
  attempts += 1;
  if (attempts === 1) {
    throw new RateLimitError();
  }
  yield { type: "TEXT_MESSAGE_CONTENT", delta: "ok" };
  yield { type: "RUN_FINISHED", finishReason: "stop" };
}

const retryStates = [];
const retryEvents = [];

/** Minimal RunCoordinator surface the recovery loop + arm helper touch. */
function makeRunCoordinatorStub() {
  let drop = null;
  let continuation = false;
  return {
    resetWireOverride() {
      drop = null;
      continuation = false;
    },
    getMaxOutputTokensOverride: () => undefined,
    setMaxOutputTokensOverride: () => {},
    getWireDropPartTypes: () => drop,
    setWireDropPartTypes: (next) => {
      drop = next;
    },
    isWireContinuationArmed: () => continuation,
    setWireContinuationArmed: (next) => {
      continuation = next;
    },
  };
}

const managed = {
  parentId: "sub-agent",
  run: makeRunCoordinatorStub(),
  usage: null,
  log: { warn() {}, debug() {}, error() {} },
  getUI: () => undefined,
  setError() {},
  setRetry(state) {
    retryStates.push(state);
  },
  emitEvent(type, payload) {
    if (type === "agent:retry") retryEvents.push(payload);
  },
};
const msgs = [{ role: "user", content: "hi" }];

// --- capability strip is armed on the RUN, not by editing the messages handed in ---
//
// `compaction` rebuilds every wire call from the channel and discards
// `config.messages`, so a strip applied to the array passed to `run()` reaches the
// first call only. `armCapabilityStrip` stores the drop set on the run instead, and
// `wire-recovery` applies it after the projection (see validate-wire-override-reaches-adapter).

const stripRun = makeRunCoordinatorStub();
const stripManaged = {
  parentId: "sub-agent",
  run: stripRun,
  getUI: () => undefined,
  usage: { hasCapability: (cap) => cap !== "vision" },
  log: { warn() {}, debug() {}, error() {} },
};
assert.equal(armCapabilityStrip(stripManaged), true, "a model without vision arms a strip");
assert.deepEqual([...stripRun.getWireDropPartTypes()], ["image"], "only the unsupported modality is dropped");

const fullRun = makeRunCoordinatorStub();
assert.equal(
  armCapabilityStrip({
    parentId: undefined,
    run: fullRun,
    usage: { hasCapability: () => true },
    log: { warn() {}, debug() {}, error() {} },
  }),
  false,
  "a fully capable model arms no strip"
);
assert.equal(fullRun.getWireDropPartTypes(), null, "no drop set is stored when nothing is unsupported");

const out = [];
for await (const chunk of runStreamWithRecovery({
  managed,
  manager: {},
  getMessages: () => msgs,
  run: () => flakyThenOk(),
})) {
  out.push(chunk.type);
}
assert.equal(attempts, 2);
assert.deepEqual(out, ["TEXT_MESSAGE_CONTENT", "RUN_FINISHED"]);

// Retry visibility: one recorded retry, cleared once the stream recovers
assert.equal(retryStates.length, 2, "retry set on failure + cleared on recovery");
assert.equal(retryStates[0].attempt, 1);
assert.equal(retryStates[0].maxAttempts >= 1, true);
assert.equal(retryStates[0].strategy, "transient");
assert.match(retryStates[0].error, /429/);
assert.equal(typeof retryStates[0].delayMs, "number");
assert.equal(retryStates[1], null);
assert.equal(retryEvents.length, 1);
assert.equal(retryEvents[0].strategy, "transient");
assert.equal(retryEvents[0].attempt, 1);

// --- the SDK-normalized `retryAfterMs` on a RUN_ERROR drives the backoff --------
//
// @tanstack/ai 0.67+ resolves `retry-after` / `retry-after-ms` / an HTTP date into
// `retryAfterMs` on the RUN_ERROR (and mirrors it to `metadata.tanstack.retryAfterMs`).
// The loop must prefer that over its own header/message scraping — `extractRetryAfterSeconds`
// stays the fallback for a thrown error that never became a RUN_ERROR.

let msAttempts = 0;
async function* retryAfterMsThenOk() {
  msAttempts += 1;
  if (msAttempts === 1) {
    yield {
      type: "RUN_ERROR",
      message: "429 Too Many Requests",
      error: { message: "429 Too Many Requests" },
      retryAfterMs: 20,
    };
    return;
  }
  yield { type: "TEXT_MESSAGE_CONTENT", delta: "ok" };
  yield { type: "RUN_FINISHED", finishReason: "stop" };
}

const msRetryStates = [];
const msManaged = {
  parentId: "sub-agent",
  run: makeRunCoordinatorStub(),
  usage: null,
  log: { warn() {}, debug() {}, error() {} },
  getUI: () => undefined,
  setError() {},
  setRetry(state) {
    msRetryStates.push(state);
  },
  emitEvent() {},
};

const msOut = [];
for await (const chunk of runStreamWithRecovery({
  managed: msManaged,
  manager: {},
  getMessages: () => msgs,
  run: () => retryAfterMsThenOk(),
})) {
  msOut.push(chunk.type);
}
assert.equal(msAttempts, 2, "a RUN_ERROR carrying retryAfterMs is retried");
assert.deepEqual(msOut, ["TEXT_MESSAGE_CONTENT", "RUN_FINISHED"], "the retried stream is forwarded");
assert.equal(
  msRetryStates[0].retryAfterSeconds,
  0.02,
  "the provider retryAfterMs (20ms) drives the backoff, not header/message scraping"
);
assert.equal(msRetryStates[0].delayMs, 20, "the recorded delay matches the provider hint");

// --- subagent restart-style retry resets attempt-scoped UI, keeps its history ------
//
// A restart retry re-projects its wire from the channel (`compaction.onConfig`), so the channel IS
// the progress the retry resumes from. This seeds what a mid-exploration network drop leaves behind
// (prompt + the tool call already made) and asserts the retry still has it: wiping that history was
// subagent-only, which is exactly why a `task` restarted from its prompt.
class CountingChannel extends AgentUIChannel {
  resetCalls = 0;
  resetRetryUiState() {
    this.resetCalls += 1;
    super.resetRetryUiState();
  }
}

const subChannel = new CountingChannel({
  initialMessages: [
    {
      id: "sub-prompt",
      role: "user",
      parts: [{ type: "text", content: "find the test framework" }],
      createdAt: new Date(),
    },
    {
      id: "sub-progress",
      role: "assistant",
      parts: [{ type: "tool-call", id: "tc-1", name: "grep", arguments: '{"pattern":"vitest"}' }],
      createdAt: new Date(),
    },
  ],
});

attempts = 0;
let recoveryRetryCalls = 0;
let lastError = "stale";
const subManaged = {
  parentId: "parent-1",
  run: makeRunCoordinatorStub(),
  usage: null,
  log: { warn() {}, debug() {}, error() {} },
  setError(error) {
    lastError = error;
  },
  getUI: () => subChannel,
  statusController: {
    onRecoveryRetry() {
      recoveryRetryCalls += 1;
    },
  },
};

const subOut = [];
for await (const chunk of runStreamWithRecovery({
  managed: subManaged,
  manager: {},
  getMessages: () => subChannel.getMessages(),
  run: () => flakyThenOk(),
})) {
  subOut.push(chunk.type);
}
assert.equal(attempts, 2);
assert.equal(subChannel.resetCalls, 1, "subagent resets attempt-scoped UI before the restart retry");
assert.equal(subChannel.getMessages().length, 2, "…without discarding the exploration the retry resumes from");
assert.ok(
  subChannel.getMessages().some((m) => m.parts.some((p) => p.type === "tool-call" && p.id === "tc-1")),
  "the tool call the dead attempt already made is still in the channel"
);
assert.equal(recoveryRetryCalls, 1, "subagent should clear error status before backoff");
assert.equal(lastError, "");
assert.deepEqual(subOut, ["TEXT_MESSAGE_CONTENT", "RUN_FINISHED"]);

// --- the root takes the SAME attempt-scoped reset: no profile asymmetry -----------
//
// The reset is display-only, so applying it to the root changes nothing about its wire. This
// assertion pins the unification: the subagent-only branch is what made a `task` restart while the
// root resumed, and a gate that only covered the subagent side would let it come back unnoticed.
attempts = 0;
recoveryRetryCalls = 0;
const rootChannel = new CountingChannel({
  initialMessages: [
    {
      id: "root-prompt",
      role: "user",
      parts: [{ type: "text", content: "check the repo" }],
      createdAt: new Date(),
    },
    {
      id: "root-progress",
      role: "assistant",
      parts: [{ type: "tool-call", id: "tc-root", name: "grep", arguments: '{"pattern":"x"}' }],
      createdAt: new Date(),
    },
  ],
});
const rootManaged = {
  run: makeRunCoordinatorStub(),
  usage: null,
  log: { warn() {}, debug() {}, error() {} },
  setError() {},
  getUI: () => rootChannel,
  statusController: {
    onRecoveryRetry() {
      recoveryRetryCalls += 1;
    },
  },
};

for await (const chunk of runStreamWithRecovery({
  managed: rootManaged,
  manager: {},
  getMessages: () => rootChannel.getMessages(),
  run: () => flakyThenOk(),
})) {
  void chunk;
}
assert.equal(attempts, 2);
assert.equal(rootChannel.resetCalls, 1, "the root gets the same attempt-scoped reset as a subagent");
assert.equal(rootChannel.getMessages().length, 2, "and keeps its history too");
assert.equal(recoveryRetryCalls, 1, "root still clears error status via onRecoveryRetry");

// --- abort during retry backoff returns promptly and does not retry ---

class SlowRateLimit extends Error {
  status = 429;
  retryAfter = 5; // 5s backoff — far longer than the abort below
  constructor() {
    super("429 slow");
  }
}

let abortAttempts = 0;
// eslint-disable-next-line require-yield
async function* alwaysRateLimited() {
  abortAttempts += 1;
  throw new SlowRateLimit();
}

const abortManaged = {
  run: makeRunCoordinatorStub(),
  usage: null,
  log: { warn() {}, debug() {}, error() {} },
  setError() {},
  setRetry() {},
  emitEvent() {},
  getUI: () => undefined,
  statusController: { onRecoveryRetry() {} },
};

const controller = new AbortController();
setTimeout(() => controller.abort(), 30);
const startedAbort = Date.now();
let abortChunks = 0;
for await (const chunk of runStreamWithRecovery({
  managed: abortManaged,
  manager: {},
  getMessages: () => msgs,
  run: () => alwaysRateLimited(),
  signal: controller.signal,
})) {
  void chunk;
  abortChunks += 1;
}
const abortElapsed = Date.now() - startedAbort;
assert.equal(abortAttempts, 1, "no retry stream is started after abort during backoff");
assert.equal(abortChunks, 0);
assert.ok(abortElapsed < 1000, `abort returns promptly, took ${abortElapsed}ms`);

// --- aborting during backoff must clear the surfaced retry ---
//
// The early returns in the recovery loop exit without a terminal status change, so
// nothing else unwinds the `AgentRetryState` recorded for the attempt that just ended:
// `clearRetryOnNextChunk` never fires and `setStatus`'s terminal branch never runs.
// A host still rendering that snapshot would keep showing "Retrying (1/3) …".

{
  const seenRetryStates = [];
  const abortClearManaged = {
    run: makeRunCoordinatorStub(),
    usage: null,
    log: { warn() {}, debug() {}, error() {} },
    setError() {},
    setRetry(state) {
      seenRetryStates.push(state);
    },
    emitEvent() {},
    // Deliberately no terminal setStatus: models a host that keeps rendering the
    // live snapshot after the run is torn down.
    statusController: { onRecoveryRetry() {} },
  };

  const clearController = new AbortController();
  setTimeout(() => clearController.abort(), 30);
  for await (const chunk of runStreamWithRecovery({
    managed: abortClearManaged,
    manager: {},
    getMessages: () => msgs,
    run: () => alwaysRateLimited(),
    signal: clearController.signal,
  })) {
    void chunk;
  }

  assert.ok(seenRetryStates.length >= 2, "the retry is recorded, then unwound");
  assert.equal(seenRetryStates.at(-1), null, "an abort during backoff must clear the surfaced retry state");
}

// --- truncation continuations stay within their own cap and never report over-budget ---

{
  const truncationRetries = [];
  let truncationAttempts = 0;
  const escalations = [];
  const truncationManaged = {
    run: {
      ...makeRunCoordinatorStub(),
      setMaxOutputTokensOverride(max) {
        escalations.push(max);
      },
    },
    usage: null,
    log: { warn() {}, debug() {}, error() {} },
    setError() {},
    setRetry(state) {
      if (state) truncationRetries.push(state);
    },
    emitEvent() {},
    statusController: { onRecoveryRetry() {} },
  };

  async function* alwaysTruncated() {
    truncationAttempts += 1;
    yield { type: "TEXT_MESSAGE_CONTENT", delta: "partial" };
    yield { type: "RUN_FINISHED", finishReason: "length" };
  }

  for await (const chunk of runStreamWithRecovery({
    managed: truncationManaged,
    manager: {},
    getMessages: () => msgs,
    run: () => alwaysTruncated(),
    runner: {},
  })) {
    void chunk;
  }

  // 1 escalation + MAX_TRUNCATION_CONTINUATIONS continuations each record a retry,
  // then one final stream reveals the budget is exhausted (that one arms nothing).
  // The loop can only learn the budget is exhausted by running the next stream, so
  // exactly one more model call happens than "useful" budget units.
  assert.equal(escalations.length, 1, "max_tokens is escalated exactly once");
  assert.equal(truncationAttempts, 5, "1 escalation + 3 continuations + 1 exhaust probe");
  assert.equal(truncationRetries.length, 4, "the escalation plus 3 continuations are reported");
  for (const state of truncationRetries) {
    assert.equal(
      state.attempt <= state.maxAttempts,
      true,
      `truncation retry attempt ${state.attempt} must not exceed ${state.maxAttempts}`
    );
    assert.equal(state.strategy, "max_tokens");
  }
}

// --- a truncated run still has its full transient backoff available ---
//
// Continuations used to consume the shared `MAX_RECOVERY_ATTEMPTS` budget, so a run
// that truncated a few times then hit a 429 was denied its only backoff.

{
  const mixedRetries = [];
  let mixedAttempts = 0;
  const mixedManaged = {
    run: makeRunCoordinatorStub(),
    usage: null,
    log: { warn() {}, debug() {}, error() {} },
    setError() {},
    setRetry(state) {
      if (state) mixedRetries.push(state);
    },
    emitEvent() {},
    statusController: { onRecoveryRetry() {} },
  };

  // Truncate once, then 429 once, then succeed.
  async function* truncateThenRateLimit() {
    mixedAttempts += 1;
    if (mixedAttempts === 1) {
      yield { type: "TEXT_MESSAGE_CONTENT", delta: "partial" };
      yield { type: "RUN_FINISHED", finishReason: "length" };
      return;
    }
    if (mixedAttempts === 2) throw new RateLimitError();
    yield { type: "TEXT_MESSAGE_CONTENT", delta: "ok" };
    yield { type: "RUN_FINISHED", finishReason: "stop" };
  }

  const mixedOut = [];
  for await (const chunk of runStreamWithRecovery({
    managed: mixedManaged,
    manager: {},
    getMessages: () => msgs,
    run: () => truncateThenRateLimit(),
    runner: {},
  })) {
    mixedOut.push(chunk.type);
  }

  assert.equal(mixedAttempts, 3, "truncation → 429 → success all ran");
  assert.deepEqual(mixedOut, ["TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_CONTENT", "RUN_FINISHED"]);
  assert.deepEqual(
    mixedRetries.map((state) => state.strategy),
    ["max_tokens", "transient"],
    "the 429 still gets its backoff after a truncation continuation"
  );
  assert.equal(mixedRetries[1].attempt, 1, "the transient budget starts fresh, not depleted by truncation");
}

// --- already-aborted signal never starts a stream ---

const preAborted = new AbortController();
preAborted.abort();
let preAttempts = 0;
for await (const chunk of runStreamWithRecovery({
  managed: abortManaged,
  manager: {},
  getMessages: () => msgs,
  run: () => {
    preAttempts += 1;
    return onlyRunError();
  },
  signal: preAborted.signal,
})) {
  void chunk;
}
assert.equal(preAttempts, 0, "no stream starts when the signal is already aborted");

console.log("run-stream-recovery validation passed");
