/**
 * Validation: the Node host's `imageToText` capability.
 *
 * `renderRgbaAsTerminalText` is pinned by `validate:image-text` (core); what this covers is the
 * binding around it — that `@codent/node` actually implements the optional CoreEnv member, that it
 * decodes with `sharp`, that the result obeys the caller's cell budget, that it reports the source
 * size and the window it rendered (a zoom/pan client has nothing else to compute against), and that
 * every failure mode comes back as `null` rather than as a throw. The UI has no error state for a
 * preview: a rejected promise there reads as a crashed pane, so "degrade to null" is the contract
 * worth pinning.
 *
 * The last block is the sharpening check from the spec: the unsharp after downscaling must not
 * change the grid (row/column count) while it does raise edge contrast. It re-derives the plain
 * (unsharpened) grid here with `sharp` + core's renderer, so the comparison is against the pipeline
 * this host would have had without step, not against a remembered number.
 *
 * Run: pnpm --filter @codent/node run validate:image-to-text
 */

import { renderRgbaAsTerminalText } from "@codent/core";
import assert from "node:assert/strict";
import * as os from "node:os";
import sharp from "sharp";

import { createNodeEnv } from "../dist/index.mjs";

/**
 * 8×2 PNG: top row pure red, bottom row pure blue.
 *
 * Deliberately flat in both directions: `sharp`'s downsampling kernel blends neighbours, so a
 * fixture with gradients could not pin "upper pixel is the foreground" to an exact color. At 1:1
 * there is nothing to blend.
 */
const SPLIT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAACCAIAAADq9gq6AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWP4z8CAFTHgEP8PAI6xD/GRc0rlAAAAAElFTkSuQmCC",
  "base64"
);

const ESC = "\u001b";
// Built with `new RegExp`: a control character in a regex literal trips `no-control-regex`, which
// exists to catch accidental ones rather than this deliberate guard on the one allowed family.
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const visibleWidth = (line) => line.replace(SGR, "").length;

/** Every channel of an SGR family, in order: `38;2;r;g;b` (fg) or `48;2;r;g;b` (bg). */
const channels = (line, base) => {
  const pattern = new RegExp(`${ESC}\\[${base};2;(\\d+);(\\d+);(\\d+)m`, "g");
  return [...line.matchAll(pattern)].map((match) => Number(match[1]) + Number(match[2]) + Number(match[3]));
};

/**
 * Mean |Δ| between neighbouring sample pairs: higher means crisper.
 *
 * Derived line by line from the rendered rows instead of from a flat grid, because the renderer trims
 * trailing cells on a row whose last pixels carry no information — a ragged tail would index past the
 * end of a flattened array and quietly turn the whole average into NaN.
 */
function edgeEnergy(rows) {
  let sum = 0;
  let count = 0;
  for (const line of rows) {
    const fg = channels(line, 38);
    const bg = channels(line, 48);
    for (let i = 0; i < fg.length; i++) {
      // Horizontal neighbour in the upper pixel row…
      if (i + 1 < fg.length) {
        sum += Math.abs(fg[i + 1] - fg[i]);
        count++;
      }
      // …and the vertical pair the half block itself carries.
      if (i < bg.length) {
        sum += Math.abs(bg[i] - fg[i]);
        count++;
      }
    }
  }
  return count === 0 ? 0 : sum / count;
}

/** A 64×64 checkerboard, 8-pixel squares: hard edges at every scale the preview sees. */
async function checkerboardPng() {
  const size = 64;
  const cell = 8;
  const raw = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const on = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0;
      const value = on ? 240 : 16;
      const offset = (y * size + x) * 4;
      raw[offset] = value;
      raw[offset + 1] = value;
      raw[offset + 2] = value;
      raw[offset + 3] = 255;
    }
  }
  return sharp(raw, { raw: { width: size, height: size, channels: 4 } })
    .png()
    .toBuffer();
}

const env = createNodeEnv({ rootPath: os.tmpdir() });

assert.equal(typeof env.imageToText, "function", "the Node host MUST expose imageToText");

// ── the capability renders, and pairs the two sample rows ───────────────────
{
  const result = await env.imageToText(new Uint8Array(SPLIT_PNG), { maxCols: 8, maxRows: 2, color: true });

  assert.ok(result, "a valid PNG must render (not null)");
  const { rows } = result;
  assert.ok(Array.isArray(rows), "rows are the rendering");
  assert.equal(rows.length, 1, "two sample rows are one cell row");
  assert.equal(visibleWidth(rows[0]), 8, "an 8:2 image fits eight cells of width");
  assert.ok(rows[0].includes("\u2580"), "rendered with the upper half block");
  assert.ok(!rows[0].replace(SGR, "").includes(ESC), "only SGR escapes are emitted");
  assert.ok(rows[0].includes(`${ESC}[38;2;255;0;0m`), "the red row is the foreground");
  assert.ok(rows[0].includes(`${ESC}[48;2;0;0;255m`), "the blue row is the background");

  // The reported geometry is what a zoom/pan client computes its window against.
  assert.equal(result.imageWidth, 8, "the source width is reported");
  assert.equal(result.imageHeight, 2, "the source height is reported");
  assert.deepEqual(result.region, { x: 0, y: 0, width: 8, height: 2 }, "the whole image is the default window");
}

// ── the caller's column budget narrows the image, not the aspect ────────────
{
  const { rows } = await env.imageToText(new Uint8Array(SPLIT_PNG), { maxCols: 4, maxRows: 2, color: true });
  for (const line of rows) {
    assert.ok(visibleWidth(line) <= 4, `column budget respected (got ${visibleWidth(line)})`);
  }
}

// ── colorless mode emits no escape ──────────────────────────────────────────
{
  const { rows } = await env.imageToText(new Uint8Array(SPLIT_PNG), { maxCols: 8, maxRows: 2, color: false });
  assert.ok(rows.length === 1, "the colorless path still renders");
  for (const line of rows) assert.ok(!line.includes("\u001b"), "no SGR when color is off");
}

// ── a pane-sized request keeps the row budget ───────────────────────────────
{
  const { rows } = await env.imageToText(new Uint8Array(SPLIT_PNG), { maxCols: 96, maxRows: 32 });
  assert.ok(rows.length <= 32, `row budget respected (got ${rows.length})`);
  for (const line of rows) assert.ok(visibleWidth(line) <= 96, "column budget respected");
}

// ── a region renders that window, and larger cells mean upsampling ──────────
{
  const png = await checkerboardPng();
  const half = await env.imageToText(new Uint8Array(png), {
    maxCols: 32,
    maxRows: 16,
    color: true,
    region: { x: 32, y: 0, width: 32, height: 32 },
  });
  assert.ok(half, "a window renders");
  assert.equal(half.imageWidth, 64, "the source size is reported even for a window");
  assert.deepEqual(half.region, { x: 32, y: 0, width: 32, height: 32 }, "the requested window is echoed back");
  assert.ok(half.rows.length > 0 && half.rows.length <= 16, "the window obeys the row budget");

  // A window far smaller than the cell grid is the zoom case: it must be enlarged to fill, or
  // zooming in would show a postage stamp in the corner instead of detail.
  const zoomed = await env.imageToText(new Uint8Array(png), {
    maxCols: 40,
    maxRows: 20,
    color: true,
    region: { x: 8, y: 8, width: 4, height: 4 },
  });
  assert.ok(zoomed, "a tiny window renders");
  assert.ok(zoomed.rows.length > 2, `a 4×4 window is upsampled past its own height (got ${zoomed.rows.length} rows)`);
  assert.ok(visibleWidth(zoomed.rows[0]) > 4, "and past its own width");
}

// ── an out-of-bounds window is clamped, not rejected ────────────────────────
{
  const png = await checkerboardPng();
  const result = await env.imageToText(new Uint8Array(png), {
    maxCols: 16,
    maxRows: 8,
    region: { x: 60, y: -40, width: 200, height: 200 },
  });
  assert.ok(result, "an impossible window still renders");
  assert.deepEqual(
    result.region,
    { x: 0, y: 0, width: 64, height: 64 },
    "the window is clamped into the image and the clamped value is reported"
  );
}

// ── a non-finite window is clamped, not thrown ──────────────────────────────
// `Math.floor(NaN)` is NaN, and sharp REJECTS a non-integer `left` by throwing — so a client that
// computes a NaN rectangle would have turned "clamp the window" into "this image cannot be previewed".
{
  const png = await checkerboardPng();
  for (const [label, region] of [
    ["NaN origin", { x: Number.NaN, y: Number.NaN, width: 32, height: 32 }],
    ["Infinity size", { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: Number.POSITIVE_INFINITY }],
    ["zero size", { x: 0, y: 0, width: 0, height: 0 }],
    ["negative", { x: -50, y: -50, width: -10, height: -10 }],
    ["fractional", { x: 1.7, y: 2.4, width: 8.9, height: 9.1 }],
  ]) {
    const result = await env.imageToText(new Uint8Array(png), { maxCols: 16, maxRows: 8, region });
    assert.ok(result, `${label}: a garbage window still renders instead of degrading to null`);
    const { region: used } = result;
    assert.ok(
      Number.isInteger(used.x) &&
        Number.isInteger(used.y) &&
        Number.isInteger(used.width) &&
        Number.isInteger(used.height),
      `${label}: the reported window is whole pixels (${JSON.stringify(used)})`
    );
    assert.ok(
      used.x >= 0 && used.y >= 0 && used.width >= 1 && used.height >= 1,
      `${label}: the window is legal (${JSON.stringify(used)})`
    );
    assert.ok(
      used.x + used.width <= result.imageWidth && used.y + used.height <= result.imageHeight,
      `${label}: and stays inside the image`
    );
  }
}

// ── EXIF orientation is resolved before the window is interpreted ───────────
// The window arrives in the coordinates of what the user SEES, so `imageWidth`/`imageHeight` and the
// pixels extracted must both be post-rotation. A mismatch here is invisible in a small test image and
// shows up as a preview of the wrong corner for every phone photo.
{
  const source = await sharp({
    create: { width: 40, height: 20, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
  })
    .png()
    .toBuffer();
  // Orientation 6 = rotate 90° clockwise: the stored image is 40×20, the displayed one 20×40.
  const rotated = await sharp(source).withMetadata({ orientation: 6 }).jpeg().toBuffer();

  const fit = await env.imageToText(new Uint8Array(rotated), { maxCols: 8, maxRows: 8, color: true });
  assert.ok(fit, "an EXIF-rotated JPEG previews");
  assert.equal(fit.imageWidth, 20, "the reported width is the DISPLAYED (rotated) one");
  assert.equal(fit.imageHeight, 40, "the reported height is the DISPLAYED (rotated) one");
  assert.deepEqual(fit.region, { x: 0, y: 0, width: 20, height: 40 }, "and so is the fitted window");

  // A window in displayed coordinates must be extractable: if extraction ran before rotation, this
  // would either throw (width > stored image) or return the wrong pixels.
  const band = await env.imageToText(new Uint8Array(rotated), {
    maxCols: 4,
    maxRows: 4,
    color: true,
    region: { x: 0, y: 20, width: 20, height: 20 },
  });
  assert.ok(band, "a window expressed in displayed coordinates renders");
  assert.deepEqual(band.region, { x: 0, y: 20, width: 20, height: 20 }, "and is not clamped away");
}

// ── sharpening raises edge contrast without changing the grid ───────────────
{
  const png = await checkerboardPng();
  const budget = { maxCols: 32, maxRows: 16 };
  const { rows } = await env.imageToText(new Uint8Array(png), { ...budget, color: true });

  // The same pipeline without the unsharp, derived here rather than remembered.
  const plain = await sharp(png)
    .resize({ width: budget.maxCols, height: budget.maxRows * 2, fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const plainRows = renderRgbaAsTerminalText(
    { width: plain.info.width, height: plain.info.height, data: plain.data },
    budget
  );

  assert.equal(rows.length, plainRows.length, "sharpening must not change the row count");
  assert.equal(visibleWidth(rows[0]), visibleWidth(plainRows[0]), "nor the column count");

  const sharpenedEnergy = edgeEnergy(rows);
  const plainEnergy = edgeEnergy(plainRows);
  assert.ok(
    sharpenedEnergy > plainEnergy,
    `the sharpened render has more edge contrast (${sharpenedEnergy.toFixed(2)} > ${plainEnergy.toFixed(2)})`
  );
}

// ── failures degrade to null ────────────────────────────────────────────────
{
  const notAnImage = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]);
  assert.equal(
    await env.imageToText(notAnImage, { maxCols: 8, maxRows: 4 }),
    null,
    "undecodable bytes return null instead of throwing"
  );

  assert.equal(
    await env.imageToText(new Uint8Array(0), { maxCols: 8, maxRows: 4 }),
    null,
    "an empty buffer returns null instead of throwing"
  );

  // Untrusted dimensions from the UI must not reach sharp as 0 (it throws) — they are clamped, so
  // this is either a render or a clean `null`, never a rejection.
  const clamped = await env.imageToText(new Uint8Array(SPLIT_PNG), { maxCols: 0, maxRows: 0 });
  assert.ok(clamped === null || Array.isArray(clamped.rows), "zero dimensions degrade without throwing");
}

console.log("validate:image-to-text — ok");
