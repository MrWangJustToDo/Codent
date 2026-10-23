/**
 * Validation: image → terminal text (`renderRgbaAsTerminalText`).
 *
 * This is the pure half of the workspace image preview: the host decodes to RGBA and this decides
 * the cells. The bug class it guards is silent layout damage — a line one cell too wide reflows the
 * preview pane, a non-SGR escape moves the cursor out from under the renderer, and an unbounded grid
 * turns a 6000×4000 screenshot into a full-screen paint.
 *
 * Pinned here:
 *   1. half-block pairing: upper pixel → foreground, lower pixel → background, `▀`;
 *   2. every line's VISIBLE width ≤ `maxCols` and the row count ≤ `maxRows`;
 *   3. only SGR escapes are emitted — never cursor movement, erasure, or OSC;
 *   4. aspect ratio is preserved and never upsampled past the source;
 *   5. the colorless path emits no escape at all, and its ramp is monotonic in luminance;
 *   6. transparent pixels produce neither a glyph nor a color;
 *   7. unusable input returns `[]` instead of throwing (the UI has no error state for this).
 *
 * Run: pnpm --filter @codent/core run validate:image-text
 */

import assert from "node:assert/strict";

import { renderRgbaAsTerminalText, TERMINAL_ASCII_RAMP } from "../dist/index.mjs";

const ESC = "\u001b";
/**
 * The SGR family only.
 *
 * Built with `new RegExp` rather than a literal because the pattern contains a control character by
 * definition (`no-control-regex`); the rule is there to catch accidental ones, not a deliberate
 * guard on the one escape family this renderer is allowed to emit.
 */
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

/** Visible cells in a rendered line: SGR removed, then counted as single-width glyphs. */
function visibleWidth(line) {
  const visible = line.replace(SGR, "");
  assert.ok(!visible.includes(ESC), `only SGR escapes may appear in a rendered line (got ${JSON.stringify(line)})`);
  return visible.length;
}

/** A `width × height` RGBA image whose pixels come from `pixel(x, y)`. */
function image(width, height, pixel) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      const offset = (y * width + x) * 4;
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = a;
    }
  }
  return { width, height, data };
}

const RED = [255, 0, 0, 255];
const GREEN = [0, 255, 0, 255];
const BLUE = [0, 0, 255, 255];
const CLEAR = [0, 0, 0, 0];

// ── 1. half-block pairing ────────────────────────────────────────────────────
//
// A 2×2 image: top row red/green, bottom row blue/white. Two sample pixels per cell means one
// output row, whose foreground is the upper pixel and background the lower one.
{
  const img = image(2, 2, (x, y) => (y === 0 ? (x === 0 ? RED : GREEN) : x === 0 ? BLUE : [255, 255, 255, 255]));
  const lines = renderRgbaAsTerminalText(img, { maxCols: 2, maxRows: 1, color: true });

  assert.equal(lines.length, 1, "one cell row covers two sample rows");
  assert.equal(visibleWidth(lines[0]), 2, "one glyph per sampled column");
  assert.ok(lines[0].includes(`${ESC}[38;2;255;0;0m`), "upper-left pixel is the foreground");
  assert.ok(lines[0].includes(`${ESC}[48;2;0;0;255m`), "lower-left pixel is the background");
  assert.ok(lines[0].includes("\u2580"), "the glyph is the upper half block");
}

// ── 2. bounds ────────────────────────────────────────────────────────────────
//
// A square source (which wants to be as wide as it is tall) against a box that is wider than it is
// tall: the ROW budget is what binds, so the width must follow it rather than fill the pane.
{
  const img = image(200, 200, () => RED);
  const lines = renderRgbaAsTerminalText(img, { maxCols: 96, maxRows: 16, color: true });

  assert.ok(lines.length <= 16, `row cap respected (got ${lines.length})`);
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= 96, `column cap respected (got ${visibleWidth(line)})`);
  }
  // Half blocks give two vertical pixels per row, so a square image is ~2 rows tall per row of width.
  assert.ok(visibleWidth(lines[0]) <= 32, "a square image in a 96×16 box is bound by the rows");
}

// ── 3. no escaping the SGR family ────────────────────────────────────────────
{
  const img = image(4, 4, (x, y) => [x * 60, y * 60, 128, 255]);
  for (const line of renderRgbaAsTerminalText(img, { maxCols: 4, maxRows: 2, color: true })) {
    assert.ok(!new RegExp(`${ESC}[^[]`).test(line), "two-character escapes must never appear");
    // `visibleWidth` strips SGR and then requires that no escape survives — which is exactly the
    // "only the SGR family is emitted" contract, including the final byte.
    visibleWidth(line);
  }
}

// ── 4. aspect ratio, and no upsampling ───────────────────────────────────────
{
  // 8×2 (4:1): fits on one cell row at full width.
  const wide = image(8, 2, () => RED);
  const wideLines = renderRgbaAsTerminalText(wide, { maxCols: 8, maxRows: 8, color: true });
  assert.equal(wideLines.length, 1, "a 4:1 image is one cell row tall");
  assert.equal(visibleWidth(wideLines[0]), 8, "and uses the full width");

  // 2×8 (1:4): a tall image is width-bound by its aspect, not by the pane.
  const tall = image(2, 8, () => RED);
  const tallLines = renderRgbaAsTerminalText(tall, { maxCols: 8, maxRows: 2, color: true });
  assert.equal(tallLines.length, 2, "a 1:4 image fills the row budget");
  assert.ok(visibleWidth(tallLines[0]) <= 1, "and stays one column wide instead of stretching");

  // A 16×16 icon must not be blown up: 30 copies of every pixel read as noise.
  const icon = image(16, 16, () => RED);
  const iconLines = renderRgbaAsTerminalText(icon, { maxCols: 96, maxRows: 32, color: true });
  assert.equal(visibleWidth(iconLines[0]), 16, "upsampling is capped at one sample per source pixel");
  assert.equal(iconLines.length, 8, "16 sample rows = 8 cell rows");
}

// ── 5. colorless path ────────────────────────────────────────────────────────
{
  const img = image(10, 6, (x) => {
    const level = Math.round((x / 9) * 255);
    return [level, level, level, 255];
  });
  const lines = renderRgbaAsTerminalText(img, { maxCols: 10, maxRows: 6, color: false });

  assert.ok(lines.length > 0, "the colorless path renders");
  for (const line of lines) {
    assert.ok(!line.includes("\u001b"), "no escape at all when color is off");
    assert.ok(visibleWidth(line) <= 10, "column cap respected");
    for (const char of line) {
      assert.ok(TERMINAL_ASCII_RAMP.includes(char), `only ramp glyphs (got ${JSON.stringify(char)})`);
    }
  }

  // Monotonic in luminance: the ramp index must grow with brightness, so a dark and a bright image
  // never land on the same glyph. Compared by index, not by string, or "the glyph changed" would
  // pass for a ramp that is out of order.
  const stepAt = (level) => {
    const [line = ""] = renderRgbaAsTerminalText(
      image(1, 2, () => [level, level, level, 255]),
      {
        maxCols: 1,
        maxRows: 1,
        color: false,
      }
    );
    return TERMINAL_ASCII_RAMP.indexOf(line === "" ? TERMINAL_ASCII_RAMP[0] : line);
  };
  assert.equal(stepAt(0), 0, "black is the darkest glyph");
  assert.ok(stepAt(128) > stepAt(0), "mid grey is brighter than black");
  assert.equal(stepAt(255), TERMINAL_ASCII_RAMP.length - 1, "white is the brightest glyph");
}

// ── 6. transparency ──────────────────────────────────────────────────────────
{
  const img = image(2, 2, () => CLEAR);
  const lines = renderRgbaAsTerminalText(img, { maxCols: 2, maxRows: 1, color: true });
  assert.equal(lines.length, 1, "the row still exists");
  assert.equal(lines[0], "", "fully transparent cells carry no glyph and no color");
}

// ── 7. unusable input ────────────────────────────────────────────────────────
{
  assert.deepEqual(
    renderRgbaAsTerminalText(
      image(2, 2, () => RED),
      { maxCols: 0, maxRows: 4 }
    ),
    []
  );
  assert.deepEqual(
    renderRgbaAsTerminalText(
      image(2, 2, () => RED),
      { maxCols: 4, maxRows: 0 }
    ),
    []
  );
  assert.deepEqual(
    renderRgbaAsTerminalText({ width: 0, height: 0, data: new Uint8Array(0) }, { maxCols: 4, maxRows: 4 }),
    []
  );
  assert.deepEqual(
    renderRgbaAsTerminalText({ width: 4, height: 4, data: new Uint8Array(4) }, { maxCols: 4, maxRows: 4 }),
    [],
    "a buffer shorter than the declared grid is refused, not read out of bounds"
  );

  // Hostile dimensions are capped, not honoured: cost is quadratic in columns.
  const capped = renderRgbaAsTerminalText(
    image(1000, 1000, () => RED),
    { maxCols: 5000, maxRows: 5000 }
  );
  assert.ok(capped.length <= 200, "row dimension is capped");
  for (const line of capped) assert.ok(visibleWidth(line) <= 200, "column dimension is capped");
}

console.log("validate:image-text — ok");
