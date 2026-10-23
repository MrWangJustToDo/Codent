/**
 * Geometry for the workspace panel's image preview.
 *
 * Kept out of the component because it is the one part of zooming that can be checked without a
 * terminal: an off-by-one window or a pan that walks off the image is invisible in a screenshot
 * until it is very visible, and a component file cannot be imported by the app's `node:test` suite.
 */

import type { CoreEnvImageRegion } from "@codent/core";

/**
 * Largest sample grid a host will render (`@codent/node` clamps to this).
 *
 * Not a taste ceiling — the pane is used in full below it. It has to be applied HERE as well,
 * because the window geometry is computed from these numbers: asking for 300 columns while the host
 * renders 200 would make the zoom window and the aspect correction describe a grid that does not
 * exist. On a terminal that wide the picture simply stops growing.
 */
export const MAX_PREVIEW_COLS = 200;

/**
 * Cells available to the picture: the pane's box minus the title row and a column of slack.
 *
 * No ceiling below the pane: an earlier 96×32 cap only ever bit on wide terminals, where it threw
 * away space the user had already given the panel.
 */
export function imagePreviewBudget(width: number, height: number | undefined): { maxCols: number; maxRows: number } {
  const maxCols = Math.min(MAX_PREVIEW_COLS, Math.max(8, Math.floor(width) - 2));
  const maxRows = Math.min(MAX_PREVIEW_COLS, Math.max(4, (height === undefined ? 48 : Math.floor(height)) - 1));
  return { maxCols, maxRows };
}

/**
 * The source window a zoom/pan state asks for, or `undefined` for "the whole image, fitted".
 *
 * `zoom` is a multiple of the fitted view: 2 means the cells cover half the image per axis. The
 * window is matched to the pane's aspect by cropping the longer side, so a zoomed-in view FILLS the
 * pane instead of sitting in blank margins — a margin is rows of nothing spent on a picture that is
 * already only partly visible.
 */
export function imageViewRegion(input: {
  imageWidth: number;
  imageHeight: number;
  maxCols: number;
  maxRows: number;
  zoom: number;
  panX: number;
  panY: number;
}): CoreEnvImageRegion | undefined {
  const { imageWidth, imageHeight, maxCols, maxRows, zoom, panX, panY } = input;
  if (zoom <= 1 || imageWidth <= 0 || imageHeight <= 0) return undefined;

  // Sample space is square: one cell is 1 sample wide and 2 tall.
  const paneAspect = maxCols / Math.max(1, maxRows * 2);
  let width = imageWidth / zoom;
  let height = imageHeight / zoom;
  if (width / height > paneAspect) width = height * paneAspect;
  else height = width / paneAspect;

  width = Math.min(imageWidth, Math.max(1, Math.round(width)));
  height = Math.min(imageHeight, Math.max(1, Math.round(height)));

  // `pan` is a position in [0, 1] over what is left to pan, so the window cannot leave the image.
  const x = Math.round((imageWidth - width) * clamp01(panX));
  const y = Math.round((imageHeight - height) * clamp01(panY));
  return { x, y, width, height };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

/**
 * How far one pan keypress moves the picture, as a fraction of the VISIBLE WINDOW.
 *
 * This is the whole point of computing a step instead of using a constant: the store's pan is a
 * position over the *pannable range* (`image - window`), and that range GROWS as the window shrinks.
 * A constant fraction of the range therefore moved further the deeper you zoomed — a press that
 * shifted ~25 cells at 2× shifted more than a whole pane at 8×.
 *
 * Sizing the step by the window keeps the on-screen rate constant: `window × fraction` source pixels
 * map to `maxCols × fraction` cells at every zoom, because the window is exactly what fills the pane.
 */
export const IMAGE_PAN_VIEWPORT_FRACTION = 0.1;

/**
 * The normalized pan delta for one keypress at the current zoom.
 *
 * Returned in the same [0, 1] space as the store's pan, so the caller adds it and clamps — no
 * geometry leaks into the key handler. Zero when there is nothing to pan along that axis (a window
 * that already spans the image), which is also what stops a press from moving a picture that cannot
 * move.
 */
export function imagePanStep(input: {
  imageWidth: number;
  imageHeight: number;
  maxCols: number;
  maxRows: number;
  zoom: number;
  fraction?: number;
}): { x: number; y: number } {
  const { imageWidth, imageHeight, maxCols, maxRows, zoom } = input;
  const fraction = input.fraction ?? IMAGE_PAN_VIEWPORT_FRACTION;
  const window = imageViewRegion({ imageWidth, imageHeight, maxCols, maxRows, zoom, panX: 0, panY: 0 });
  if (!window) return { x: 0, y: 0 };

  const rangeX = imageWidth - window.width;
  const rangeY = imageHeight - window.height;
  return {
    x: rangeX > 0 ? Math.min(1, (window.width * fraction) / rangeX) : 0,
    y: rangeY > 0 ? Math.min(1, (window.height * fraction) / rangeY) : 0,
  };
}
