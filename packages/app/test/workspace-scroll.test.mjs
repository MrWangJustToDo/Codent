/**
 * Validates workspace scroll helpers.
 *
 * Run: node packages/app/test/workspace-scroll.test.mjs
 */
import assert from "node:assert/strict";

import { useWorkspacePanel } from "../dist/hooks/use-workspace-panel.mjs";
import {
  clampScrollTop,
  createScrollPacer,
  ensureIndexVisible,
  PREVIEW_SCROLL_STEP,
  SCROLL_BURST_INTERVAL_MS,
  visibleWindow,
} from "../dist/utils/workspace-scroll.mjs";

assert.equal(ensureIndexVisible(0, 0, 5, 10), 0);
assert.equal(ensureIndexVisible(6, 0, 5, 10), 2);
assert.equal(ensureIndexVisible(3, 2, 5, 10), 2);

assert.equal(clampScrollTop(-3, 20, 5), 0);
assert.equal(clampScrollTop(99, 20, 5), 15);
assert.equal(clampScrollTop(4, 20, 5), 4);

// The window always sits inside the rows — the invariant the file tree, quick-open and
// `ScrollableList` all render through.
assert.deepEqual(visibleWindow([1, 2, 3, 4, 5], 0, 2), { start: 0, end: 2, slice: [1, 2] });
// A stale offset past the end clamps to the last full window instead of drawing nothing.
assert.deepEqual(visibleWindow([1, 2, 3], 99, 2), { start: 1, end: 3, slice: [2, 3] });
// A pane taller than the list shows the whole list from the top.
assert.deepEqual(visibleWindow([1, 2], 5, 10), { start: 0, end: 2, slice: [1, 2] });
assert.deepEqual(visibleWindow([], 3, 4), { start: 0, end: 0, slice: [] });

// A mode switch swaps the whole row set (full tree ↔ changed files), so the window resets with
// it: an offset carried over from the full tree landed past the end of the shorter diff list and
// the pane drew blank.
assert.equal(useWorkspacePanel.getReadonlyState().view, "closed");
const ws = useWorkspacePanel.getActions();
ws.open();
ws.setTreeScrollTop(80);
assert.equal(useWorkspacePanel.getReadonlyState().treeScrollTop, 80);

ws.toggleMode();
assert.equal(useWorkspacePanel.getReadonlyState().mode, "diff");
assert.equal(useWorkspacePanel.getReadonlyState().treeScrollTop, 0, "toggleMode resets the tree window");

ws.setTreeScrollTop(80);
ws.setMode("preview");
assert.equal(useWorkspacePanel.getReadonlyState().treeScrollTop, 0, "setMode resets the tree window");

// ============================================================================
// Wheel input policy (sensitivity + inertia)
// ============================================================================

// One wheel notch moves ONE row. The terminal delivers the notch as an arrow key (mode 1007), so
// a bigger step multiplies the wheel's speed instead of a press's — 3 was three rows per notch.
assert.equal(PREVIEW_SCROLL_STEP, 1, "a wheel notch moves one row");

// The cap sits just under the fastest default key repeat (Windows/X11 repeat every 31–40ms), so a
// held arrow key is never dropped...
assert.ok(SCROLL_BURST_INTERVAL_MS < 40, "a held arrow key (40ms repeat) is not throttled");

const pacer = createScrollPacer(SCROLL_BURST_INTERVAL_MS);
assert.equal(pacer.admit(1000), true, "a fresh press moves");
assert.equal(pacer.admit(1010), false, "a second event 10ms later is momentum, not intent");
assert.equal(pacer.admit(1031), false, "still inside the window");
assert.equal(pacer.admit(1032), true, "the window has passed");

const countAdmitted = (intervalMs, events) => {
  const each = createScrollPacer(SCROLL_BURST_INTERVAL_MS);
  let admitted = 0;
  for (let i = 0; i < events; i += 1) {
    if (each.admit(i * intervalMs)) admitted += 1;
  }
  return admitted;
};

// ...while a trackpad's momentum (8–16ms between notches) is cut down to a third of its events.
assert.equal(countAdmitted(40, 20), 20, "a keyboard-speed repeat passes through untouched");
assert.equal(countAdmitted(16, 20), 10, "momentum at 16ms is halved");
assert.equal(countAdmitted(8, 20), 5, "momentum at 8ms is cut to a quarter");

// The reset is what keeps a freshly focused pane responsive: switching panes forgets the last
// step, so the first key in the new pane scrolls even if it lands inside the window.
const resetPacer = createScrollPacer(SCROLL_BURST_INTERVAL_MS);
assert.equal(resetPacer.admit(1000), true);
assert.equal(resetPacer.admit(1005), false);
resetPacer.reset();
assert.equal(resetPacer.admit(1005), true, "reset makes the next press count");

// The whole policy, measured the way the user feels it: one second of momentum (a trackpad keeps
// emitting notches for ~1s after the fingers stop) against a long file. What the panel does now is
// the `paced` column — the `unpaced` one is the behaviour this replaced (3 rows × every event).
const simulateGesture = ({ intervalMs, durationMs, step, paced }) => {
  const gesture = createScrollPacer(SCROLL_BURST_INTERVAL_MS);
  let offset = 0;
  for (let t = 0; t < durationMs; t += intervalMs) {
    if (!paced || gesture.admit(t)) offset = clampScrollTop(offset + step, 10_000, 40);
  }
  return offset;
};

const unpaced = simulateGesture({ intervalMs: 8, durationMs: 1000, step: 3, paced: false });
const paced = simulateGesture({ intervalMs: 8, durationMs: 1000, step: PREVIEW_SCROLL_STEP, paced: true });
assert.equal(unpaced, 375, "the old policy: 125 notches × 3 rows in one second");
assert.equal(paced, 32, "the new policy: one row per admitted notch, ~32 per second");
assert.ok(paced * 5 < unpaced, `a momentum burst moves ~${Math.round(unpaced / paced)}× fewer rows`);

console.log("workspace-scroll validation passed");
