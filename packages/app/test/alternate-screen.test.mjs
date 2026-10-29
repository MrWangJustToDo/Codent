/**
 * Validates the alternate-screen helper across host shapes.
 *
 * The browser case is the regression this file exists for: `@codent/app` is rendered by the
 * playground too, which defines no `process` global at all, so an unguarded
 * `process.stdout.isTTY` threw a ReferenceError out of the workspace panel's mount effect and the
 * web app never rendered. Node's own `process` always exists, so the guard can only be asserted
 * against a stand-in.
 *
 * Run: node packages/app/test/alternate-screen.test.mjs
 */
import assert from "node:assert/strict";

import {
  enableWheelAsArrows,
  isAlternateScreenActive,
  setAlternateScreenActive,
} from "../dist/utils/alternate-screen.mjs";

/** Run `fn` with a stand-in global `process` (undefined = a browser), restoring the real one after. */
function withProcess(value, fn) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "process");
  Object.defineProperty(globalThis, "process", { value, configurable: true, writable: true });
  try {
    return fn();
  } finally {
    if (saved) Object.defineProperty(globalThis, "process", saved);
    else delete globalThis.process;
  }
}

// Browser host: no `process` global. Must be inert, not a crash.
withProcess(undefined, () => {
  assert.doesNotThrow(enableWheelAsArrows, "a host without `process` must not crash the panel");
});

// A process shim that exists but carries no stdout (bundlers sometimes inject `{ env }`).
withProcess({ env: {} }, () => {
  assert.doesNotThrow(enableWheelAsArrows, "a `process` shim without stdout must not crash either");
});

// Real TTY: exactly the alternate-scroll enable sequence, and nothing else.
{
  const written = [];
  const tty = { stdout: { isTTY: true, write: (chunk) => written.push(chunk) } };
  withProcess(tty, () => enableWheelAsArrows());
  assert.deepEqual(written, ["\x1b[?1007h"], "enables xterm alternate-scroll (mode 1007) once");
}

// Non-TTY stdout (piped output): no bytes on a stream nobody is reading.
{
  const written = [];
  const piped = { stdout: { isTTY: false, write: (chunk) => written.push(chunk) } };
  withProcess(piped, () => enableWheelAsArrows());
  assert.deepEqual(written, [], "a non-TTY stdout gets no escape sequence");
}

// The owner mark the host reads on exit to decide where the summary can be printed.
setAlternateScreenActive(true);
assert.equal(isAlternateScreenActive(), true);
setAlternateScreenActive(false);
assert.equal(isAlternateScreenActive(), false);

console.log("alternate-screen validation passed");
