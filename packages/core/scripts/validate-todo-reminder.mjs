/**
 * Validates the todo reminder (condition + counter), its scan, and its own middleware.
 *
 * The nag is no longer part of turn context: turn context is hash-admitted, the nag is
 * decided by a counter. This script covers the scan the middleware relies on:
 *
 * - newest-marker scan: the `todo` call starts a cycle, the reminder records the round it was
 *   admitted at; a reminder before the newest call belongs to an older cycle and is ignored
 * - the first nag is the initial state (rounds since the update); later nags follow the
 *   growing cooldown and must report a **strictly later** round
 * - no visible `todo` call → no nag (the model cannot see the list it would be asked to update)
 * - the middleware injects one channel row per admission, is idempotent on the same window,
 *   and re-admits after a cut dropped the block
 *
 * Run: pnpm --filter @codent/core run validate:todo-reminder
 */

import assert from "node:assert/strict";

import {
  AgentUIChannel,
  buildTodoReminderBody,
  createTodoReminderMiddleware,
  formatContextSectionUserContent,
  readTodoReminderWindowState,
  resolveTodoReminder,
  TURN_CONTEXT_KINDS,
  TodoManager,
} from "../dist/dev.mjs";

const log = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  agent: () => {},
  todo: () => {},
  clear: () => {},
};

const makeTodoManager = () => {
  const manager = new TodoManager({ log });
  manager.update([{ content: "A", status: "in_progress", priority: "high" }], "Plan");
  return manager;
};
const tm = makeTodoManager();

const todoCall = (id) => ({
  role: "assistant",
  content: "",
  toolCalls: [{ id, type: "function", function: { name: "todo", arguments: "{}" } }],
});
const turn = (text) => ({ role: "assistant", content: text });
const reminderBlock = (section) => ({ role: "user", content: formatContextSectionUserContent(section) });
/** A cycle: the todo call, its result, then `rounds` completed model turns. */
const cycle = (id, rounds) => [
  { role: "user", content: "work on it" },
  todoCall(id),
  { role: "tool", content: "ok", toolCallId: id },
  ...Array.from({ length: rounds }, (_, index) => turn(`step ${index}`)),
];

// ---------------------------------------------------------------------------
// 1. Initial state: rounds since the update
// ---------------------------------------------------------------------------
assert.equal(resolveTodoReminder(tm, cycle("call-1", 2)), undefined, "below the threshold -> no nag");

const first = resolveTodoReminder(tm, cycle("call-1", 3));
assert.ok(first, "threshold crossed -> nag fires");
assert.match(first.content, /unchanged for 3 rounds/);
assert.equal(first.key, TURN_CONTEXT_KINDS.reminder);
assert.match(first.content, /^<todo-reminder>/, "the nag declares its own tag inside the reminder kind");
assert.equal(first.attrs.cycle, "call-1", "the cycle is the todo call");
assert.equal(first.attrs.rounds, "3");
assert.equal(first.attrs.episode, "1", "the first nag of a cycle is episode 1");
assert.ok(!("supersedes" in first), "the first nag of a cycle supersedes nothing");
assert.deepEqual(resolveTodoReminder(tm, cycle("call-1", 3)), first, "the same window decides the same way");

// The scan reports the same state the resolver used.
assert.deepEqual(readTodoReminderWindowState(cycle("call-1", 3)), { cycle: "call-1", rounds: 3 });

// ---------------------------------------------------------------------------
// 2. A reminder already in the cycle suppresses the same round
// ---------------------------------------------------------------------------
{
  const wire = [...cycle("call-1", 3), reminderBlock(first)];
  assert.equal(resolveTodoReminder(tm, wire), undefined, "the admitted round does not nag twice");
  assert.deepEqual(readTodoReminderWindowState(wire), {
    cycle: "call-1",
    rounds: 3,
    prior: { episode: 1, rounds: 3 },
  });
}

// ---------------------------------------------------------------------------
// 3. The round must strictly advance, then the cooldown gates the next nag
// ---------------------------------------------------------------------------
{
  // Same round, every message preserved: still no nag (rounds <= prior rounds).
  const same = [...cycle("call-1", 3), reminderBlock(first)];
  assert.equal(resolveTodoReminder(tm, same), undefined, "a round is never reported twice");

  // One more turn: the round advanced, but the initial cooldown (5) has not elapsed.
  const near = [...cycle("call-1", 4), reminderBlock(first)];
  assert.equal(resolveTodoReminder(tm, near), undefined, "the cooldown still holds");

  // 3 + 5: the second nag, episode 2, at the current round.
  const second = resolveTodoReminder(tm, [...cycle("call-1", 8), reminderBlock(first)]);
  assert.ok(second, "second nag fires after the initial cooldown");
  assert.equal(second.attrs.episode, "2", "the episode increments");
  assert.equal(second.attrs.rounds, "8", "the nag reports the current round");
  assert.equal(second.supersedes, "todo-reminder", "a later nag supersedes earlier todo nudges by tag");

  // The next gap grows to 10 (5 + 1 × 5): 8 + 9 is early, 8 + 10 is due.
  const secondBlock = reminderBlock(second);
  assert.equal(
    resolveTodoReminder(tm, [...cycle("call-1", 17), reminderBlock(first), secondBlock]),
    undefined,
    "the next gap grew to 10 rounds"
  );
  const third = resolveTodoReminder(tm, [...cycle("call-1", 18), reminderBlock(first), secondBlock]);
  assert.ok(third, "third nag fires after the grown cooldown");
  assert.equal(third.attrs.episode, "3");
}

// ---------------------------------------------------------------------------
// 4. A newer todo call starts a fresh cycle; older reminders are ignored
// ---------------------------------------------------------------------------
{
  const wire = [
    ...cycle("call-1", 6),
    reminderBlock(first),
    todoCall("call-2"),
    { role: "tool", content: "ok", toolCallId: "call-2" },
    turn("updated"),
    turn("more"),
  ];
  assert.equal(resolveTodoReminder(tm, wire), undefined, "the update restarts the counter (2 rounds)");
  assert.deepEqual(readTodoReminderWindowState(wire), { cycle: "call-2", rounds: 2 });

  const due = [...wire, turn("three")];
  const fresh = resolveTodoReminder(tm, due);
  assert.ok(fresh, "the new cycle nags at its own threshold");
  assert.equal(fresh.attrs.cycle, "call-2");
  assert.equal(fresh.attrs.episode, "1", "the new cycle starts at episode 1");
  assert.ok(!("supersedes" in fresh), "an older cycle's reminder is not a supersede");
}

// ---------------------------------------------------------------------------
// 5. No visible `todo` call (plan-seeded list, or the call was compacted away) → the current
//    turn is the cycle, so a list the agent was handed still gets nudged.
// ---------------------------------------------------------------------------
{
  const seeded = [{ role: "user", content: "execute the plan" }, ...Array.from({ length: 3 }, () => turn("x"))];
  const nag = resolveTodoReminder(tm, seeded);
  assert.ok(nag, "a seeded list still nags without a todo call");
  assert.equal(nag.attrs.cycle, "window", "the turn is the scope");
  assert.equal(nag.attrs.rounds, "3");
  assert.equal(nag.attrs.episode, "1");
  assert.ok(!("supersedes" in nag), "the first nag of a turn supersedes nothing");

  // A new prompt restarts the per-turn countdown (the slice starts at the anchor).
  assert.equal(
    resolveTodoReminder(tm, [...seeded, { role: "user", content: "still working" }, turn("y")]),
    undefined,
    "a new prompt restarts the fallback countdown"
  );

  // Below the threshold, still nothing.
  assert.equal(
    resolveTodoReminder(tm, [{ role: "user", content: "go" }, turn("x"), turn("y")]),
    undefined,
    "the fallback obeys the threshold"
  );
}

// ---------------------------------------------------------------------------
// 5b. A prompt does not restart the cycle — only a todo update does.
// ---------------------------------------------------------------------------
{
  const wire = [...cycle("call-1", 2), { role: "user", content: "keep going" }, turn("a"), turn("b"), turn("c")];
  const nag = resolveTodoReminder(tm, wire);
  assert.ok(nag, "the countdown continues across a prompt");
  assert.equal(nag.attrs.cycle, "call-1", "the cycle is still the todo call");
  assert.equal(nag.attrs.rounds, "5", "rounds are counted from the call, not the prompt");
  assert.equal(nag.attrs.episode, "1");
}

// ---------------------------------------------------------------------------
// 6. The body carries the round/episode text (every nag hashes uniquely)
// ---------------------------------------------------------------------------
assert.match(buildTodoReminderBody(7, 2), /unchanged for 7 rounds/);
assert.notEqual(buildTodoReminderBody(3, 1), buildTodoReminderBody(3, 2), "the episode changes the content");

// ---------------------------------------------------------------------------
// 7. Middleware: one channel row per admission, idempotent on the same window
// ---------------------------------------------------------------------------
{
  const channel = new AgentUIChannel();
  channel.setMessages([{ id: "u1", role: "user", parts: [{ type: "text", content: "work on it" }] }]);
  let persistCalls = 0;
  const middleware = createTodoReminderMiddleware({
    getTodoManager: () => makeTodoManager(),
    getUIChannel: () => channel,
    persistMessages: () => persistCalls++,
  });
  const rows = () =>
    channel.getMessages().filter((message) => message.id.startsWith(`ctx-${TURN_CONTEXT_KINDS.reminder}-`));
  /** The wire for a cycle of `rounds` turns, optionally carrying the nag rows already admitted. */
  const wireAt = (rounds, options = {}) => {
    const withNag = options.withNag ?? true;
    return [
      { role: "user", content: "work on it" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-todo", type: "function", function: { name: "todo", arguments: "{}" } }],
      },
      { role: "tool", content: "ok", toolCallId: "call-todo" },
      ...Array.from({ length: rounds }, (_, index) => turn(`s${index}`)),
      ...(withNag ? rows().map((message) => ({ role: "user", content: message.parts[0].content })) : []),
    ];
  };

  const early = await middleware.onConfig({}, { messages: wireAt(2, { withNag: false }) });
  assert.equal(early.messages, undefined, "below the threshold nothing is injected");
  assert.equal(rows().length, 0);

  const firstRun = await middleware.onConfig({}, { messages: wireAt(3, { withNag: false }) });
  assert.ok(firstRun.messages, "the nag is injected at the threshold");
  assert.equal(rows().length, 1, "one channel row");
  assert.equal(persistCalls, 1, "persisted once");

  const again = await middleware.onConfig({}, { messages: wireAt(3) });
  assert.equal(again.messages, undefined, "the same round does not nag again");

  // A compaction-shaped window that lost the block re-admits it (the counter says the round is
  // due and nothing in the window contradicts it).
  const afterCut = await middleware.onConfig({}, { messages: wireAt(3, { withNag: false }) });
  assert.ok(afterCut.messages, "a cut that dropped the nag re-admits it");
  assert.equal(rows().length, 2, "…as a new channel row (episode nonce)");
}

console.log("todo-reminder validation passed");
