/**
 * Activation rule for the app's surface input hooks.
 *
 * The renderer broadcasts every keystroke to every subscribed handler, so the only thing that
 * keeps a panel from answering the chat's keys is which handlers are subscribed at all. These
 * assertions pin that rule, and the listener-snapshot property the panel-close case relies on.
 *
 * They test the rule, not the wiring: whether a given screen really is wrapped in its scope, and
 * whether `Ctrl+C` still reaches an exit handler on a panel screen, needs a mounted tree — that
 * lives in `pnpm validate:render-smoke` (both checks were mutation-verified: gating the unscoped
 * hook or dropping the wizard's scope makes them fail).
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { isSurfaceActive } from "../dist/index.mjs";

test("a handler is inert outside any scope", () => {
  // Rendering a surface hook without an InputScope must not mean "active everywhere" — that is the
  // shape the removed `isAnyPanelOpen()` guard left behind.
  assert.equal(isSurfaceActive(null, "main"), false);
  assert.equal(isSurfaceActive(null, "workspace"), false);
});

test("a handler is active only in the scope whose surface it names", () => {
  assert.equal(isSurfaceActive("main", "main"), true);
  assert.equal(isSurfaceActive("workspace", "workspace"), true);
  assert.equal(isSurfaceActive("task", "task"), true);
  assert.equal(isSurfaceActive("extension", "extension"), true);

  assert.equal(isSurfaceActive("workspace", "main"), false);
  assert.equal(isSurfaceActive("main", "workspace"), false);
  assert.equal(isSurfaceActive("task", "extension"), false);
});

test("the sub-surface predicate can only narrow, never widen", () => {
  assert.equal(isSurfaceActive("main", "main", true), true);
  assert.equal(isSurfaceActive("main", "main", undefined), true);
  assert.equal(isSurfaceActive("main", "main", false), false);

  // A sub-surface that is up outside its own screen stays off.
  assert.equal(isSurfaceActive("workspace", "main", true), false);
});

test("only one sub-surface of a surface can be active for a keystroke", () => {
  // The mode handlers and the workspace's two panes are modelled as `when` predicates on one
  // surface; exactly one of them may be true at a time or two handlers would act on one key.
  const modes = ["normal", "approval", "select", "freeform"];
  for (const current of modes) {
    const active = modes.filter((mode) => isSurfaceActive("main", "main", mode === current));
    assert.deepEqual(active, [current], `expected exactly one active mode, got ${active.join(", ")}`);
  }

  const quickOpen = [false, true];
  for (const open of quickOpen) {
    const fileMode = isSurfaceActive("workspace", "workspace", !open);
    const quickOpenPane = isSurfaceActive("workspace", "workspace", open);
    assert.equal(Number(fileMode) + Number(quickOpenPane), 1, `quickOpen=${open} activated both panes`);
  }
});

test("a listener added during an emit never receives that emit", () => {
  // This is why the 300ms close debounce could be deleted: the keystroke that closes a panel
  // reaches the panel's handler only. The chat's handlers are subscribed by the render that
  // follows, and Node's EventEmitter clones its listener array before dispatching.
  const bus = new EventEmitter();
  const seen = [];

  const chatHandler = () => seen.push("chat");

  bus.on("input", () => {
    seen.push("panel");
    // The panel closed: the chat screen mounts, so its handler subscribes mid-emit.
    bus.on("input", chatHandler);
  });

  bus.emit("input", "escape");
  assert.deepEqual(seen, ["panel"], "the chat handler must not see the keystroke that mounted it");

  bus.emit("input", "escape");
  assert.deepEqual(seen, ["panel", "panel", "chat"], "the next keystroke reaches the chat");
});
