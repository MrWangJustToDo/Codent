/**
 * Validates the extension render surface's ANSI sanitizer — the one gate between an extension's
 * raw payload and the host's terminal.
 *
 * The bug this pins: the final sweep was `/ESC[\s\S]/`, which ALSO matches the `ESC[` that opens
 * every SGR sequence. So the pass above it kept `ESC[33m`, and this pass immediately ate the
 * `ESC[`, leaving the literal text `33m` on screen. The output looked *nearly* right — the glyph
 * and words were all there, with stray `33m` / `90m` / `0m` fragments — which is exactly why it
 * went unnoticed: the user reported "the color has no effect", not "there is garbage in my
 * footer". A payload-only assertion cannot see this; the sanitizer had to be driven directly.
 *
 * The other half of the contract is the strip list, and it still has to hold: SGR is the ONE
 * sequence family allowed through, because it only styles text. Anything that moves the cursor or
 * erases the screen would wreck a layout the host owns.
 *
 * Run: node packages/app/test/extension-render-surface.test.mjs
 */
import assert from "node:assert/strict";

import { ANSI_RESET, boundAnsiText, sanitizeAnsi } from "../dist/index.mjs";

const ESC = "\u001b";

// ── kept: SGR survives intact, escapes and all ───────────────────────────────
//
// The regression itself. Asserted as round-trip equality rather than "contains a color code":
// the failure mode was silent corruption (escape removed, parameters left behind), so the
// assertion has to be that the input comes back UNCHANGED.
{
  const payload = `${ESC}[33m⏳${ESC}[0m ${ESC}[90m2 running · 1 failed · 2m 14s${ESC}[0m`;
  assert.equal(sanitizeAnsi(payload), payload, "an SGR-only payload passes through byte-for-byte");
}

// Every SGR form an extension might emit, not just the two this repo happens to use.
for (const sgr of [
  "\u001b[0m",
  "\u001b[1m",
  "\u001b[2m",
  "\u001b[33m",
  "\u001b[90m",
  "\u001b[38;5;208m",
  "\u001b[1;33m",
]) {
  assert.equal(sanitizeAnsi(`a${sgr}b`), `a${sgr}b`, `kept: ${JSON.stringify(sgr)}`);
}

// A kept sequence must never leave its parameters behind as text. This is the shape the bug
// produced, so it is asserted separately from the round-trip above. The valid sequences are
// removed first — `"90m"` occurs legitimately INSIDE `ESC[90m`, so the check has to look at
// what remains once the escapes themselves are gone.
{
  const out = sanitizeAnsi(`${ESC}[90mdim${ESC}[0m`);
  const withoutSequences = out.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
  assert.equal(withoutSequences, "dim", "no SGR parameters may survive as literal text");
  assert.ok(!/\d+m/.test(withoutSequences), "a stripped escape must not leave `33m`-style debris");
}

// ── dropped: anything that can move the layout ───────────────────────────────
//
// Cursor movement / erasure. Each removes the sequence and keeps the surrounding text, so a
// destructive payload degrades to plain text instead of corrupting the host's frame.
for (const [label, seq] of [
  ["cursor up", `${ESC}[2A`],
  ["cursor position", `${ESC}[10;20H`],
  ["erase display", `${ESC}[2J`],
  ["erase line", `${ESC}[K`],
  ["save cursor", `${ESC}[s`],
]) {
  assert.equal(sanitizeAnsi(`a${seq}b`), "ab", `dropped: ${label}`);
}

// OSC 8 hyperlinks (and the window-title form): dropped whole, including a truncated one that
// never receives its terminator.
assert.equal(sanitizeAnsi(`a${ESC}]8;;http://example.com${ESC}\\b`), "ab", "OSC 8 hyperlink dropped");
assert.equal(sanitizeAnsi(`a${ESC}]0;title\u0007b`), "ab", "OSC window title dropped");
assert.equal(sanitizeAnsi(`a${ESC}]8;;unterminated`), "a", "a truncated OSC swallows its tail");

// Two-character escapes are destructive too, and `[` must stay reserved for the CSI pass —
// otherwise this sweep would eat the sequences that pass above it deliberately kept.
assert.equal(sanitizeAnsi(`a${ESC}7b`), "ab", "ESC 7 (save cursor) dropped");
assert.equal(sanitizeAnsi(`a${ESC}cb`), "ab", "ESC c (reset) dropped");
assert.equal(sanitizeAnsi(`a${ESC}[b`), "a", "a bare/incomplete ESC[ is still removed");

// ── order-independence of the strip list ─────────────────────────────────────
//
// A destructive sequence sitting BETWEEN two kept ones must not take its neighbours with it.
{
  const out = sanitizeAnsi(`${ESC}[33mup${ESC}[2Athen${ESC}[0m`);
  assert.equal(out, `${ESC}[33mupthen${ESC}[0m`, "a dropped sequence leaves both kept neighbours intact");
}

// ── boundAnsiText: the sanitize + bound + reset triple ──────────────────────
//
// Every text an extension renders goes through this, so three properties have to hold. Each one is
// a shape that has already gone wrong or would be invisible until a user noticed:
//
//  1. the reset is appended UNCONDITIONALLY — a payload that forgets its trailing reset would
//     otherwise tint the footer rows below it and the shell prompt after exit;
//  2. the bound counts VISIBLE characters and never cuts inside a surrogate pair or an escape —
//     a UTF-16 slice could split `😀` or leave a bare `ESC[33` that the terminal swallows along
//     with the text after it;
//  3. sanitizing still happens, so a bounded payload cannot smuggle a cursor move past the gate.
{
  assert.equal(boundAnsiText("plain", 100), `plain${ANSI_RESET}`, "an unterminated payload gets a reset");
  assert.equal(
    boundAnsiText(`${ESC}[33mhi${ESC}[0m`, 100),
    `${ESC}[33mhi${ESC}[0m`,
    "an already-terminated payload is not double-reset"
  );
  assert.equal(boundAnsiText("ab😀cd", 3), `ab😀${ANSI_RESET}`, "the bound counts code points, not UTF-16 units");
  assert.equal(
    boundAnsiText(`${ESC}[33mabcdef`, 2),
    `${ESC}[33mab${ANSI_RESET}`,
    "an SGR is copied whole and never left half-written at the cut"
  );
  assert.equal(
    boundAnsiText(`${ESC}[38;5;208mx`, 1),
    `${ESC}[38;5;208mx${ANSI_RESET}`,
    "escapes do not consume the visible-character budget"
  );
  assert.equal(boundAnsiText(`a${ESC}[2Jb`, 100), `ab${ANSI_RESET}`, "a bounded payload is still sanitized");
  assert.equal(boundAnsiText("anything", 0), "", "a zero bound renders nothing at all");
  assert.equal(boundAnsiText("", 100), "", "empty stays empty (no stray reset line)");
}

console.log("extension-render-surface validation passed");
