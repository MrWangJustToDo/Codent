/**
 * Validates the mid-run queue's footer rendering: which message the line names, and what it says
 * disappearing input costs.
 *
 * Run: node packages/app/test/queue-preview.test.mjs
 */
import assert from "node:assert/strict";

import { busyQueueHint } from "../dist/utils/keyboard-labels.mjs";
import { nextQueuedPreview, queuedTotal } from "../dist/utils/queue-preview.mjs";

const empty = { steer: [], followUp: [] };

assert.equal(nextQueuedPreview(undefined), null, "no snapshot → nothing to name");
assert.equal(nextQueuedPreview(empty), null, "an empty queue has no head");
assert.equal(queuedTotal(empty), 0);
assert.equal(queuedTotal(undefined), 0);

// Steer drains into the channel before follow-up (`prepareContinuationPhase`), so the head is the steer.
assert.equal(
  nextQueuedPreview({ steer: ["steer me"], followUp: ["then this"] }),
  "steer me",
  "the line names the message that will be delivered next"
);
assert.equal(nextQueuedPreview({ steer: [], followUp: ["then this"] }), "then this");
assert.equal(queuedTotal({ steer: ["a"], followUp: ["b", "c"] }), 3, "the count is the whole queue");

// Content parts: text parts are joined, and an attachments-only message becomes a chip rather than
// rendering as an empty line.
assert.equal(
  nextQueuedPreview({
    steer: [],
    followUp: [
      [
        { type: "text", content: "look at " },
        { type: "text", content: "this" },
      ],
    ],
  }),
  "look at this"
);
assert.equal(
  nextQueuedPreview({ steer: [], followUp: [[{ type: "image", source: { type: "data", value: "x" } }]] }),
  "[1 attachment]"
);
assert.equal(
  nextQueuedPreview({
    steer: [],
    followUp: [
      [
        { type: "image", source: { type: "data", value: "x" } },
        { type: "image", source: { type: "data", value: "y" } },
      ],
    ],
  }),
  "[2 attachments]"
);

// One row: newlines collapse, and a long message is ellipsised rather than wrapped.
assert.equal(nextQueuedPreview({ steer: [], followUp: ["first\nsecond\n\nthird"] }), "first second third");
assert.ok(
  (nextQueuedPreview({ steer: [], followUp: ["y".repeat(60)] }) ?? "").length <= 28,
  "the default budget fits one row"
);

const long = "x".repeat(80);
const short = nextQueuedPreview({ steer: [], followUp: [long] }, 20);
assert.equal(short?.length, 20, "the preview fits the budget it is given");
assert.ok(short?.endsWith("…"), "…and says it was cut");

// The busy hint names the queue and what Esc costs. Both halves matter: the count alone never told a
// user WHAT they queued, and `Esc` silently dropped it.
const hint = busyQueueHint(1, 1, "fix the flaky test");
assert.ok(hint.includes(`Queued (2): "fix the flaky test"`), hint);
assert.ok(hint.includes("drops them"), `the abort entry refers back to the count it clears: ${hint}`);
assert.ok(hint.includes("force submit"), hint);
// With a queue, "Enter queues" (how you got here) gives way to the thing you cannot guess: taking one
// back. The line stays the same width.
assert.ok(hint.includes("Ctrl+Q recall"), hint);
assert.ok(!hint.includes("Enter queue"), hint);
// The count is stated exactly once: it appeared three times when the preview was added to a hint that
// already counted follow-ups and repeated the total in the abort warning.
assert.equal((hint.match(/\(2\)/g) ?? []).length, 1, `one count, not three: ${hint}`);

const emptyHint = busyQueueHint(0, 0);
assert.ok(!emptyHint.includes("drops"), `nothing queued → nothing to warn about: ${emptyHint}`);
assert.ok(!emptyHint.includes("Queued"), emptyHint);
assert.ok(emptyHint.includes("Enter queue"), emptyHint);
assert.ok(!emptyHint.includes("recall"), emptyHint);
