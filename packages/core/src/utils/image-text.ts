/**
 * Image → terminal text — the one definition.
 *
 * The workspace preview pane can only draw text, so an image is rendered as rows of half-block
 * glyphs: foreground = the upper pixel, background = the lower one. That doubles the vertical
 * resolution per cell, which is exactly what cancels a terminal cell's 1:2 (width:height) aspect —
 * a square-pixel sample grid then displays square.
 *
 * Why the conversion is a pure function here instead of inside the host that decodes: the host owns
 * only what is platform-specific (sharp / a browser codec), so every host renders the same image the
 * same way, and a validator can assert the glyph algebra directly. The host calls this after
 * decoding + downsampling; see `CoreEnv.imageToText`.
 *
 * Output is plain text plus SGR color only — never cursor movement, erasure, or OSC. A renderer owns
 * the screen; an image must not position anything.
 */

/** A decoded image: RGBA bytes, `width * height * 4`, row-major. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface TerminalImageOptions {
  /** Maximum width in terminal cells. */
  maxCols: number;
  /** Maximum height in terminal rows. */
  maxRows: number;
  /** 24-bit color half-blocks when true (default); a colorless ASCII ramp when false. */
  color?: boolean;
}

/** Darkest → brightest, for the colorless path. */
export const TERMINAL_ASCII_RAMP = " .:-=+*#%@";

/**
 * Sanity ceiling per dimension.
 *
 * The panel never asks for more than ~96×32; anything beyond this is a caller bug or a hostile one,
 * and the cost of honouring it is quadratic (samples, SGR bytes, and layout rows).
 */
const MAX_DIMENSION = 200;

/** Below this the pixel counts as absent, so it neither colors a cell nor earns a glyph. */
const ALPHA_CUTOFF = 128;

const SGR_RESET = "\u001b[0m";

/**
 * Render an RGBA image as terminal rows.
 *
 * Returns at most `maxRows` lines, each with a visible width of at most `maxCols` cells. Empty array
 * for an unusable input (zero/negative dimensions, a buffer shorter than the declared grid); never
 * throws.
 */
export function renderRgbaAsTerminalText(image: RgbaImage, options: TerminalImageOptions): string[] {
  const maxCols = dimension(options.maxCols);
  const maxRows = dimension(options.maxRows);
  if (maxCols === 0 || maxRows === 0) return [];

  const { width, height, data } = image;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return [];
  if (data.length < width * height * 4) return [];

  const color = options.color !== false;

  // A cell is two square pixels tall, so the box the image has to fit into is
  // `maxCols × maxRows * 2` in square-pixel space. Fitting there and then halving the sample rows
  // for the colorless path is the same constraint in both modes — the only difference is how many
  // pixels one cell covers.
  const fit = fitInside(width, height, maxCols, maxRows * 2);
  const sampleRows = color ? fit.height : Math.max(1, Math.ceil(fit.height / 2));
  const samples = sampleBox(image, fit.width, sampleRows);

  return color ? renderHalfBlocks(samples) : renderAscii(samples);
}

// ============================================================================
// Geometry
// ============================================================================

/** Floor a caller dimension into `[0, MAX_DIMENSION]`; non-finite/negative become 0. */
function dimension(value: number): number {
  if (!Number.isFinite(value) || value < 1) return 0;
  return Math.min(MAX_DIMENSION, Math.floor(value));
}

/**
 * Largest grid that keeps the image's aspect ratio inside `boxW × boxH`, at least 1×1.
 *
 * Never samples finer than the source: a 16×16 favicon blown up to 96 columns is 30 copies of
 * every pixel, and reads as noise rather than as the icon. Upscaling is capped at 1 sample per
 * source pixel.
 *
 * `Math.round` on both axes can overshoot by a pixel, so each is clamped back into the box — the
 * contract is "at most", and a preview one cell too wide would reflow in the pane.
 */
function fitInside(imageW: number, imageH: number, boxW: number, boxH: number) {
  const scale = Math.min(boxW / imageW, boxH / imageH, 1);
  return {
    width: Math.min(boxW, Math.max(1, Math.round(imageW * scale))),
    height: Math.min(boxH, Math.max(1, Math.round(imageH * scale))),
  };
}

// ============================================================================
// Sampling
// ============================================================================

/** Averaged samples: `width * height` pixels of RGBA. */
interface SampleGrid {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/**
 * Box-filter the image down to `outW × outH`.
 *
 * Averaging rather than point-sampling is what makes a photo recognizable at 96 columns: nearest
 * neighbour at that ratio drops whole rows and columns, and the result reads as noise. Color is
 * averaged weighted by alpha so a transparent edge does not drag the visible pixels toward black.
 */
function sampleBox(image: RgbaImage, outW: number, outH: number): SampleGrid {
  const { width, height, data } = image;
  const out = new Uint8Array(outW * outH * 4);

  for (let oy = 0; oy < outH; oy++) {
    const y0 = Math.floor((oy * height) / outH);
    const y1 = Math.max(y0 + 1, Math.floor(((oy + 1) * height) / outH));

    for (let ox = 0; ox < outW; ox++) {
      const x0 = Math.floor((ox * width) / outW);
      const x1 = Math.max(x0 + 1, Math.floor(((ox + 1) * width) / outW));

      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let aSum = 0;
      let aWeight = 0;

      for (let y = y0; y < y1 && y < height; y++) {
        let index = (y * width + x0) * 4;
        for (let x = x0; x < x1 && x < width; x++, index += 4) {
          const alpha = data[index + 3];
          aSum += alpha;
          aWeight += alpha;
          // Weight by alpha: an opaque pixel and a nearly-invisible one are not equally
          // informative about the cell's color.
          rSum += data[index] * alpha;
          gSum += data[index + 1] * alpha;
          bSum += data[index + 2] * alpha;
        }
      }

      const count = Math.max(1, (y1 - y0) * (x1 - x0));
      const offset = (oy * outW + ox) * 4;
      if (aWeight > 0) {
        out[offset] = Math.round(rSum / aWeight);
        out[offset + 1] = Math.round(gSum / aWeight);
        out[offset + 2] = Math.round(bSum / aWeight);
      }
      out[offset + 3] = Math.round(aSum / count);
    }
  }

  return { width: outW, height: outH, rgba: out };
}

function pixelAt(grid: SampleGrid, x: number, y: number): { r: number; g: number; b: number; a: number } | null {
  if (y < 0 || y >= grid.height || x < 0 || x >= grid.width) return null;
  const offset = (y * grid.width + x) * 4;
  return {
    r: grid.rgba[offset],
    g: grid.rgba[offset + 1],
    b: grid.rgba[offset + 2],
    a: grid.rgba[offset + 3],
  };
}

function visible(pixel: { a: number } | null): boolean {
  return pixel !== null && pixel.a >= ALPHA_CUTOFF;
}

// ============================================================================
// Rendering
// ============================================================================

/** Upper half block: foreground = upper pixel. Lower half block: foreground = lower pixel. */
const UPPER_HALF = "\u2580";
const LOWER_HALF = "\u2584";

/**
 * Half-block rows: one cell per two samples.
 *
 * SGR is emitted only when a cell's foreground/background differs from the previous cell's, and a
 * line always closes with a reset — a run of identical pixels (a photo's sky) costs one sequence
 * instead of one per cell.
 */
function renderHalfBlocks(grid: SampleGrid): string[] {
  const lines: string[] = [];
  const rows = Math.ceil(grid.height / 2);

  for (let row = 0; row < rows; row++) {
    const topRow = row * 2;
    const bottomRow = topRow + 1;

    let line = "";
    let fg = "";
    let bg = "";

    for (let x = 0; x < grid.width; x++) {
      const top = pixelAt(grid, x, topRow);
      const bottom = pixelAt(grid, x, bottomRow);

      const topVisible = visible(top);
      const bottomVisible = visible(bottom);

      let nextFg = "";
      let nextBg = "";
      let glyph = " ";

      if (topVisible && bottomVisible) {
        nextFg = colorCode(38, top!);
        nextBg = colorCode(48, bottom!);
        glyph = UPPER_HALF;
      } else if (topVisible) {
        nextFg = colorCode(38, top!);
        glyph = UPPER_HALF;
      } else if (bottomVisible) {
        // Only the lower pixel is there: draw it as a lower half block in the foreground. A
        // background-colored space would work too, but it bleeds into the pane's own background
        // when the terminal paints a cell wider than the glyph.
        nextFg = colorCode(38, bottom!);
        glyph = LOWER_HALF;
      }

      if (nextFg !== fg) {
        if (nextFg) line += nextFg;
        else line += "\u001b[39m";
        fg = nextFg;
      }
      if (nextBg !== bg) {
        if (nextBg) line += nextBg;
        else line += "\u001b[49m";
        bg = nextBg;
      }

      line += glyph;
    }

    lines.push(trimTrailingSpaces(fg || bg ? `${line}${SGR_RESET}` : line));
  }

  return lines;
}

function colorCode(kind: 38 | 48, pixel: { r: number; g: number; b: number }): string {
  return `\u001b[${kind};2;${pixel.r};${pixel.g};${pixel.b}m`;
}

/**
 * Colorless rows: one cell per sample, brightness → ramp.
 *
 * The renderer measures by visible width, so the ramp index has to be the *character*; anything
 * wider than one cell (or a sequence) would break the pane's column math.
 */
function renderAscii(grid: SampleGrid): string[] {
  const lines: string[] = [];
  const ramp = TERMINAL_ASCII_RAMP;

  for (let y = 0; y < grid.height; y++) {
    let line = "";
    for (let x = 0; x < grid.width; x++) {
      const pixel = pixelAt(grid, x, y);
      if (!visible(pixel)) {
        line += " ";
        continue;
      }
      // Rec. 601 luma: the weights the eye actually applies, so a red and a green of equal RGB
      // do not land on the same ramp step.
      const luma = 0.299 * pixel!.r + 0.587 * pixel!.g + 0.114 * pixel!.b;
      const step = Math.min(ramp.length - 1, Math.max(0, Math.round((luma / 255) * (ramp.length - 1))));
      line += ramp[step];
    }
    lines.push(trimTrailingSpaces(line));
  }

  return lines;
}

/** Trailing spaces carry no pixels; dropping them keeps every line's width honest and short. */
function trimTrailingSpaces(line: string): string {
  let end = line.length;
  while (end > 0 && line[end - 1] === " ") end--;
  return end === line.length ? line : line.slice(0, end);
}
