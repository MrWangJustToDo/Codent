/**
 * Validation: the zoom/pan geometry of the workspace image preview.
 *
 * Zooming is the only part of the preview that cannot be judged from a rendered frame — the render is
 * just cells, and a window that is 4 pixels off, or a pan that walks past the image edge, looks like
 * a slightly different picture. So the two properties that matter are pinned here:
 *
 *   1. **The window never leaves the image.** The host clamps too, but the client's own request has
 *      to be legal, or every pan at the edge would silently slide the picture back.
 *   2. **A zoomed-in window fills the pane.** Its aspect is the pane's cell aspect, because a window
 *      that does not match renders into blank margins — rows of nothing spent on a picture that is
 *      already only partly visible.
 *
 * Run: node packages/app/test/image-viewport.test.mjs
 */
import assert from "node:assert/strict";

import { IMAGE_PAN_VIEWPORT_FRACTION, imagePanStep, imagePreviewBudget, imageViewRegion } from "../dist/index.mjs";

const IMAGE = { imageWidth: 2172, imageHeight: 1282 };
const PANE = { maxCols: 77, maxRows: 30 };

// ── 1× is "no window": the whole image, fitted ───────────────────────────────
{
  const region = imageViewRegion({ ...IMAGE, ...PANE, zoom: 1, panX: 0.5, panY: 0.5 });
  assert.equal(region, undefined, "at 1× the host fits the whole image; there is no window to send");
}

// ── zoom shrinks the window by the zoom factor ───────────────────────────────
{
  const wide = imageViewRegion({ ...IMAGE, ...PANE, zoom: 2, panX: 0.5, panY: 0.5 });
  const deeper = imageViewRegion({ ...IMAGE, ...PANE, zoom: 4, panX: 0.5, panY: 0.5 });
  assert.ok(wide && deeper);
  assert.ok(deeper.width < wide.width, "a deeper zoom shows less of the image");
  assert.ok(
    Math.abs(wide.width / deeper.width - 2) < 0.05,
    `doubling the zoom halves the window (got ${wide.width} → ${deeper.width})`
  );
}

// ── a zoomed window matches the pane's cell aspect ───────────────────────────
{
  const region = imageViewRegion({ ...IMAGE, ...PANE, zoom: 3, panX: 0.5, panY: 0.5 });
  assert.ok(region);
  // One cell is 1 sample wide and 2 tall.
  const paneAspect = PANE.maxCols / (PANE.maxRows * 2);
  const regionAspect = region.width / region.height;
  assert.ok(
    Math.abs(regionAspect - paneAspect) < 0.01,
    `window aspect ${regionAspect.toFixed(3)} matches pane aspect ${paneAspect.toFixed(3)}`
  );
}

// ── the window never leaves the image ───────────────────────────────────────
{
  for (const pan of [0, 0.5, 1, -5, 42, Number.NaN]) {
    for (const zoom of [1.5, 2, 4, 8]) {
      const region = imageViewRegion({ ...IMAGE, ...PANE, zoom, panX: pan, panY: pan });
      assert.ok(region, "a zoom above 1 always yields a window");
      assert.ok(region.x >= 0 && region.y >= 0, `panned ${pan}: origin stays inside the image`);
      assert.ok(
        region.x + region.width <= IMAGE.imageWidth && region.y + region.height <= IMAGE.imageHeight,
        `panned ${pan} at ${zoom}×: the window stays inside the image`
      );
    }
  }
}

// ── pan moves the window, and only in a meaningful direction ────────────────
{
  const left = imageViewRegion({ ...IMAGE, ...PANE, zoom: 4, panX: 0, panY: 0.5 });
  const centre = imageViewRegion({ ...IMAGE, ...PANE, zoom: 4, panX: 0.5, panY: 0.5 });
  const right = imageViewRegion({ ...IMAGE, ...PANE, zoom: 4, panX: 1, panY: 0.5 });
  assert.ok(left && centre && right);
  assert.equal(left.x, 0, "pan 0 is the left edge");
  assert.ok(centre.x > left.x && right.x > centre.x, "pan increases x");
  assert.equal(right.x + right.width, IMAGE.imageWidth, "pan 1 is the right edge");
  assert.equal(left.y, centre.y, "x panning does not move the window vertically");
}

// ── a degenerate image or pane cannot produce a broken window ───────────────
{
  assert.equal(imageViewRegion({ imageWidth: 0, imageHeight: 0, ...PANE, zoom: 4, panX: 0.5, panY: 0.5 }), undefined);
  const tiny = imageViewRegion({ imageWidth: 24, imageHeight: 16, ...PANE, zoom: 8, panX: 0.5, panY: 0.5 });
  assert.ok(tiny);
  assert.ok(tiny.width >= 1 && tiny.height >= 1, "a window is never zero-sized");
  assert.ok(tiny.width <= 24 && tiny.height <= 16, "and never larger than the image");
}

// ── panning moves the same number of CELLS at every zoom ────────────────────
// The reported bug: a press moved a fixed fraction of the *remaining* range, and that range grows as
// the window shrinks — so ~25 cells per press at 2× became more than a whole pane at 8×. The step is
// now sized by the visible window, which is what makes the on-screen rate independent of the zoom.
{
  const cellsPerPress = (zoom, axis = "x") => {
    const window = imageViewRegion({ ...IMAGE, ...PANE, zoom, panX: 0, panY: 0 });
    assert.ok(window);
    const step = imagePanStep({ ...IMAGE, ...PANE, zoom });
    if (axis === "x") {
      return (step.x * (IMAGE.imageWidth - window.width) * PANE.maxCols) / window.width;
    }
    return (step.y * (IMAGE.imageHeight - window.height) * PANE.maxRows) / window.height;
  };

  const expectedX = PANE.maxCols * IMAGE_PAN_VIEWPORT_FRACTION;
  const expectedY = PANE.maxRows * IMAGE_PAN_VIEWPORT_FRACTION;
  for (const zoom of [1.5, 2, 3, 4, 6, 8]) {
    const x = cellsPerPress(zoom);
    const y = cellsPerPress(zoom, "y");
    assert.ok(
      Math.abs(x - expectedX) <= 1,
      `zoom ${zoom}: one press moves ~${expectedX.toFixed(1)} columns on screen (got ${x.toFixed(1)})`
    );
    assert.ok(
      Math.abs(y - expectedY) <= 1,
      `zoom ${zoom}: one press moves ~${expectedY.toFixed(1)} rows on screen (got ${y.toFixed(1)})`
    );
  }

  // In normalized terms the step therefore SHRINKS with zoom — the old constant did the opposite in
  // screen terms, which is what made deep zoom feel like teleporting.
  const shallow = imagePanStep({ ...IMAGE, ...PANE, zoom: 2 });
  const deep = imagePanStep({ ...IMAGE, ...PANE, zoom: 8 });
  assert.ok(
    deep.x < shallow.x,
    `the normalized step shrinks with zoom (${shallow.x.toFixed(4)} → ${deep.x.toFixed(4)}`
  );
  assert.ok(deep.x > 0 && deep.y > 0, "panning is still possible at the deepest zoom");
}

// ── the step never overshoots the whole range ───────────────────────────────
{
  assert.deepEqual(imagePanStep({ ...IMAGE, ...PANE, zoom: 1 }), { x: 0, y: 0 }, "at 1× there is nothing to pan");

  // A window that is nearly the whole image leaves almost no range; the step is capped at 1 so one
  // press can never ask for more than the entire range (the store clamps, but a >1 step would make
  // the clamp do the work and hide a bad number).
  for (const image of [
    { imageWidth: 2172, imageHeight: 1282 },
    { imageWidth: 100, imageHeight: 4000 },
    { imageWidth: 4000, imageHeight: 100 },
    { imageWidth: 40, imageHeight: 30 },
  ]) {
    for (const zoom of [1.5, 2, 4, 8]) {
      const step = imagePanStep({ ...image, ...PANE, zoom });
      assert.ok(step.x >= 0 && step.x <= 1, `${JSON.stringify(image)} at ${zoom}×: x step within range`);
      assert.ok(step.y >= 0 && step.y <= 1, `${JSON.stringify(image)} at ${zoom}×: y step within range`);
    }
  }
}

// ── the pane's own space is used, with no ceiling below it ──────────────────
{
  assert.deepEqual(imagePreviewBudget(130, 45), { maxCols: 128, maxRows: 44 });
  assert.deepEqual(imagePreviewBudget(30, 12), { maxCols: 28, maxRows: 11 });
  assert.deepEqual(imagePreviewBudget(2, 2), { maxCols: 8, maxRows: 4 }, "the floors still hold");
  assert.deepEqual(imagePreviewBudget(80, undefined), { maxCols: 78, maxRows: 47 }, "no height = a tall pane");
  // The host renders at most 200 cells; asking for more would make the zoom window describe a grid
  // that does not exist, so the budget stops there rather than trusting the host to trim it.
  assert.deepEqual(imagePreviewBudget(400, 300), { maxCols: 200, maxRows: 200 }, "capped at the host's grid");
}

console.log("image-viewport — ok");
