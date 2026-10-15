/**
 * Validates workspace scroll helpers.
 *
 * Run: node packages/app/test/workspace-scroll.test.mjs
 */
import assert from "node:assert/strict";

import { useWorkspacePanel } from "../dist/hooks/use-workspace-panel.mjs";
import { clampScrollTop, ensureIndexVisible, visibleWindow } from "../dist/utils/workspace-scroll.mjs";

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

console.log("workspace-scroll validation passed");
