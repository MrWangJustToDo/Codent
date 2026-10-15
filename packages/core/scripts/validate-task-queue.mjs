/**
 * Validates the pre-fork queue view — what `subagent:queue` publishes.
 *
 * A turn's `task` calls are admitted a few at a time; the rest wait for a slot, and a waiting task
 * has no subagent yet, so it appears in neither `snapshot.subagents` nor `agent:tool-start`. The
 * coordinator's view (`queuedToolCallIds`) plus `setOnChange` are the only source for that state, so
 * every transition a host must see is asserted here: registration, admission when a slot frees, and
 * discard.
 *
 * Split from `validate-task-prefork.mjs` (which covers admission/join/discard semantics) because
 * that file is at the line ceiling: this is the same subject, a different question.
 *
 * Run: pnpm --filter @codent/core run validate:task-queue
 */

import assert from "node:assert/strict";

import { TaskPreforkCoordinator } from "../dist/dev.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A run that blocks until released, so admission order is observed rather than raced. */
const doneResult = {
  aborted: false,
  summary: "…",
  reachedLimit: false,
  incomplete: false,
  truncated: false,
};

{
  const coordinator = new TaskPreforkCoordinator(() => 2);
  const notifications = [];
  coordinator.setOnChange(() => {
    notifications.push({ queued: coordinator.queuedToolCallIds() });
  });

  const releases = [];
  const startBlocking = (toolCallId) =>
    coordinator.start(
      toolCallId,
      () => {},
      async () => {
        await new Promise((resolve) => releases.push(resolve));
        return doneResult;
      }
    );

  startBlocking("t1");
  startBlocking("t2");
  startBlocking("t3");

  assert.equal(coordinator.activeCount, 2, "two runs hold slots");
  assert.deepEqual(coordinator.queuedToolCallIds(), ["t3"], "the third waits, in admission order");
  assert.equal(notifications.length, 3, "each registration announces the queue it produced");
  assert.deepEqual(notifications.at(-1), { queued: ["t3"] }, "the snapshot carries the whole queue, not a delta");

  // A slot frees → the waiting run is admitted and the queue empties. The two admitted runs reach
  // their factory body in a microtask after `admit` opens their gate, so wait for them first.
  await sleep(10);
  assert.equal(releases.length, 2, "the two admitted runs are in flight");
  releases[0]();
  await sleep(10);
  assert.deepEqual(coordinator.queuedToolCallIds(), [], "an admission removes the waiting run");
  assert.equal(coordinator.activeCount, 2, "…and takes the freed slot (t2 + t3)");
  assert.ok(
    notifications.some((entry) => entry.queued.length === 0),
    "the admission itself was announced"
  );

  // Discard: every registered run goes away, so the queue must be announced as empty rather than
  // left showing the tasks whose attempt was just thrown away.
  const before = notifications.length;
  coordinator.abortAll("run-abort");
  assert.ok(notifications.length > before, "the discard announced the change");
  assert.deepEqual(notifications.at(-1).queued, [], "the announced queue is empty");
  assert.equal(coordinator.size, 0, "and nothing is registered");

  // Let the aborted runs settle so nothing is left pending: their releases drop the slot counter
  // (what admission reads), and each is announced as well.
  const afterDiscard = notifications.length;
  for (const release of releases) release();
  await sleep(10);
  assert.equal(coordinator.activeCount, 0, "the slots are released as the aborted runs settle");
  assert.ok(notifications.length > afterDiscard, "a release is announced too");
  assert.deepEqual(notifications.at(-1).queued, [], "and an empty queue is what it reports");
}

console.log("task-queue validation passed");
