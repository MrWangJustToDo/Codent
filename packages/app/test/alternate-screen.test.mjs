/**
 * Validates the alternate-screen helper across host shapes, and the wheel-mode pair it owns.
 *
 * The browser case is the regression this file exists for: `@codent/app` is rendered by the
 * playground too, which defines no `process` global at all, so an unguarded
 * `process.stdout.isTTY` threw a ReferenceError out of the workspace panel's mount effect and the
 * web app never rendered. Node's own `process` always exists, so the guard can only be asserted
 * against a stand-in.
 *
 * The pairing cases are the second regression: `?1007h` was written on every panel open and never
 * written back, so the terminal kept translating the wheel into arrow keys after the panel was
 * gone. `?1007l` must appear exactly once per claim, and `?1007h` must never appear at exit.
 *
 * Run: node packages/app/test/alternate-screen.test.mjs
 */
import assert from "node:assert/strict";

import {
  claimWheelAsArrows,
  disableWheelAsArrows,
  enableWheelAsArrows,
  isAlternateScreenActive,
  isWheelAsArrowsEnabled,
  resetWheelAsArrows,
  setAlternateScreenActive,
  wheelModeReleaseSequence,
} from "../dist/utils/alternate-screen.mjs";
import { WHEEL_TAIL_MS, isWheelSettling } from "../dist/utils/wheel-settle.mjs";

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

/** A `process` stand-in whose stdout collects every write. */
function recordingProcess(env = {}) {
  const written = [];
  const stdout = { isTTY: true, write: (chunk) => written.push(chunk) };
  return { written, process: { env, stdout } };
}

resetWheelAsArrows();

// Browser host: no `process` global. Must be inert, not a crash.
withProcess(undefined, () => {
  assert.doesNotThrow(enableWheelAsArrows, "a host without `process` must not crash the panel");
  assert.doesNotThrow(disableWheelAsArrows, "…and must not crash handing the mode back either");
  assert.doesNotThrow(() => claimWheelAsArrows()(), "…nor claiming and releasing it");
  assert.equal(isWheelAsArrowsEnabled(), false, "a browser host never owns the mode");
  assert.equal(wheelModeReleaseSequence(), "", "…so it has nothing to hand back at exit");
});

// A process shim that exists but carries no stdout (bundlers sometimes inject `{ env }`).
withProcess({ env: {} }, () => {
  assert.doesNotThrow(enableWheelAsArrows, "a `process` shim without stdout must not crash either");
  assert.equal(isWheelAsArrowsEnabled(), false, "no TTY ⇒ the mode is never claimed");
});

// Real TTY: exactly the alternate-scroll enable sequence, and nothing else.
{
  const { written, process: shim } = recordingProcess();
  withProcess(shim, () => enableWheelAsArrows());
  assert.deepEqual(written, ["\x1b[?1007h"], "enables xterm alternate-scroll (mode 1007) once");
}

// Enabling twice is one write: the panel re-rendering must not stack sequences.
{
  const { written, process: shim } = recordingProcess();
  resetWheelAsArrows();
  withProcess(shim, () => {
    enableWheelAsArrows();
    enableWheelAsArrows();
  });
  assert.deepEqual(written, ["\x1b[?1007h"], "the mode is claimed once per process");
  assert.equal(isWheelAsArrowsEnabled(), true);
}

// Handing it back is the missing half: `?1007l`, once, and only for a mode we claimed.
{
  const { written, process: shim } = recordingProcess();
  resetWheelAsArrows();
  withProcess(shim, () => {
    enableWheelAsArrows();
    disableWheelAsArrows();
    disableWheelAsArrows();
  });
  assert.deepEqual(
    written,
    ["\x1b[?1007h", "\x1b[?1007l"],
    "the panel's cleanup writes ?1007l — the leak was this line never existing"
  );
  assert.equal(isWheelAsArrowsEnabled(), false, "ownership is released with the write");
}

// xterm ships 1007 ON, so a disable with nothing claimed must write nothing: restore, not override.
{
  const { written, process: shim } = recordingProcess();
  resetWheelAsArrows();
  withProcess(shim, () => disableWheelAsArrows());
  assert.deepEqual(written, [], "a terminal we never claimed keeps its own 1007 default");
}

// The release sequence the process-exit restore writes: empty unless the panel claimed the mode.
{
  const { process: shim } = recordingProcess();
  resetWheelAsArrows();
  withProcess(shim, () => {
    assert.equal(wheelModeReleaseSequence(), "", "nothing claimed ⇒ no bytes at exit");
    enableWheelAsArrows();
    assert.equal(wheelModeReleaseSequence(), "\x1b[?1007l", "claimed ⇒ exit hands the mode back");
    disableWheelAsArrows();
    assert.equal(wheelModeReleaseSequence(), "", "released ⇒ nothing left to hand back");
  });
}

// The pair is one object, so a screen cannot acquire the enable without the disable.
{
  const { written, process: shim } = recordingProcess();
  resetWheelAsArrows();
  withProcess(shim, () => {
    const release = claimWheelAsArrows();
    assert.equal(isWheelAsArrowsEnabled(), true, "claim enables");
    release();
  });
  assert.equal(isWheelAsArrowsEnabled(), false, "release disables");
  assert.deepEqual(written, ["\x1b[?1007h", "\x1b[?1007l"], "…and writes the matching sequence");
  assert.equal(
    isWheelSettling(Date.now()),
    true,
    "releasing also opens the window that swallows the tail still in the pipe"
  );
  assert.equal(
    isWheelSettling(Date.now() + WHEEL_TAIL_MS + 1),
    false,
    "…which ends by itself, or an Esc→↑ would be eaten"
  );
}

// The escape hatch: a terminal that mishandles 1007 must be able to say no.
{
  const { written, process: shim } = recordingProcess({ MY_AGENT_DISABLE_MOUSE: "1" });
  resetWheelAsArrows();
  withProcess(shim, () => {
    enableWheelAsArrows();
    assert.equal(isWheelAsArrowsEnabled(), false, "MY_AGENT_DISABLE_MOUSE=1 keeps our hands off");
    disableWheelAsArrows();
  });
  assert.deepEqual(written, [], "…so nothing is written on either side");
}

// Non-TTY stdout (piped output): no bytes on a stream nobody is reading.
{
  const { written, process: shim } = recordingProcess();
  shim.stdout.isTTY = false;
  resetWheelAsArrows();
  withProcess(shim, () => {
    enableWheelAsArrows();
    disableWheelAsArrows();
  });
  assert.deepEqual(written, [], "a non-TTY stdout gets no escape sequence");
}

// The owner mark the host reads on exit to decide where the summary can be printed.
setAlternateScreenActive(true);
assert.equal(isAlternateScreenActive(), true);
setAlternateScreenActive(false);
assert.equal(isAlternateScreenActive(), false);

console.log("alternate-screen validation passed");
