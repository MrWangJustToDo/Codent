/**
 * Validates the rotating input hints: copy coverage (operations, shortcuts, slash
 * commands) plus the shuffled-pass deck — a pass shows every hint exactly once,
 * nothing repeats back to back, and a remount keeps the hint on screen.
 *
 * Run: node packages/app/test/input-hints.test.mjs
 */
import assert from "node:assert/strict";

import {
  HINT_ROTATE_INTERVAL_MS,
  INPUT_HINTS,
  currentInputHint,
  nextInputHint,
  resetInputHints,
  wrapTextToLines,
} from "../dist/index.mjs";

/** Deterministic RNG (mulberry32) so pass behaviour is reproducible. */
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const count = INPUT_HINTS.length;

// ---------------------------------------------------------------------------
// 1. Copy: more of it, unique, short enough for a placeholder
// ---------------------------------------------------------------------------
assert.ok(count >= 20, `expected a richer hint set, got ${count}`);
assert.equal(new Set(INPUT_HINTS).size, count, "hints must be unique");
for (const hint of INPUT_HINTS) {
  assert.ok(hint.trim().length > 0, "hints must not be empty");
  assert.ok(hint.length <= 80, `hint too long for a placeholder: ${hint}`);
}

// The hint set must keep covering operations, panels/shortcuts and commands.
const copy = INPUT_HINTS.join("\n");
const required = [
  "Try: ", // quick-start prompts
  "/help",
  "/mode",
  "/models",
  "/resume",
  "/compact",
  "/settings",
  "/usage",
  "Ctrl+J", // newline while idle
  "Ctrl+U",
  "Ctrl+A",
  "Ctrl+V",
  "Ctrl+O",
  "Ctrl+C",
  "Ctrl+E",
  "Ctrl+T",
  "Ctrl+Y",
  "Ctrl+P",
  "Shift+Tab",
  "Esc",
  "Tab",
  "↑↓",
  "y / n", // approves / denies a tool call
];
for (const token of required) {
  assert.ok(copy.includes(token), `hint copy must mention ${token}`);
}

assert.equal(HINT_ROTATE_INTERVAL_MS, 6000, "rotation interval");

// ---------------------------------------------------------------------------
// 2. A pass shows every hint exactly once and does not re-open on the current one
// ---------------------------------------------------------------------------
resetInputHints();
const onScreen = currentInputHint();
assert.equal(onScreen, INPUT_HINTS[0], "a fresh session shows the first hint");

const random = seededRandom(1337);
const firstPass = Array.from({ length: count }, () => nextInputHint(random));
assert.equal(new Set(firstPass).size, count, "a pass covers every hint exactly once");
assert.notEqual(firstPass[0], onScreen, "a pass must not open with the hint already on screen");
assert.notDeepEqual(firstPass, [...INPUT_HINTS], "the deck is shuffled, not drawn in source order");
assert.equal(currentInputHint(), firstPass[count - 1], "the deck keeps the hint on screen for a remount");

// ---------------------------------------------------------------------------
// 3. Later passes keep the same guarantees, and nothing repeats back to back
// ---------------------------------------------------------------------------
const passes = 4;
const later = Array.from({ length: count * passes }, () => nextInputHint(random));
for (let pass = 0; pass < passes; pass++) {
  const drawn = later.slice(pass * count, (pass + 1) * count);
  assert.equal(new Set(drawn).size, count, `pass ${pass + 2} covers every hint exactly once`);
}
const sequence = [...firstPass, ...later];
for (let i = 1; i < sequence.length; i++) {
  assert.notEqual(sequence[i], sequence[i - 1], `hint repeated back to back at ${i}`);
}

// ---------------------------------------------------------------------------
// 4. Reset restores the fresh-session state
// ---------------------------------------------------------------------------
resetInputHints();
assert.equal(currentInputHint(), INPUT_HINTS[0]);

// ---------------------------------------------------------------------------
// 5. Startup tip copy stays measurable at the same width the tips row uses
// ---------------------------------------------------------------------------
// The header row budgets its tips in terminal columns (measured with the same wrapper),
// so each hint that carries a tip must be a single row of text at a normal width.
const HEADER_TIP_COPY = [
  "/ opens all commands",
  "Shift+Tab cycles",
  "Ctrl+E workspace",
  "Ctrl+T tasks",
  "Ctrl+Y extensions",
];
for (const tip of HEADER_TIP_COPY) {
  assert.ok(copy.includes(tip), `hint copy must mention the header tip "${tip}"`);
  assert.ok(wrapTextToLines(tip, 120).length === 1, `tip must stay one row: ${tip}`);
}

process.stdout.write("input-hints: ok\n");
