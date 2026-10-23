/**
 * Validates the repeat-tool-call reminder middleware:
 * - canonical argument matching (property-order independent)
 * - threshold escalation (gentle at the first threshold, detailed later) + arg preview cap
 * - `<ctx kind=repeat_tool_reminder>` shell format
 * - genuine-user-message detection (synthetic `<ctx ...>` is not a prompt)
 * - end-to-end loop detection: identical calls count up, a different call resets,
 *   excluded tools never count, a new user prompt resets, and the reminder is
 *   injected (channel + wire) on the next onConfig, or transiently without a channel.
 *
 * Run: pnpm --filter @codent/core run validate:repeat-reminder
 */

import assert from "node:assert/strict";

import {
  buildRepeatReminderContent,
  canonicalizeRepeatArguments,
  createRepeatReminderMiddleware,
  DEFAULT_REPEAT_THRESHOLDS,
  isGenuineUserMessage,
  previewRepeatArguments,
  REPEAT_REMINDER_KIND,
} from "../dist/dev.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeChannel(initial = []) {
  return {
    messages: initial.slice(),
    getMessages() {
      return this.messages;
    },
    setMessages(next) {
      this.messages = next;
    },
  };
}

function call(mw, toolName, args, toolCallId = "call") {
  return mw.onBeforeToolCall({}, { toolName, args, toolCallId });
}

function config(mw, messages) {
  return mw.onConfig({}, { messages });
}

function userMessage(content) {
  return { role: "user", content };
}

// ---------------------------------------------------------------------------
// 1. Canonicalization — property order does not create a false "new" call
// ---------------------------------------------------------------------------
assert.equal(
  canonicalizeRepeatArguments({ pattern: "foo", path: "src" }),
  canonicalizeRepeatArguments({ path: "src", pattern: "foo" }),
  "argument key order must not affect identity"
);
assert.notEqual(
  canonicalizeRepeatArguments({ pattern: "foo" }),
  canonicalizeRepeatArguments({ pattern: "bar" }),
  "different values must differ"
);
assert.equal(
  canonicalizeRepeatArguments({ nested: { b: 1, a: [2, { d: 4, c: 3 }] } }),
  canonicalizeRepeatArguments({ nested: { a: [2, { c: 3, d: 4 }], b: 1 } }),
  "nested key order must not affect identity"
);

// ---------------------------------------------------------------------------
// 2. Reminder content — escalation, shell format, preview cap
// ---------------------------------------------------------------------------
const [t3, t5] = DEFAULT_REPEAT_THRESHOLDS;
const gentle = buildRepeatReminderContent("grep", t3, '{"pattern":"foo"}', t3, 500);
assert.ok(gentle.startsWith(`<ctx kind=${REPEAT_REMINDER_KIND}>`), "opens the ctx shell");
assert.ok(gentle.endsWith("</ctx>"), "closes the ctx shell");
assert.ok(/repeating the exact same tool call/.test(gentle), "first threshold is the gentle reminder");

const detailed = buildRepeatReminderContent("grep", t5, '{"pattern":"foo"}', t3, 500);
assert.ok(/Repeated tool call detected/.test(detailed), "later threshold is the detailed reminder");
assert.ok(/- tool: grep/.test(detailed) && /- consecutive_calls: 5/.test(detailed), "names tool + count");
assert.ok(/- arguments: \{"pattern":"foo"\}/.test(detailed), "quotes the arguments");

const longArgs = "x".repeat(600);
const previewed = previewRepeatArguments(longArgs, 500);
assert.ok(previewed.endsWith("(+100 more chars)"), "preview marks the omitted tail");
assert.equal(previewRepeatArguments("short", 500), "short", "short args pass through");

// ---------------------------------------------------------------------------
// 3. Genuine user message detection — synthetic <ctx ...> is NOT a prompt
// ---------------------------------------------------------------------------
assert.equal(isGenuineUserMessage(userMessage("please search")), true);
assert.equal(isGenuineUserMessage(userMessage("<ctx kind=current_date>\n<x>\n</ctx>")), false);
assert.equal(isGenuineUserMessage({ role: "assistant", content: "ok" }), false);
assert.equal(
  isGenuineUserMessage({ role: "user", content: [{ type: "text", content: "read this" }] }),
  true,
  "array text content counts"
);
assert.equal(
  isGenuineUserMessage({
    role: "user",
    content: [{ type: "text", content: "<ctx kind=repeat_tool_reminder>\nbody\n</ctx>" }],
  }),
  false,
  "array synthetic content does not count"
);

// ---------------------------------------------------------------------------
// 4. End-to-end loop detection
// ---------------------------------------------------------------------------
{
  const wire = [userMessage("please search")];
  const channel = makeChannel([{ id: "u1", role: "user", parts: [{ type: "text", content: "please search" }] }]);
  let persisted = 0;
  const mw = createRepeatReminderMiddleware({
    getUIChannel: () => channel,
    persistMessages: () => persisted++,
  });

  // Turn start: onConfig runs before the model's first tool call, establishing
  // the genuine-user-message baseline.
  await config(mw, wire);

  // Two repeats: below threshold, nothing injected.
  call(mw, "grep", { pattern: "foo", path: "src" });
  call(mw, "grep", { path: "src", pattern: "foo" }); // same call, different key order
  let out = await config(mw, wire);
  assert.deepEqual(out, {}, "nothing injected below the first threshold");
  assert.equal(channel.messages.length, 1);

  // Third repeat (key order changed again): gentle reminder injected + persisted.
  call(mw, "grep", { pattern: "foo", path: "src" });
  out = await config(mw, wire);
  assert.equal(channel.messages.length, 2, "reminder appended to the channel");
  assert.equal(persisted, 1, "reminder persisted once");
  assert.ok(
    channel.messages[1].parts[0].content.includes("repeating the exact same tool call"),
    "gentle reminder at the first threshold"
  );
  assert.equal(out.messages.length, wire.length + 1, "wire grew by the reminder");
  assert.equal(wire.length, 1, "input wire must not be mutated");

  // Fourth (no threshold) then fifth (detailed).
  call(mw, "grep", { pattern: "foo", path: "src" });
  assert.deepEqual(await config(mw, wire), {}, "no reminder at a non-threshold repeat");
  call(mw, "grep", { pattern: "foo", path: "src" });
  await config(mw, wire);
  assert.equal(channel.messages.length, 3, "detailed reminder at the fifth repeat");
  assert.ok(channel.messages[2].parts[0].content.includes("Repeated tool call detected"));
}

// A different tracked call resets the chain.
{
  const channel = makeChannel();
  const mw = createRepeatReminderMiddleware({ getUIChannel: () => channel, persistMessages: () => {} });
  const wire = [userMessage("go")];
  await config(mw, wire); // turn start
  call(mw, "grep", { pattern: "foo" });
  call(mw, "grep", { pattern: "foo" }); // count 2
  call(mw, "glob", { pattern: "*.ts" }); // resets
  call(mw, "grep", { pattern: "foo" }); // count 1 again
  const out = await config(mw, wire);
  assert.deepEqual(out, {}, "an interleaved different call resets the repeat count");
  assert.equal(channel.messages.length, 0);
}

// Excluded tools never count (default excludes get_command_output — polling is legitimate).
{
  const channel = makeChannel();
  const mw = createRepeatReminderMiddleware({ getUIChannel: () => channel, persistMessages: () => {} });
  const wire = [userMessage("go")];
  await config(mw, wire); // turn start
  for (let i = 0; i < 5; i++) call(mw, "get_command_output", { jobId: "job-1" });
  assert.deepEqual(await config(mw, wire), {}, "excluded tool draws no reminder");
  assert.equal(channel.messages.length, 0);
}

// A new user prompt resets the chain.
{
  const channel = makeChannel();
  const mw = createRepeatReminderMiddleware({ getUIChannel: () => channel, persistMessages: () => {} });
  const wire1 = [userMessage("first")];
  await config(mw, wire1); // turn start: seen user count = 1
  call(mw, "grep", { pattern: "foo" });
  call(mw, "grep", { pattern: "foo" }); // count 2
  await config(mw, wire1); // no new prompt → count preserved
  const wire2 = [userMessage("first"), { role: "assistant", content: "ok" }, userMessage("second")];
  await config(mw, wire2); // new genuine prompt → reset
  call(mw, "grep", { pattern: "foo" }); // count 1, NOT 3
  assert.deepEqual(await config(mw, wire2), {}, "a new user prompt resets the repeat count");
  assert.equal(channel.messages.length, 0);
}

// With no channel: transient wire-only injection, still returns a new array.
{
  const mw = createRepeatReminderMiddleware({ getUIChannel: () => undefined, persistMessages: () => {} });
  const input = [userMessage("go")];
  await config(mw, input); // turn start
  for (let i = 0; i < 3; i++) call(mw, "grep", { pattern: "foo" });
  const out = await config(mw, input);
  assert.equal(out.messages.length, 2, "no channel → append to the wire");
  assert.ok(out.messages[1].content.includes(REPEAT_REMINDER_KIND), "transient reminder carries the ctx shell");
  assert.equal(input.length, 1, "input wire must not be mutated");
}

// A second identical loop later in the same session still gets a reminder.
// (Without a per-kind nonce the content-hash id collides with the first reminder and
// `injectSyntheticMessages` dedupes it away — leaving the second loop un-nudged.)
{
  const channel = makeChannel([{ id: "u1", role: "user", parts: [{ type: "text", content: "please search" }] }]);
  let persisted = 0;
  const mw = createRepeatReminderMiddleware({ getUIChannel: () => channel, persistMessages: () => persisted++ });

  const wire1 = [userMessage("please search")];
  await config(mw, wire1);
  for (let i = 0; i < 3; i++) call(mw, "grep", { pattern: "foo" }, `a${i}`);
  await config(mw, wire1);
  assert.equal(channel.messages.length, 2, "the first loop injects a reminder");

  const wire2 = [userMessage("please search"), userMessage("try again")];
  await config(mw, wire2); // new genuine prompt resets the chain
  for (let i = 0; i < 3; i++) call(mw, "grep", { pattern: "foo" }, `b${i}`);
  await config(mw, wire2);
  assert.equal(channel.messages.length, 3, "a second identical loop still injects a reminder (per-kind nonce)");
  assert.equal(persisted, 2, "the second reminder is persisted too");
}

// A reminder left pending when the run is aborted must not leak into the next unrelated turn.
{
  const channel = makeChannel([{ id: "u1", role: "user", parts: [{ type: "text", content: "first" }] }]);
  const mw = createRepeatReminderMiddleware({ getUIChannel: () => channel, persistMessages: () => {} });
  await config(mw, [userMessage("first")]); // seen = 1
  for (let i = 0; i < 3; i++) call(mw, "grep", { pattern: "foo" }, `a${i}`); // pending set
  // …aborted here: no onConfig consumes `pending`.
  const out = await config(mw, [userMessage("first"), userMessage("an unrelated task")]);
  assert.deepEqual(out, {}, "a pending reminder is dropped when a new user prompt resets the chain");
  assert.equal(channel.messages.length, 1, "no stale reminder is injected into the unrelated turn");
}

// A pending reminder belongs to its chain: a different tracked call must cancel it,
// not inject a nudge about a loop the model already left.
{
  const channel = makeChannel([{ id: "u1", role: "user", parts: [{ type: "text", content: "go" }] }]);
  const mw = createRepeatReminderMiddleware({ getUIChannel: () => channel, persistMessages: () => {} });
  const wire = [userMessage("go")];
  await config(mw, wire);
  for (let i = 0; i < 3; i++) call(mw, "grep", { pattern: "foo" }, `a${i}`); // pending
  call(mw, "glob", { pattern: "*.ts" }); // different call breaks the chain
  const out = await config(mw, wire);
  assert.deepEqual(out, {}, "a different call cancels the pending reminder");
  assert.equal(channel.messages.length, 1, "no stale repeat reminder is injected");
}

// Compaction can lower the genuine-user-message count without adding a prompt.
// That wire change is still a chain boundary; keeping the old count would make the
// next loop inherit the pre-compaction repetition count.
{
  const channel = makeChannel([{ id: "u1", role: "user", parts: [{ type: "text", content: "first" }] }]);
  const mw = createRepeatReminderMiddleware({ getUIChannel: () => channel, persistMessages: () => {} });
  const wireBefore = [userMessage("first"), { role: "assistant", content: "ok" }, userMessage("second")];
  await config(mw, wireBefore); // seen = 2
  call(mw, "grep", { pattern: "foo" });
  call(mw, "grep", { pattern: "foo" }); // count 2
  const wireAfter = [{ role: "assistant", content: "summary" }, userMessage("second")];
  await config(mw, wireAfter); // count drops to 1 -> reset
  call(mw, "grep", { pattern: "foo" }); // count 1, NOT 3
  const out = await config(mw, wireAfter);
  assert.deepEqual(out, {}, "a compaction-shaped wire resets the repeat chain");
  assert.equal(channel.messages.length, 1, "no reminder from the pre-compaction chain");
}

console.log("repeat-reminder validation passed");
