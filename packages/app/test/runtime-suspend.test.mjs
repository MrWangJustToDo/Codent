/**
 * Validates the suspend/resume decision that keeps a session alive across a host handoff.
 *
 * The rule is small, and it was deliberately factored out of the React hooks because a mistake here
 * is silent and expensive: `preserve` on an ordinary exit leaks the runtime, `release` on a handoff
 * kills the session (and any run streaming through it) while the user is in their editor.
 *
 * Run: node --test test/runtime-suspend.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  beginRuntimeSuspend,
  consumeRuntimeSuspend,
  isRuntimeSuspended,
  resolveMountAction,
  resolveUnmountAction,
} from "../dist/utils/runtime-suspend.mjs";

test("a plain unmount releases the runtime", () => {
  assert.equal(isRuntimeSuspended(), false);
  assert.equal(resolveUnmountAction({ suspended: false }), "release");
  assert.equal(resolveMountAction({ suspended: false, hasSession: false }), "initialize");
});

test("suspend preserves the runtime through the unmount", () => {
  beginRuntimeSuspend();
  assert.equal(isRuntimeSuspended(), true);
  assert.equal(resolveUnmountAction({ suspended: true }), "preserve");
});

test("the mount that resumes re-binds instead of initializing", () => {
  beginRuntimeSuspend();
  const mountAction = resolveMountAction({ suspended: true, hasSession: true });
  assert.equal(mountAction, "resume");

  // The resume consumes the bit, so the next unmount is an ordinary one again.
  assert.equal(consumeRuntimeSuspend(), true);
  assert.equal(isRuntimeSuspended(), false);
  assert.equal(resolveUnmountAction({ suspended: isRuntimeSuspended() }), "release");
});

test("a suspend with nothing bound still initializes", () => {
  beginRuntimeSuspend();
  // Nothing survived the unmount (a host that cleared the store, a crash in between): keeping the UI
  // dead would be worse than rebuilding, so this falls back to a real initialization.
  assert.equal(resolveMountAction({ suspended: true, hasSession: false }), "initialize");
  consumeRuntimeSuspend();
});

test("consuming twice is inert", () => {
  beginRuntimeSuspend();
  assert.equal(consumeRuntimeSuspend(), true);
  assert.equal(consumeRuntimeSuspend(), false);
  assert.equal(resolveMountAction({ suspended: false, hasSession: true }), "initialize");
});
