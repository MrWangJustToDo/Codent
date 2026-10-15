/**
 * Validates reactive compaction helpers and compaction start event kinds.
 *
 * Requires a prior package build (`pnpm run build`) so imports resolve from `dist/dev.mjs`.
 * This smoke does not call a live model — it only checks status/event wiring.
 *
 * Run: pnpm --filter @codent/core run validate:reactive-compact
 */

import assert from "node:assert/strict";

import {
  CONTEXT_OVERFLOW_CODES,
  isPromptTooLongError,
  extractRunErrorMessage,
  attachRunErrorCode,
  attachRunErrorRetryAfterMs,
  throwOnRunError,
  createAgentStatusController,
  reactiveCompact,
  handleManagedReactiveCompact,
  AgentUIChannel,
  UsageTracker,
  CompactionService,
} from "../dist/dev.mjs";

// ============================================================================
// Overflow detection
// ============================================================================
//
// Two independent ways in, and the earlier version of this file covered only one:
// every assertion below used to be prose, so the classifier could (and did) ignore
// the provider's stable `code` without any check noticing. The code path is the
// primary one now — it is what makes the check survive a provider rewording its
// error — so it is asserted first, and the prose list is asserted as the fallback
// it is.

// --- code-first: the provider's own identifier, no prose required ---------------
for (const code of CONTEXT_OVERFLOW_CODES) {
  const error = Object.assign(new Error("upstream rejected the request"), { code });
  assert.equal(isPromptTooLongError(error), true, `code "${code}" must classify as overflow`);
}

// The code is matched case-insensitively: `attachRunErrorCode` copies the provider's
// spelling verbatim, and a gateway may capitalize it.
assert.equal(
  isPromptTooLongError(Object.assign(new Error("nope"), { code: "CONTEXT_OVERFLOW" })),
  true,
  "a differently-cased code must still classify"
);

// A RUN_ERROR chunk handed through unchanged (the shape `throwOnRunError` receives)
// must classify from its `code`, because that is where the SDK puts it.
assert.equal(
  isPromptTooLongError({ type: "RUN_ERROR", code: "context_overflow", message: "whatever the provider said" }),
  true,
  "a RUN_ERROR chunk must classify from `code`"
);
// ...and from its *message*, which for a chunk lives under `error`/`message`, not on
// the object itself — the reason `errorMessage()` alone was not enough.
assert.equal(
  isPromptTooLongError({ type: "RUN_ERROR", message: "", error: "prompt is too long" }),
  true,
  "a RUN_ERROR chunk must classify from its nested message"
);

// --- prose fallback: the two spellings that were missing, and the originals ---
// These are the ones a real overflow actually carried and that the old list missed.
for (const message of ["prompt is too long: 210000 tokens > 200000 maximum", "context_length_exceeded"]) {
  assert.equal(isPromptTooLongError(new Error(message)), true, `prose fallback must match: ${message}`);
}
// The original list is not regressed by the rewrite.
for (const message of [
  "prompt_too_long",
  "context length exceeded",
  "too many tokens",
  "max tokens exceeded",
  "maximum context length",
  "request too large",
]) {
  assert.equal(isPromptTooLongError(new Error(message)), true, `original prose entry must still match: ${message}`);
}

// --- negatives: an unrelated failure, and a code that only looks like one --------
assert.equal(isPromptTooLongError(new Error("network timeout")), false);
assert.equal(isPromptTooLongError(new Error("invalid api key")), false);
assert.equal(isPromptTooLongError(Object.assign(new Error("rate limited"), { code: "429" })), false);
assert.equal(isPromptTooLongError(undefined), false);

// --- the carried signals survive `throwOnRunError` -------------------------------
// Regression: the thrown error used to be a bare `new Error(message)`, so `code` and
// `retryAfterMs` — both of which the chunk route preserves — were dropped on this
// one. An overflow arriving here was then classified by prose alone.
{
  async function* oneError() {
    yield {
      type: "RUN_ERROR",
      message: "upstream rejected the request",
      code: "context_overflow",
      metadata: { tanstack: { retryAfterMs: 2500 } },
    };
  }
  let thrown;
  try {
    for await (const chunk of throwOnRunError(oneError())) {
      void chunk;
    }
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error, "throwOnRunError must throw on RUN_ERROR");
  assert.equal(thrown.code, "context_overflow", "the thrown error must carry the chunk's code");
  assert.equal(thrown.retryAfterMs, 2500, "the thrown error must carry the normalized retry hint");
  assert.equal(isPromptTooLongError(thrown), true, "the thrown error must classify as overflow without prose");
}

// --- the two attach helpers agree with each other and with the chunk route -------
{
  const chunk = { type: "RUN_ERROR", code: "context_overflow", metadata: { tanstack: { retryAfterMs: 900 } } };
  const withCode = attachRunErrorCode(new Error("x"), chunk);
  const withBoth = attachRunErrorRetryAfterMs(withCode, chunk);
  assert.equal(withBoth.code, "context_overflow");
  assert.equal(withBoth.retryAfterMs, 900);

  // Idempotent, and an existing value is never overwritten.
  const again = attachRunErrorRetryAfterMs(withBoth, chunk);
  assert.equal(again.retryAfterMs, 900);

  const preSet = Object.assign(new Error("x"), { code: "my-own", retryAfterMs: 1 });
  const kept = attachRunErrorRetryAfterMs(attachRunErrorCode(preSet, chunk), chunk);
  assert.equal(kept.code, "my-own", "an error's own code wins over the chunk's");
  assert.equal(kept.retryAfterMs, 1, "an error's own retry hint wins over the chunk's");

  // The SDK stringifies an absent code into the literal "undefined" — not a signal.
  const noCode = attachRunErrorCode(new Error("x"), { type: "RUN_ERROR", code: "undefined" });
  assert.equal(noCode.code, undefined, "the literal string 'undefined' is not a code");

  // A non-RUN_ERROR chunk must not be mined for signals.
  const fromText = attachRunErrorRetryAfterMs(
    attachRunErrorCode(new Error("x"), { type: "TEXT_MESSAGE_CONTENT", code: "context_overflow" }),
    { type: "TEXT_MESSAGE_CONTENT", metadata: { tanstack: { retryAfterMs: 5 } } }
  );
  assert.equal(fromText.code, undefined, "a non-error chunk must not contribute a code");
  assert.equal(fromText.retryAfterMs, undefined, "a non-error chunk must not contribute a retry hint");
}

assert.equal(extractRunErrorMessage({ type: "TEXT_MESSAGE_CONTENT", delta: "hi" }), "");
assert.equal(
  extractRunErrorMessage({ type: "RUN_ERROR", message: "prompt_too_long: request too large" }),
  "prompt_too_long: request too large"
);
assert.equal(extractRunErrorMessage({ type: "RUN_ERROR", error: { message: "too many tokens" } }), "too many tokens");

const events = [];
let status = "running";

const statusController = createAgentStatusController({
  getStatus: () => status,
  setStatus: (next) => {
    status = next;
  },
  getError: () => "",
  setError: () => {},
  setPendingApprovalCount: () => {},
  emitEvent: (type, data) => events.push({ type, data }),
});

statusController.beginCompaction("auto");
assert.equal(status, "compacting");
assert.deepEqual(
  events.map((e) => e.type),
  ["compaction:auto-start"]
);

events.length = 0;
status = "running";
statusController.beginCompaction("reactive", { retry: 1, maxRetries: 1 });
assert.equal(status, "compacting");
assert.deepEqual(
  events.map((e) => e.type),
  ["compaction:reactive-start"]
);
assert.equal(events[0].data?.retry, 1);
assert.ok(!events.some((e) => e.type === "compaction:auto-start"));

console.log("reactive-compact validation passed");

// ============================================================================
// Token-budget tail (replaces the fixed 5-message count)
// ============================================================================

// Manager whose getAgent throws — reactiveCompact must fall back to the static
// emergency summary instead of propagating, so we can exercise tail selection.
const throwingManager = {
  getAgent: () => {
    throw new Error("no registry in this test");
  },
};

function bigToolConversation() {
  const messages = [];
  let callId = 0;
  for (let turn = 0; turn < 3; turn++) {
    messages.push({ role: "user", content: `task ${turn} — ${"u".repeat(2_000)}` });
    for (let i = 0; i < 3; i++) {
      messages.push({
        role: "assistant",
        content: [{ type: "text", content: "working" }],
        toolCalls: [{ id: `c${callId}`, type: "function", function: { name: "run_command", arguments: "{}" } }],
      });
      messages.push({
        role: "tool",
        toolCallId: `c${callId}`,
        content: [{ type: "text", content: "r".repeat(6_000) }],
      });
      callId++;
    }
  }
  return messages;
}

{
  const messages = bigToolConversation();
  const result = await reactiveCompact(messages, "agent-x", throwingManager, { keepRecentTokens: 8_000 });

  // Progress guaranteed: something was summarized.
  assert.ok(result.length < messages.length, "tail budget must shrink the wire");
  assert.equal(result[0].role, "user");
  assert.ok(String(result[0].content).includes("[Emergency reactive compaction performed."));

  // Tail is pairing-safe: every kept tool result has its call kept too.
  const tail = result.slice(1);
  const keptCallIds = new Set(tail.flatMap((m) => (m.toolCalls ?? []).map((tc) => tc.id)));
  for (const m of tail) {
    if (m.role === "tool") assert.ok(keptCallIds.has(m.toolCallId), "orphaned tool result in reactive tail");
  }
  assert.notEqual(tail[0].role, "tool", "tail must not start on a tool result");
  console.log(`token-budget tail kept ${tail.length}/${messages.length} messages with intact pairs`);
}

// Emergency degrade: everything fits the budget → still cut at a safe boundary.
{
  const small = Array.from({ length: 10 }, (_, i) => ({ role: "user", content: `msg ${i}` }));
  const result = await reactiveCompact(small, "agent-y", throwingManager, { keepRecentTokens: 1_000_000 });
  assert.equal(result.length, 2, "degrade keeps only the last valid boundary message");
  assert.equal(result[1].content, "msg 9");
  console.log("emergency degrade path (cut even when input fits budget) OK");
}

console.log("reactive token-budget validation passed");

// ============================================================================
// `handleManagedReactiveCompact` — the ManagedAgent end of the reactive path
// ============================================================================
//
// The helper coverage above cannot see this layer's four decisions, and each one is a
// real failure mode rather than a detail:
//
//   1. the gates (subagent / not-prompt-too-long / budget exhausted / no channel) must
//      return false *without* touching the channel or the status;
//   2. a successful pass must append exactly one summary to the live channel, unwind the
//      status back off "compacting", and emit the reactive-start/complete pair;
//   3. a mid-pass throw must also unwind — otherwise the agent stays stuck in "compacting"
//      and blocks the stream-recovery loop's other strategies (capability / transient);
//   4. a user cancel is not a failure and must be silent (no `compaction:reactive-error`).
//
// Runs against a fake host, so no settings, no model and no CoreEnv are involved.
// `getMessagesForLLM` returns a pre-built oversized wire; `getCanonicalFromUI` is a stub
// because only its identity matters (nothing here reads the canonical chain).

function oversizedWire() {
  const messages = [];
  let callId = 0;
  for (let turn = 0; turn < 3; turn++) {
    messages.push({ role: "user", content: `task ${turn} — ${"u".repeat(2_000)}` });
    for (let i = 0; i < 3; i++) {
      messages.push({
        role: "assistant",
        content: [{ type: "text", content: "working" }],
        toolCalls: [{ id: `rc${callId}`, type: "function", function: { name: "run_command", arguments: "{}" } }],
      });
      messages.push({
        role: "tool",
        toolCallId: `rc${callId}`,
        content: [{ type: "text", content: "r".repeat(6_000) }],
      });
      callId++;
    }
  }
  return messages;
}

{
  const events = [];
  let status = "running";
  const channel = new AgentUIChannel();
  const usage = new UsageTracker();
  const compaction = new CompactionService();
  const manager = { getAgent: () => undefined };

  const host = {
    id: "agent-rc",
    getUI: () => channel,
    usage,
    compaction,
    statusController: createAgentStatusController({
      getStatus: () => status,
      setStatus: (next) => {
        status = next;
      },
      getError: () => "",
      setError: () => {},
      setPendingApprovalCount: () => {},
      emitEvent: (type, data) => events.push({ type, data }),
    }),
    getCanonicalFromUI: () => [],
    getMessagesForLLM: () => oversizedWire(),
    emitEvent: (type, data) => events.push({ type, data }),
    getContextWindow: () => 0,
    getCoreEnv: () => ({
      rootPath: "/tmp",
      fs: {},
      path: {},
      runCommand: async () => ({}),
      exec: async () => ({}),
      fetch: async () => new Response(""),
      getPlatform: async () => "linux",
      getArch: async () => "x64",
      getEnv: async () => ({}),
      homedir: async () => "/tmp",
    }),
    compactionConfig: { keepRecentTokens: 8_000 },
  };

  // --- gate: a subagent never reactive-compacts -------------------------------------
  assert.equal(
    await handleManagedReactiveCompact({ ...host, parentId: "parent-1" }, new Error("prompt_too_long"), manager),
    false,
    "a subagent must not reactive-compact"
  );
  assert.equal(channel.getMessages().length, 0, "a gated call must not touch the channel");
  assert.equal(status, "running", "a gated call must not touch the status");

  // --- gate: any other error is not a reactive-compaction trigger -------------------
  assert.equal(
    await handleManagedReactiveCompact(host, new Error("network timeout"), manager),
    false,
    "a non-prompt-too-long error must not trigger reactive compaction"
  );

  // --- gate: the retry budget, and the event that explains the refusal ---------------
  compaction.reactiveCompactRetries = compaction.getMaxReactiveCompactRetries();
  const budgetEvents = [];
  const overBudget = {
    ...host,
    emitEvent: (type, data) => budgetEvents.push({ type, data }),
  };
  assert.equal(
    await handleManagedReactiveCompact(overBudget, new Error("prompt_too_long"), manager),
    false,
    "an exhausted retry budget must refuse"
  );
  assert.deepEqual(
    budgetEvents.map((e) => e.type),
    ["compaction:reactive-max-retries"],
    "the refusal must be observable as compaction:reactive-max-retries"
  );
  compaction.resetReactiveCompactRetries();

  // --- gate: no channel means nothing to compact ------------------------------------
  assert.equal(
    await handleManagedReactiveCompact({ ...host, getUI: () => undefined }, new Error("prompt_too_long"), manager),
    false,
    "without a UI channel there is nothing to compact"
  );

  // --- the happy path ---------------------------------------------------------------
  events.length = 0;
  const ok = await handleManagedReactiveCompact(host, new Error("prompt_too_long: request too large"), manager);
  assert.equal(ok, true, "a prompt-too-long error with budget must compact and report success");
  const kinds = events.map((e) => e.type);
  assert.ok(kinds.includes("compaction:reactive-start"), "the start event must be emitted");
  assert.ok(kinds.includes("compaction:reactive-complete"), "the complete event must be emitted");
  assert.ok(!kinds.includes("compaction:reactive-error"), "a success must not emit an error event");
  assert.equal(status, "running", "the status must unwind off 'compacting' on success");

  const appended = channel.getMessages();
  assert.equal(appended.length, 1, "exactly one summary checkpoint is appended");
  assert.ok(
    JSON.stringify(appended[0]).includes("reactive compaction performed"),
    "the appended checkpoint must carry the compaction summary text"
  );

  const complete = events.find((e) => e.type === "compaction:reactive-complete");
  assert.ok(
    complete.data.tokensBefore >= 0 && complete.data.tokensAfter >= 0,
    "the complete event must carry before/after tokens"
  );
  assert.ok(complete.data.compactedCount <= complete.data.originalCount, "compaction cannot grow the wire");
  console.log(
    `reactive ManagedAgent path: gates held, summary appended, status unwound (${complete.data.originalCount} → ${complete.data.compactedCount} messages)`
  );
}

// --- failure/cancel unwind: the status must never stay stuck in "compacting" --------
// The failure is injected at `getMessagesForLLM` (inside the try, before the summarizer)
// rather than at the summarizer: `reactiveCompact` *swallows* a summarizer failure and
// degrades to the static emergency summary, so a throwing manager there still returns true
// and would not exercise this catch at all.
for (const [label, error, expectSilent] of [
  ["throwing wire build", new Error("wire build exploded"), false],
  ["user cancel", Object.assign(new Error("The operation was aborted"), { name: "AbortError" }), true],
]) {
  const events = [];
  let status = "running";
  const channel = new AgentUIChannel();
  const usage = new UsageTracker();
  const compaction = new CompactionService();
  const manager = { getAgent: () => undefined };

  const host = {
    id: `agent-${label.replace(/\s+/g, "-")}`,
    getUI: () => channel,
    usage,
    compaction,
    statusController: createAgentStatusController({
      getStatus: () => status,
      setStatus: (next) => {
        status = next;
      },
      getError: () => "",
      setError: () => {},
      setPendingApprovalCount: () => {},
      emitEvent: (type, data) => events.push({ type, data }),
    }),
    getCanonicalFromUI: () => [],
    getMessagesForLLM: () => {
      throw error;
    },
    emitEvent: (type, data) => events.push({ type, data }),
    getContextWindow: () => 0,
    getCoreEnv: () => ({
      rootPath: "/tmp",
      fs: {},
      path: {},
      runCommand: async () => ({}),
      exec: async () => ({}),
      fetch: async () => new Response(""),
      getPlatform: async () => "linux",
      getArch: async () => "x64",
      getEnv: async () => ({}),
      homedir: async () => "/tmp",
    }),
    compactionConfig: { keepRecentTokens: 8_000 },
  };

  const result = await handleManagedReactiveCompact(host, new Error("prompt_too_long"), manager);
  assert.equal(result, false, `${label}: an unsuccessful pass must report false`);
  assert.equal(status, "running", `${label}: the status must unwind off 'compacting'`);
  assert.equal(channel.getMessages().length, 0, `${label}: the channel must be untouched`);
  const errored = events.some((e) => e.type === "compaction:reactive-error");
  if (expectSilent) {
    assert.equal(errored, false, `${label}: a user cancel must not be reported as a compaction error`);
  } else {
    assert.equal(errored, true, `${label}: a real failure must be reported as compaction:reactive-error`);
  }
  console.log(`reactive unwind on ${label}: status unwound${expectSilent ? ", silent" : ", error emitted"}`);
}

console.log("reactive ManagedAgent path validation passed");
