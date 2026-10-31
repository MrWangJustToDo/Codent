/**
 * Validates the session-staleness guard used by the turn-context and background middlewares:
 * work computed for a session that was switched away is DISCARDED, never written into the target.
 *
 * Two windows must be covered, and neither signal covers both:
 *
 * - `isSessionSwitching()` is true only DURING the unload→load transaction;
 * - the UI channel's session generation moves when the load COMMITS, by which time the flag is
 *   already false again but the transcript the work was computed for is gone.
 *
 * Both middlewares await (section building / job reads) between sampling and writing, so the guard
 * has to be captured BEFORE the await and re-checked after it.
 *
 * Run: pnpm --filter @codent/core run validate:session-staleness
 */

import assert from "node:assert/strict";

import {
  AgentUIChannel,
  captureSessionStaleness,
  createBackgroundMiddleware,
  createTurnContextMiddleware,
} from "../dist/dev.mjs";

const userRow = () => [{ id: "u1", role: "user", parts: [{ type: "text", content: "hello" }] }];

// ---------------------------------------------------------------------------
// 1. The helper: each signal covers the window the other cannot.
// ---------------------------------------------------------------------------
{
  const channel = new AgentUIChannel();
  const stable = captureSessionStaleness(channel, () => false);
  assert.equal(stable(), false, "nothing moved -> not stale");

  channel.advanceSessionGeneration();
  assert.equal(stable(), true, "a generation move AFTER the capture is stale (the load committed)");

  const switching = captureSessionStaleness(channel, () => true);
  assert.equal(switching(), true, "a switch in flight is stale before the generation moves");

  const afterSwitch = captureSessionStaleness(channel, () => false);
  assert.equal(afterSwitch(), false, "a fresh capture on the same generation is not stale");

  // No channel (a caller with no transcript): only the flag can make it stale.
  assert.equal(captureSessionStaleness(undefined, () => false)(), false);
  assert.equal(captureSessionStaleness(undefined, () => true)(), true);
}

// ---------------------------------------------------------------------------
// 2. turn-context: a section set computed across the commit is dropped.
// ---------------------------------------------------------------------------
{
  const channel = new AgentUIChannel();
  channel.setMessages(userRow());
  const persisted = [];
  let sectionCalls = 0;
  const middleware = createTurnContextMiddleware({
    getFrozenSystemPrompt: () => undefined,
    getSections: async () => {
      sectionCalls += 1;
      // The switch commits while the sections are being computed — the exact window the
      // generation (not the flag) covers.
      channel.advanceSessionGeneration();
      return [{ key: "current_date", content: "<current_date>2026-11-01</current_date>" }];
    },
    getUIChannel: () => channel,
    persistMessages: (next) => persisted.push(next),
    getManagedAgent: () => null,
  });

  const result = await middleware.onConfig({}, { messages: [{ role: "user", content: "hello" }] });
  assert.equal(sectionCalls, 1, "the sections were computed before the guard ran");
  assert.equal(result.messages, undefined, "the computed injection is dropped, not returned");
  assert.equal(persisted.length, 0, "nothing is persisted into the target transcript");
  assert.equal(channel.getMessages().length, 1, "no synthetic ctx row landed on the channel");
  console.log("✓ turn-context drops a section set computed across a session commit");
}

// ---------------------------------------------------------------------------
// 3. Control: the same call WITHOUT the commit injects — so test 2 discriminates.
// ---------------------------------------------------------------------------
{
  const channel = new AgentUIChannel();
  channel.setMessages(userRow());
  const persisted = [];
  const middleware = createTurnContextMiddleware({
    getFrozenSystemPrompt: () => undefined,
    getSections: async () => [{ key: "current_date", content: "<current_date>2026-11-01</current_date>" }],
    getUIChannel: () => channel,
    persistMessages: (next) => persisted.push(next),
    getManagedAgent: () => null,
  });

  const result = await middleware.onConfig({}, { messages: [{ role: "user", content: "hello" }] });
  assert.equal(result.messages?.length, 2, "an unchanged session still injects");
  assert.equal(persisted.length, 1, "and persists the row");
  assert.equal(channel.getMessages().length, 2);
  console.log("✓ the guard does not fire on an ordinary call");
}

// ---------------------------------------------------------------------------
// 4. turn-context: the switching flag covers the pre-commit window.
// ---------------------------------------------------------------------------
{
  const channel = new AgentUIChannel();
  channel.setMessages(userRow());
  const persisted = [];
  const middleware = createTurnContextMiddleware({
    getFrozenSystemPrompt: () => undefined,
    getSections: async () => [{ key: "current_date", content: "<current_date>2026-11-01</current_date>" }],
    getUIChannel: () => channel,
    persistMessages: (next) => persisted.push(next),
    // The transaction is in flight: the generation has not moved yet.
    getManagedAgent: () => ({ isSessionSwitching: () => true }),
  });

  const result = await middleware.onConfig({}, { messages: [{ role: "user", content: "hello" }] });
  assert.equal(result.messages, undefined, "a switch in flight drops the injection");
  assert.equal(persisted.length, 0);
  assert.equal(channel.getMessages().length, 1);
  console.log("✓ turn-context drops an injection computed while the switch is in flight");
}

// ---------------------------------------------------------------------------
// 5. background: a completion read across the commit is dropped and NOT marked delivered.
// ---------------------------------------------------------------------------
{
  const channel = new AgentUIChannel();
  channel.setMessages(userRow());
  const persisted = [];
  const marked = [];
  const job = {
    id: "job_1",
    command: "npm test",
    status: "exited",
    exitCode: 0,
    stdout: "all good\n",
    stderr: "",
  };
  const middleware = createBackgroundMiddleware({
    getUIChannel: () => channel,
    persistMessages: (next) => persisted.push(next),
    getCommandService: () => ({
      // The switch commits while the registry is being read.
      collectCompleted: async () => {
        channel.advanceSessionGeneration();
        return [job];
      },
      markNotified: async (ids) => marked.push(...ids),
      sectionFor: async () => undefined,
    }),
    getParentId: () => undefined,
  });

  const result = await middleware.onConfig({}, { messages: [{ role: "user", content: "hello" }] });
  assert.deepEqual(result, {}, "the whole patch is dropped");
  assert.deepEqual(marked, [], "a dropped completion stays un-notified (the registry is reset by the switch)");
  assert.equal(persisted.length, 0);
  assert.equal(channel.getMessages().length, 1);
  console.log("✓ background drops a completion read across a session commit");
}

console.log("session-staleness validation passed");
