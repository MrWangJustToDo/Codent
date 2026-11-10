/**
 * Validates the wheel-tail quarantine — the window that keeps a trackpad's momentum from being read
 * as arrow keys right after the workspace panel gives the terminal back.
 *
 * Why it needs a test at all: the bug it fixes is invisible in the code that owns the mode. The
 * panel correctly switches 1007 off, and the arrows still arrive, because the terminal had already
 * translated a tick into bytes before it processed the disable write. Only the timing policy can be
 * asserted, and only with an injected clock.
 *
 * Run: node packages/app/test/wheel-settle.test.mjs
 */
import assert from "node:assert/strict";

import {
  WHEEL_TAIL_MS,
  beginWheelSettle,
  consumeWheelTail,
  endWheelSettle,
  isWheelSettling,
} from "../dist/utils/wheel-settle.mjs";

// Nothing has been claimed yet: no window, so a first ↑ at any time is a key press.
assert.equal(isWheelSettling(0), false, "a process that never opened the panel quarantines nothing");
assert.equal(isWheelSettling(Number.MAX_SAFE_INTEGER), false, "…and never will");

// The window is inclusive of the release instant and exclusive of its end.
beginWheelSettle(1_000);
assert.equal(isWheelSettling(1_000), true, "the press that lands with the release is the wheel's");
assert.equal(isWheelSettling(1_000 + WHEEL_TAIL_MS - 1), true, "…so is everything up to the tail");
assert.equal(isWheelSettling(1_000 + WHEEL_TAIL_MS), false, "the window ends after the tail");
assert.equal(isWheelSettling(9_999), false, "…and stays closed");

// Each release re-arms it from its own instant (two panel visits in a row).
beginWheelSettle(5_000);
assert.equal(isWheelSettling(5_000), true);
beginWheelSettle(5_010);
assert.equal(isWheelSettling(5_010 + WHEEL_TAIL_MS - 1), true, "the later release extends the window");
assert.equal(isWheelSettling(5_010 + WHEEL_TAIL_MS), false);

// A non-arrow key ends it immediately, so typing is never swallowed.
beginWheelSettle(7_000);
assert.equal(isWheelSettling(7_001), true);
endWheelSettle();
assert.equal(isWheelSettling(7_001), false, "proof that a person is at the keyboard cancels the window");

// ── the policy the chat input asks ──────────────────────────────────────────

// Inside the window every arrow is the wheel: this is the reported symptom, one notch recalling a
// previous prompt (up/down) or sliding the cursor across the line (left/right).
beginWheelSettle(10_000);
for (const arrow of ["upArrow", "downArrow", "leftArrow", "rightArrow"]) {
  assert.equal(
    consumeWheelTail({ [arrow]: true }, 10_001),
    true,
    `${arrow} inside the tail window must be swallowed, not sent to the input`
  );
}
assert.equal(isWheelSettling(10_001), true, "swallowing an arrow does not end the window");

// Any other key proves a person is there, so the window closes and the next ↑ is a real key.
assert.equal(consumeWheelTail({}, 10_002), false, "a non-arrow key is never swallowed");
assert.equal(isWheelSettling(10_002), false, "…and it ends the window");
assert.equal(consumeWheelTail({ upArrow: true }, 10_003), false, "so the ↑ the user presses next gets through");

// Outside the window the same arrow is a key press, wheel or not.
assert.equal(consumeWheelTail({ upArrow: true }, 10_000 + WHEEL_TAIL_MS), false, "an expired window swallows nothing");

// Nothing claimed at all (the common case: the panel was never opened).
endWheelSettle();
assert.equal(consumeWheelTail({ upArrow: true }), false, "a session that never opened the panel is unaffected");

// The window has to stay short: `Esc` then `↑` (recall the last prompt) is a normal flow, and a
// generous quarantine would eat it. This is the assertion that keeps someone from "fixing" a
// leftover leak by widening it.
assert.ok(WHEEL_TAIL_MS <= 50, `the tail window must stay under a human keypress delay (got ${WHEEL_TAIL_MS}ms)`);
assert.ok(WHEEL_TAIL_MS >= 16, `…and cover at least one frame of pipe latency (got ${WHEEL_TAIL_MS}ms)`);

console.log("wheel-settle validation passed");
