/**
 * Validates the repeat-tool-call reminder middleware:
 * - canonical argument matching (property-order independent)
 * - threshold escalation (gentle at the first threshold, detailed later) + arg preview cap
 * - `<ctx kind=repeat_tool_reminder chain="…" count="…">` shell format
 * - genuine-user-message detection (synthetic `<ctx ...>` is not a prompt)
 * - wire-derived loop detection: identical trailing calls count up, a different call ends the
 *   chain, excluded tools are transparent, a new user prompt separates chains, and the reminder
 *   is injected (channel + wire) on the next onConfig, or transiently without a channel
 * - stateless recovery: re-running the same wire is a no-op, a dropped reminder re-admits, and a
 *   *different* chain at the same count is not suppressed
 *
 * Run: pnpm --filter @codent/core run validate:repeat-reminder
 */

import assert from "node:assert/strict";

import {
  buildRepeatReminderBody,
  canonicalizeRepeatArguments,
  formatContextSectionUserContent,
  formatSectionTag,
  REMINDER_TAGS,
  contextAttributesFromText,
  createRepeatReminderMiddleware,
  DEFAULT_REPEAT_THRESHOLDS,
  isGenuineUserMessage,
  previewRepeatArguments,
  TURN_CONTEXT_KINDS,
  readRepeatReminderWindowState,
  readTrailingRepeatChain,
  resolveRepeatReminder,
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

function userMessage(content) {
  return { role: "user", content };
}

/** One assistant tool call + its result, the shape a completed call leaves on the wire. */
function toolTurn(name, args, id) {
  return [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
    },
    { role: "tool", content: "ok", toolCallId: id },
  ];
}

/**
 * Drives the middleware exactly like the pipeline does: onConfig gets the current wire and
 * whatever it returns becomes the next wire (the real projection re-reads the channel).
 */
function harness(middlewareOptions = {}) {
  const channel = makeChannel([{ id: "u1", role: "user", parts: [{ type: "text", content: "please search" }] }]);
  const state = { wire: [userMessage("please search")], persisted: 0 };
  const middleware = createRepeatReminderMiddleware({
    getUIChannel: () => channel,
    persistMessages: () => state.persisted++,
    ...middlewareOptions,
  });
  return {
    channel,
    state,
    push: (name, args, id) => state.wire.push(...toolTurn(name, args, id)),
    run: async () => {
      const result = await middleware.onConfig({}, { messages: state.wire.slice() });
      if (result.messages) {
        state.wire.length = 0;
        state.wire.push(...result.messages);
      }
      return result;
    },
    reminders: () =>
      state.wire.filter(
        (message) =>
          typeof message.content === "string" && message.content.includes(`<ctx kind=${TURN_CONTEXT_KINDS.reminder}`)
      ),
  };
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
// 2. Reminder content — escalation, shell format, attrs, preview cap
// ---------------------------------------------------------------------------
const [t3, t5] = DEFAULT_REPEAT_THRESHOLDS;
const repeated = (count, args = { pattern: "foo" }, idPrefix = "p") => {
  const wire = [userMessage("go")];
  for (let i = 0; i < count; i++) wire.push(...toolTurn("grep", args, `${idPrefix}${i}`));
  return wire;
};
const resolveAt = (count) => resolveRepeatReminder(repeated(count));

// Below the first threshold there is no section at all.
assert.equal(resolveAt(t3 - 1), undefined, "below the first threshold nothing is due");

const gentleResolution = resolveAt(t3);
assert.ok(gentleResolution, "the first threshold resolves a reminder");
const gentle = formatContextSectionUserContent(gentleResolution.section);
assert.ok(
  gentle.startsWith(`<ctx kind=${TURN_CONTEXT_KINDS.reminder} chain="`),
  "opens the ctx shell with the shared reminder kind and the chain scope"
);
assert.ok(gentle.endsWith("</ctx>"), "closes the ctx shell");
assert.ok(/repeating the exact same tool call/.test(gentle), "first threshold is the gentle reminder");
assert.deepEqual(
  contextAttributesFromText(gentle),
  { chain: gentleResolution.chain.chain, count: "3", episode: "1" },
  "recovery attrs on the shell (scope + counter + episode)"
);

// A nag already in the window suppresses the same chain at the same count.
{
  const wire = repeated(t3);
  wire.push(userMessage(gentle));
  assert.equal(resolveRepeatReminder(wire), undefined, "an admitted reminder suppresses a repeat");
  assert.deepEqual(readRepeatReminderWindowState(wire, gentleResolution.chain), {
    chain: gentleResolution.chain.chain,
    episode: 1,
    lastCount: 3,
  });
}

// The detailed body at a later threshold.
const detailed = buildRepeatReminderBody({
  toolName: "grep",
  count: t5,
  canonicalArguments: '{"pattern":"foo"}',
  firstThreshold: t3,
  previewChars: 500,
});
assert.ok(/Repeated tool call detected/.test(detailed), "later threshold is the detailed reminder");
assert.ok(/- tool: grep/.test(detailed) && /- consecutive_calls: 5/.test(detailed), "names tool + count");
assert.ok(/- arguments: \{"pattern":"foo"\}/.test(detailed), "quotes the arguments");
assert.equal(
  gentleResolution.section.content,
  formatSectionTag(
    REMINDER_TAGS.repeat,
    buildRepeatReminderBody({
      toolName: "grep",
      count: t3,
      canonicalArguments: '{"pattern":"foo"}',
      firstThreshold: t3,
      previewChars: 500,
    })
  ),
  "the section is the shared builder's inner tag around the body"
);
assert.ok(
  gentleResolution.section.content.startsWith(`<${REMINDER_TAGS.repeat}>`),
  "the repeat nudge declares its own tag inside the shared reminder kind"
);

const longArgs = "x".repeat(600);
const previewed = previewRepeatArguments(longArgs, 500);
assert.ok(previewed.endsWith("(+100 more chars)"), "preview marks the omitted tail");
assert.equal(previewRepeatArguments("short", 500), "short");

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
// 4. The chain is derived from the wire tail
// ---------------------------------------------------------------------------
{
  const wire = [userMessage("go")];
  wire.push(...toolTurn("grep", { pattern: "foo" }, "a1"));
  wire.push(...toolTurn("grep", { pattern: "foo" }, "a2"));
  assert.equal(readTrailingRepeatChain(wire).count, 2, "trailing identical calls count");
  assert.equal(readTrailingRepeatChain(wire).toolName, "grep");

  // Different key order is the same call.
  wire.push(...toolTurn("grep", { pattern: "foo" }, "a3"));
  assert.equal(readTrailingRepeatChain(wire).count, 3, "argument order does not break the chain");

  // A different tracked call ends the chain at the differing call.
  wire.push(...toolTurn("glob", { pattern: "*.ts" }, "a4"));
  assert.equal(readTrailingRepeatChain(wire).count, 1, "a different call starts a new chain");
  assert.equal(readTrailingRepeatChain(wire).toolName, "glob");

  // A genuine user message separates chains.
  const afterPrompt = [...wire, userMessage("next task")];
  assert.equal(readTrailingRepeatChain(afterPrompt), undefined, "a genuine prompt ends the chain");

  // Excluded tools are transparent: they neither count nor break the run.
  const withPolling = [
    userMessage("go"),
    ...toolTurn("grep", { pattern: "foo" }, "b1"),
    ...toolTurn("get_command_output", { jobId: "job-1" }, "b2"),
    ...toolTurn("grep", { pattern: "foo" }, "b3"),
  ];
  assert.equal(readTrailingRepeatChain(withPolling).count, 2, "an excluded call is transparent");

  // Synthetic ctx between calls does not break the chain either.
  const withCtx = [
    userMessage("go"),
    ...toolTurn("grep", { pattern: "foo" }, "c1"),
    { role: "user", content: "<ctx kind=current_date>\n<current_date>today</current_date>\n</ctx>" },
    ...toolTurn("grep", { pattern: "foo" }, "c2"),
  ];
  assert.equal(readTrailingRepeatChain(withCtx).count, 2, "a ctx injection does not break the chain");
}

// ---------------------------------------------------------------------------
// 5. End-to-end: escalation, recovery and idempotence
// ---------------------------------------------------------------------------
{
  const h = harness();

  h.push("grep", { pattern: "foo", path: "src" }, "a1");
  h.push("grep", { path: "src", pattern: "foo" }, "a2");
  assert.deepEqual(await h.run(), {}, "nothing injected below the first threshold");
  assert.equal(h.channel.messages.length, 1);

  // Third repeat (key order changed again): gentle reminder injected + persisted.
  h.push("grep", { pattern: "foo", path: "src" }, "a3");
  const third = await h.run();
  assert.ok(third.messages, "the injected wire is returned");
  assert.equal(h.channel.messages.length, 2, "reminder appended to the channel");
  assert.equal(h.state.persisted, 1, "reminder persisted once");
  assert.equal(h.reminders().length, 1, "reminder appended to the wire");
  assert.ok(
    h.reminders()[0].content.includes("repeating the exact same tool call"),
    "gentle reminder at the first threshold"
  );
  assert.deepEqual(contextAttributesFromText(h.reminders()[0].content).count, "3");

  // Re-running the exact same wire (retry / duplicate onConfig) is a no-op.
  assert.deepEqual(await h.run(), {}, "an unchanged wire injects nothing (idempotent)");
  assert.equal(h.channel.messages.length, 2);

  // Fourth (no threshold) then fifth (detailed).
  h.push("grep", { pattern: "foo", path: "src" }, "a4");
  assert.deepEqual(await h.run(), {}, "no reminder at a non-threshold repeat");
  h.push("grep", { path: "src", pattern: "foo" }, "a5");
  await h.run();
  assert.equal(h.channel.messages.length, 3, "detailed reminder at the fifth repeat");
  assert.ok(h.reminders()[1].content.includes("Repeated tool call detected"));
  assert.deepEqual(contextAttributesFromText(h.reminders()[1].content).count, "5");
}

// A different tracked call ends the chain: the count restarts.
{
  const h = harness();
  h.push("grep", { pattern: "foo" }, "a1");
  h.push("grep", { pattern: "foo" }, "a2");
  h.push("glob", { pattern: "*.ts" }, "a3");
  h.push("grep", { pattern: "foo" }, "a4");
  assert.deepEqual(await h.run(), {}, "an interleaved different call restarts the count");
  assert.equal(h.channel.messages.length, 1);
}

// Excluded tools never draw a reminder (polling a background job is legitimate).
{
  const h = harness();
  for (let i = 0; i < 5; i++) h.push("get_command_output", { jobId: "job-1" }, `p${i}`);
  assert.deepEqual(await h.run(), {}, "excluded tool draws no reminder");
  assert.equal(h.channel.messages.length, 1);
}

// A new user prompt starts a fresh chain.
{
  const h = harness();
  h.push("grep", { pattern: "foo" }, "a1");
  h.push("grep", { pattern: "foo" }, "a2");
  await h.run();
  h.state.wire.push(userMessage("second"));
  h.push("grep", { pattern: "foo" }, "b1");
  assert.deepEqual(await h.run(), {}, "a new user prompt resets the repeat count");
  assert.equal(h.channel.messages.length, 1);
}

// With no channel: transient wire-only injection, still returns a new array.
{
  const middleware = createRepeatReminderMiddleware({ getUIChannel: () => undefined, persistMessages: () => {} });
  const wire = [userMessage("go")];
  for (let i = 0; i < 3; i++) wire.push(...toolTurn("grep", { pattern: "foo" }, `n${i}`));
  const out = await middleware.onConfig({}, { messages: wire });
  assert.equal(out.messages.length, wire.length + 1, "no channel → append to the wire");
  assert.ok(
    out.messages[out.messages.length - 1].content.includes(`<ctx kind=${TURN_CONTEXT_KINDS.reminder}`),
    "carries the ctx shell"
  );
  assert.equal(wire.length, 7, "input wire must not be mutated");
}

// A second identical loop later in the session still gets a reminder (per-kind nonce).
{
  const h = harness();
  h.push("grep", { pattern: "foo" }, "a1");
  h.push("grep", { pattern: "foo" }, "a2");
  h.push("grep", { pattern: "foo" }, "a3");
  await h.run();
  assert.equal(h.channel.messages.length, 2, "the first loop injects a reminder");

  h.state.wire.push(userMessage("try again"));
  // The reminder from the previous turn no longer speaks for the new chain: recovery is
  // turn-scoped, so it must not report an admitted reminder for the chain that follows.
  const nextChain = readTrailingRepeatChain(h.state.wire);
  assert.equal(nextChain, undefined, "the new prompt ends the chain");
  assert.equal(
    readRepeatReminderWindowState(h.state.wire, { chain: "previous", start: 0 }).episode,
    0,
    "a previous turn's reminder cannot speak for the new chain"
  );
  h.push("grep", { pattern: "foo" }, "b1");
  h.push("grep", { pattern: "foo" }, "b2");
  h.push("grep", { pattern: "foo" }, "b3");
  await h.run();
  assert.equal(h.channel.messages.length, 3, "a second identical loop still injects a reminder");
  assert.equal(h.state.persisted, 2, "the second reminder is persisted too");
}

// Stateless recovery: a compaction cut that drops the reminder re-admits it, because the
// repeated calls are still in the window and nothing remembers the earlier admission.
{
  const h = harness();
  h.push("grep", { pattern: "foo" }, "a1");
  h.push("grep", { pattern: "foo" }, "a2");
  h.push("grep", { pattern: "foo" }, "a3");
  await h.run();
  assert.equal(h.reminders().length, 1);

  h.state.wire = h.state.wire.filter(
    (message) => !String(message.content ?? "").includes(`<ctx kind=${TURN_CONTEXT_KINDS.reminder}`)
  );
  assert.equal(
    readRepeatReminderWindowState(h.state.wire, readTrailingRepeatChain(h.state.wire)).episode,
    0,
    "the reminder is gone from the cut wire"
  );
  await h.run();
  assert.equal(h.reminders().length, 1, "the reminder is re-admitted after the cut");
  assert.equal(h.channel.messages.length, 3, "and lands as a new channel row (episode nonce)");
}

// A reminder for a *different* chain never suppresses the current one, even at the same count.
{
  const h = harness();
  h.push("glob", { pattern: "*.ts" }, "a1");
  h.push("glob", { pattern: "*.ts" }, "a2");
  h.push("glob", { pattern: "*.ts" }, "a3");
  await h.run();
  assert.equal(h.channel.messages.length, 2, "glob chain nags at 3");
  const previousChain = contextAttributesFromText(h.reminders()[0].content).chain;

  // Keep the old reminder in the window (no cut): it belongs to the glob chain and must not
  // speak for a grep chain that also reaches 3.
  h.state.wire.push(userMessage("another task"));
  h.push("grep", { pattern: "bar" }, "b1");
  h.push("grep", { pattern: "bar" }, "b2");
  h.push("grep", { pattern: "bar" }, "b3");
  await h.run();
  assert.equal(h.channel.messages.length, 3, "a different chain at the same count still nags");
  const currentChain = readTrailingRepeatChain(h.state.wire).chain;
  assert.equal(
    contextAttributesFromText(h.reminders()[1].content).chain,
    currentChain,
    "the new reminder owns the new chain"
  );
  assert.notEqual(previousChain, currentChain, "the two loops are distinct chains");
}

console.log("repeat-reminder validation passed");
