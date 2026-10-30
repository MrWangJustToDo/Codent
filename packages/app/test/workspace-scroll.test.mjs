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
  createScrollStepper,
  createWheelGestureGuard,
  CURSOR_SCROLL_BURST_MS,
  ensureIndexVisible,
  PREVIEW_SCROLL_CONTINUOUS_STEP,
  PREVIEW_SCROLL_STEP,
  SCROLL_BURST_INTERVAL_MS,
  SCROLL_DISCRETE_GAP_MS,
  visibleWindow,
  WHEEL_GESTURE_BURST_MS,
  WHEEL_GESTURE_COMMIT_MS,
  WHEEL_GESTURE_QUIET_MS,
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

// A discrete notch moves a line group; the two panes measure different things (the tree moves a
// cursor = one item, the preview moves content = one line), so the preview moving 4 lines per
// deliberate notch is what makes them feel comparable.
assert.equal(PREVIEW_SCROLL_STEP, 4, "a discrete notch moves four rows");
assert.equal(PREVIEW_SCROLL_CONTINUOUS_STEP, 2, "a step inside a stream moves two rows");
assert.equal(SCROLL_BURST_INTERVAL_MS, 16, "the content gate admits one event per frame");
assert.ok(SCROLL_DISCRETE_GAP_MS > SCROLL_BURST_INTERVAL_MS, "a notch needs a longer pause than momentum");
// Cursor panes keep the pace they were tuned to: one item per admitted event at 32ms, or a flick
// walks 60+ rows down the tree.
assert.equal(CURSOR_SCROLL_BURST_MS, 32, "cursor panes keep the slower gate");
assert.ok(CURSOR_SCROLL_BURST_MS > SCROLL_BURST_INTERVAL_MS, "content is admitted more often than a cursor move");

// The stepper is the whole content-scroll policy in one place: momentum is dropped, a stream moves
// the stream step, and a notch after a pause moves the full step.
const stepper = createScrollStepper();
assert.equal(stepper.rows(1000), PREVIEW_SCROLL_STEP, "the first notch after idle is a discrete one");
assert.equal(stepper.rows(1010), 0, "10ms later is momentum, not intent");
assert.equal(stepper.rows(1042), PREVIEW_SCROLL_CONTINUOUS_STEP, "a stream moves the stream step");
assert.equal(stepper.rows(1074), PREVIEW_SCROLL_CONTINUOUS_STEP, "and stays there while it lasts");
assert.equal(stepper.rows(1074 + SCROLL_DISCRETE_GAP_MS), PREVIEW_SCROLL_STEP, "a pause earns a notch");
stepper.reset();
assert.equal(stepper.rows(5000), PREVIEW_SCROLL_STEP, "reset makes the next press a fresh notch");

// A held arrow key (40ms repeat) is never dropped — the step is just the stream step.
const held = createScrollStepper();
assert.equal(held.rows(0), PREVIEW_SCROLL_STEP);
assert.equal(held.rows(40), PREVIEW_SCROLL_CONTINUOUS_STEP, "a held key moves the stream step per repeat");
assert.equal(held.rows(80), PREVIEW_SCROLL_CONTINUOUS_STEP);

// The content gate sits under the fastest default key repeat (Windows/X11 repeat every 31–40ms), so
// a held arrow key is never dropped...
assert.ok(SCROLL_BURST_INTERVAL_MS < 40, "a held arrow key (40ms repeat) is not throttled");

const pacer = createScrollPacer(CURSOR_SCROLL_BURST_MS);
assert.equal(pacer.admit(1000), true, "a fresh press moves");
assert.equal(pacer.admit(1010), false, "a second event 10ms later is momentum, not intent");
assert.equal(pacer.admit(1031), false, "still inside the window");
assert.equal(pacer.admit(1032), true, "the window has passed");

const countAdmitted = (intervalMs, events) => {
  const each = createScrollPacer(CURSOR_SCROLL_BURST_MS);
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
const resetPacer = createScrollPacer(CURSOR_SCROLL_BURST_MS);
assert.equal(resetPacer.admit(1000), true);
assert.equal(resetPacer.admit(1005), false);
resetPacer.reset();
assert.equal(resetPacer.admit(1005), true, "reset makes the next press count");

// The whole policy, measured the way the user feels it: one second of momentum (a trackpad keeps
// emitting notches for ~1s after the fingers stop) against a long file. The two-tier step is what
// makes "more sensitive" safe: a deliberate notch is heavier, while the tail is bounded by the
// number of admitted EVENTS, so a bigger step cannot make it run away.
const simulateGesture = ({ intervalMs, durationMs, step, paced }) => {
  const gesture = paced ? createScrollStepper() : null;
  let offset = 0;
  for (let t = 0; t < durationMs; t += intervalMs) {
    const rows = paced ? gesture.rows(t) : step;
    if (rows > 0) offset = clampScrollTop(offset + rows, 10_000, 40);
  }
  return offset;
};

const unpaced = simulateGesture({ intervalMs: 8, durationMs: 1000, step: 3, paced: false });
const paced = simulateGesture({ intervalMs: 8, durationMs: 1000, step: 0, paced: true });
assert.equal(unpaced, 375, "the old policy: 125 notches × 3 rows in one second");
// An 8ms event stream through the 16ms gate admits 63 steps in 1000ms: the first is a notch (nothing
// preceded it), the remaining 62 are stream steps. 4 + 62×2 = 128 rows — ~4× what the 32ms/1-row
// policy allowed, and still a third of the unpaced 375 that ran away with the file.
const momentumCeiling = PREVIEW_SCROLL_STEP + 62 * PREVIEW_SCROLL_CONTINUOUS_STEP;
assert.equal(paced, momentumCeiling, "momentum is bounded by admitted EVENTS, not by the step");
assert.ok(paced * 2 < unpaced, `a momentum burst moves ~${Math.round(unpaced / paced)}× fewer rows than unpaced`);

// ...while a hand-turned wheel earns the full step per notch — the complaint this addresses: a
// notch used to move a single line in a text pane, which reads as sluggish next to the tree.
const notches = simulateGesture({ intervalMs: 200, durationMs: 2000, step: 0, paced: true });
assert.equal(notches, 10 * PREVIEW_SCROLL_STEP, "ten deliberate notches move ten line groups");

// ============================================================================
// Horizontal wheel (the same 1007 plane, translated to ←/→)
// ============================================================================

// A trackpad's lateral swipe is a stream of LEFT/RIGHT keys — far faster than a keyboard repeats —
// which is the one property that lets the panel ignore it entirely instead of expanding a
// directory or bouncing the focus between the panes.
assert.ok(WHEEL_GESTURE_BURST_MS < 31, "the burst window sits under the fastest auto-repeat (31ms)");
assert.ok(WHEEL_GESTURE_COMMIT_MS <= WHEEL_GESTURE_BURST_MS, "a press must commit before a second one could arrive");
assert.ok(WHEEL_GESTURE_QUIET_MS > WHEEL_GESTURE_COMMIT_MS, "a gesture outlives its commit window");

const swipe = createWheelGestureGuard();
assert.equal(swipe.press(0), "defer", "the first press is held for one commit window");
assert.equal(swipe.press(10), "swallow", "10ms later proves it is a swipe and drops the held action");
assert.equal(swipe.commit(), false, "…so the held action never runs");
assert.equal(swipe.press(20), "swallow", "the rest of the gesture is swallowed");
assert.equal(swipe.press(150), "swallow", "…including a slower tail while the gesture lasts");
assert.equal(swipe.press(1000), "defer", "after the quiet window a real press counts again");
assert.equal(swipe.commit(), true, "and it runs");

// A single press of its own always commits: the guard costs one frame, not the keypress.
const loneKey = createWheelGestureGuard();
assert.equal(loneKey.press(0), "defer");
assert.equal(loneKey.commit(), true, "a lone → expands the directory as before");

// A held key repeats slower than the burst window (and starts after the platform's repeat delay),
// so every repeat is a fresh decision and holding → still walks the tree.
const heldKey = createWheelGestureGuard();
assert.equal(heldKey.press(0), "defer");
assert.equal(heldKey.commit(), true);
assert.equal(heldKey.press(500), "defer");
assert.equal(heldKey.commit(), true);
assert.equal(heldKey.press(540), "defer", "a 40ms auto-repeat is not a swipe");
assert.equal(heldKey.commit(), true);

// Teardown drops a waiting action instead of running it after the pane unmounts.
const tornDown = createWheelGestureGuard();
tornDown.press(0);
tornDown.cancel();
assert.equal(tornDown.commit(), false, "a cancelled press never runs");

console.log("workspace-scroll validation passed");
