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
  isPromptTooLongError,
  extractRunErrorMessage,
  createAgentStatusController,
  reactiveCompact,
  handleManagedReactiveCompact,
  AgentUIChannel,
  UsageTracker,
  CompactionService,
} from "../dist/dev.mjs";

assert.equal(isPromptTooLongError(new Error("prompt_too_long")), true);
assert.equal(isPromptTooLongError(new Error("context length exceeded")), true);
assert.equal(isPromptTooLongError(new Error("network timeout")), false);

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
