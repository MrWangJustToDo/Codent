/**
 * Validates the footer's queue hint.
 *
 * While something is queued the row must carry only two facts — what is waiting and how to cancel
 * it — because it shares a single line with the status text. The secondary chords come back once
 * the queue is empty.
 *
 * Run: node packages/app/test/queue-hint.test.mjs
 */
import assert from "node:assert/strict";

import { busyQueueHint } from "../dist/utils/keyboard-labels.mjs";

{
  const hint = busyQueueHint(1, 1, "fix the failing test");
  assert.match(hint, /^Queued \(2\): "fix the failing test"/, "the preview names what is queued");
  assert.match(hint, /Esc cancel queue$/, "the only action offered while queued is cancelling it");
  assert.ok(!hint.includes("force submit"), "force-submit is a secondary chord; it comes back when empty");
  assert.ok(!hint.includes("recall"), "recall is a secondary chord; it comes back when empty");
  assert.ok(!hint.includes("Enter queue"), "how you got here is not the question while queued");
  assert.equal(hint.split("\n").length, 1, "one line, never wrapped");
}

{
  const hint = busyQueueHint(0, 0, null);
  assert.match(hint, /Enter queue/);
  assert.match(hint, /force submit/);
  assert.match(hint, /Esc abort/);
  assert.ok(!hint.includes("cancel queue"), "no queue, no cancel action");
}

{
  // Attachments-only (the preview helper still produces a chip) and a missing preview both stay
  // on one line without inventing quotes.
  assert.match(busyQueueHint(2, 0, null), /^Queued \(2\) · Esc cancel queue$/);
  assert.match(busyQueueHint(2, 0, "[3 attachments]"), /^Queued \(2\): "\[3 attachments\]"/);
}

{
  // The preview is clamped to the room left; the shortcut must survive the clamp.
  const hint = busyQueueHint(3, 0, "x".repeat(80), { previewMax: 10 });
  assert.ok(hint.includes(`"${"x".repeat(9)}…"`), "an over-long preview is ellipsised, not wrapped");
  assert.match(hint, /Esc cancel queue$/);
  assert.ok(hint.length < 60, `the clamped line stays narrow, got ${hint.length}`);
}

console.log("queue-hint validation passed");
