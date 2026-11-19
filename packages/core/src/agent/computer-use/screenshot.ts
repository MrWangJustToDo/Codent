/**
 * Turning a screen capture into (a) something the model can see and (b) one line the user can read.
 *
 * Two budgets are applied here, and both matter more than they look:
 *
 * - **The image is resized** through `CoreEnv.resizeImage` (JPEG). A full-window PNG is ~1 MB of
 *   base64 per call, and a computer-use turn produces one per action; a host without an image codec
 *   keeps the PNG rather than failing, because a big screenshot still beats no screenshot.
 * - **The coordinate space is restated on every result.** A model told the space once — in the tool
 *   description — still guesses wrong after a zoom, so the text part names the pixel size it is
 *   looking at. That text is also what the message transformer keeps when it drops an old image.
 */
import { defaultBase64Encode } from "../../env";
import { tryReadImageDimensions } from "../../models/estimate-image-tokens.js";

import type { CoreEnv, CoreEnvComputer, CoreEnvImageRegion } from "../../env";
import type { ContentPart } from "@tanstack/ai";

/** Prefix of every computer-use text part; the transformer keys on it when rescanning a transcript. */
export const SCREENSHOT_MARKER = "[screenshot]";

/** Full screenshots are already ≤ the display size: this only widens the cap for `zoom` details. */
const MAX_ZOOM_WIDTH = 1568;

/** A capture, before it becomes tool output. */
export interface CapturedScreen {
  /** One line for the transcript (`present.text`). */
  summary: string;
  base64: string;
  mimeType: string;
  /** `display` for a full screenshot; the requested region's size for a zoom. */
  width: number;
  height: number;
  /**
   * Pixel size of the image ACTUALLY attached (after the host's codec step), when it could be read.
   *
   * A zoom is captured at the screen's physical resolution, so this is 1×–3× the region on a HiDPI
   * panel, and the model cannot infer the factor from the region alone. `undefined` means the bytes
   * were not a shape we can measure — then no claim is made at all, rather than assuming 1:1 (the
   * host may have magnified without us, and a false "this image is the screen" is worse than the
   * conservative "do not use this image's pixels").
   */
  image?: { width: number; height: number };
  /** `image.width / region.width`, when both are known. `screen = region + image / scale`. */
  scale?: number;
  /** Set for a zoom: the display-space region this image magnifies. */
  region?: CoreEnvImageRegion;
  cursor?: { x: number; y: number };
}

/**
 * What both computer tools return.
 *
 * The image fields are optional so a host whose capture failed still returns a usable result (the
 * model gets the action summary and no picture) instead of throwing away what it just did.
 */
export interface ScreenToolOutput {
  /** One line describing what happened; both the transcript row and the model-facing text. */
  summary: string;
  display: { width: number; height: number };
  environment: string;
  /**
   * Set when the image is a magnified view of one region.
   *
   * The model's coordinate space NEVER changes: it stays `display`. Without this field the text
   * would have to guess, and a model that scaled its click down to the zoom image would hit the
   * wrong place — so the region travels with the result and the text states the rule.
   */
  region?: CoreEnvImageRegion;
  mimeType?: string;
  base64?: string;
  /**
   * Pixel size of the attached image when it is NOT the display frame (a zoom), plus the factor that
   * maps it back to screen pixels: `screen = region + image / scale`.
   *
   * Without it the model had to assume a scaling factor (it guessed 2.0 on a 2.25× panel) and every
   * click derived from a magnified read landed ~12% short.
   */
  image?: { width: number; height: number };
  scale?: number;
  /** Tool results are open records (see `ToolCallResult`); the index signature keeps that honest. */
  [key: string]: unknown;
}

/** Smallest zoom worth delivering: a 1x1 crop cannot be read and makes `scale` meaningless. */
const MIN_ZOOM_SIZE = 4;

/**
 * Keep a zoom region inside the screen.
 *
 * The driver clamps too (robotjs can crash on an out-of-range capture), but clamping THERE leaves
 * the result describing a region it never captured: `zoom(1200,700,500,500)` on a 1280-wide display
 * captures 80x100, while the text claimed (1200,700)-(1700,1200) and `scale = 180/500 = 0.36` — a
 * model converting a point landed past the screen edge. Clamping here means the region, the image
 * and the factor describe the SAME crop.
 *
 * `null` when nothing usable is left (fully outside, or smaller than {@link MIN_ZOOM_SIZE}): a
 * degenerate capture is reported as a bad request, not as a 1x1 screenshot.
 */
function clampZoomRegion(
  region: CoreEnvImageRegion,
  display: { width: number; height: number }
): CoreEnvImageRegion | null {
  if (![region.x, region.y, region.width, region.height].every(Number.isFinite)) return null;
  const x = Math.min(Math.max(region.x, 0), display.width - 1);
  const y = Math.min(Math.max(region.y, 0), display.height - 1);
  const width = Math.min(Math.max(region.width, 1), display.width - x);
  const height = Math.min(Math.max(region.height, 1), display.height - y);
  if (width < MIN_ZOOM_SIZE || height < MIN_ZOOM_SIZE) return null;
  return { x, y, width, height };
}

/**
 * Capture the screen (or one region of it).
 *
 * Returns `null` when the host could not capture — the caller reports that, rather than inventing
 * an empty screen, because "I cannot see" and "the screen is black" lead the model to opposite next
 * moves.
 */
export async function captureScreen(
  env: CoreEnv,
  computer: CoreEnvComputer,
  requestedRegion?: CoreEnvImageRegion,
  signal?: AbortSignal
): Promise<CapturedScreen | null> {
  // The region the host will actually capture. Everything downstream (image size, `scale`, the text
  // and the summary) reads THIS, so they cannot disagree.
  const region = requestedRegion ? clampZoomRegion(requestedRegion, computer.display) : undefined;
  if (requestedRegion && !region) {
    throw new Error(
      `The zoom region (${Math.round(requestedRegion.x)},${Math.round(requestedRegion.y)}) ` +
        `${Math.round(requestedRegion.width)}x${Math.round(requestedRegion.height)} is outside the ` +
        `${computer.display.width}x${computer.display.height} screen, or too small to read.`
    );
  }

  let bytes: Uint8Array | null;
  try {
    bytes = region
      ? computer.zoom
        ? await computer.zoom(region, { signal })
        : null
      : await computer.screenshot({ signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  }
  if (!bytes || bytes.length === 0) return null;

  const width = region ? region.width : computer.display.width;
  const height = region ? region.height : computer.display.height;

  // Resize is a codec step, not a coordinate step — the image keeps the frame's dimensions so the
  // reminder below ("this image is the screen") stays true. A zoom is allowed a larger frame (its
  // whole point is legible detail), capped so a 4K region does not become a 25 MB upload.
  //
  // The cap is `MAX_ZOOM_WIDTH`, NOT `region.width`: `region` is in DISPLAY space, and the host's
  // resize is `withoutEnlargement`, so clamping to it re-encoded the driver's native-resolution
  // crop back down to exactly display density — a zoom never magnified anything (and both 1568
  // constants became dead). `region.width` only describes WHERE the crop is, never its resolution.
  const maxWidth = region ? MAX_ZOOM_WIDTH : computer.display.width;
  // Hosts encode/copy synchronously, so an abort that arrived while the capture was in flight would
  // still pay for the whole frame. Cheap to check, and the work is discarded anyway.
  if (signal?.aborted) throw signal.reason;
  const resized = await env.resizeImage?.(bytes, { maxWidth });
  const mimeType = resized ? "image/jpeg" : "image/png";
  const encoded = resized ?? bytes;
  const base64 = (env.base64Encode ?? defaultBase64Encode)(encoded);
  // The ATTACHED image's size, not the frame's. For a zoom these differ by the panel's scale factor
  // (1×–3×), which is exactly what the model needs to map a magnified position back. Unmeasurable
  // bytes stay `undefined`: assuming the region's size would claim a 1:1 image we cannot verify.
  const measured = tryReadImageDimensions(encoded);
  const image = measured && measured.width > 0 && measured.height > 0 ? measured : undefined;
  // One computation, one rounded value: the tool output carries it and the text prints it, so the
  // two cannot disagree.
  const rawScale = region && image && region.width > 0 ? image.width / region.width : undefined;
  const scale = rawScale !== undefined && Number.isFinite(rawScale) ? Math.round(rawScale * 100) / 100 : undefined;

  let cursor: { x: number; y: number } | undefined;
  if (computer.capabilities.cursorPosition && computer.cursorPosition) {
    try {
      cursor = await computer.cursorPosition({ signal });
    } catch (err) {
      // The pointer is a nicety; losing it is fine, but a cancelled run must stay cancelled.
      if (signal?.aborted) throw err;
      cursor = undefined;
    }
  }

  const summary = [
    region ? `screen region ${width}x${height}` : `screen ${width}x${height}`,
    cursor ? `pointer ${Math.round(cursor.x)},${Math.round(cursor.y)}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  return {
    summary,
    base64,
    mimeType,
    width,
    height,
    ...(image ? { image } : {}),
    ...(scale !== undefined ? { scale } : {}),
    ...(region ? { region } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

/**
 * The model-facing projection of {@link ScreenToolOutput}: a coordinate-space reminder plus the
 * image. Idempotency is the caller's job (`isProjectedModelContent`), because a content-part array
 * is not a valid tool output and must be passed through untouched.
 */
export function screenModelParts(output: ScreenToolOutput): ContentPart[] {
  const parts: ContentPart[] = [{ type: "text", content: describeFrame(output) }];
  // A tool output is not guaranteed to be this shape by the type system alone — it round-trips
  // through JSON, and `getToolModelOutput` is a public seam. A missing image must not throw away the
  // reminder text, so the parts are read defensively.
  const base64 = typeof output?.base64 === "string" ? output.base64 : undefined;
  const mimeType = typeof output?.mimeType === "string" ? output.mimeType : undefined;
  if (base64 && mimeType) {
    parts.push({ type: "image", source: { type: "data", value: base64, mimeType } });
  }
  return parts;
}

/**
 * Say, on every result, which space the coordinates belong to.
 *
 * A zoom is the one case where the image is not the screen: the crop is captured at full physical
 * resolution, so its pixels are denser than `display`. The rule that follows is Anthropic's
 * (`computer_20251124`: "The model keeps emitting coordinates in screenshot pixels afterwards; the
 * zoom image itself is never a coordinate frame") — state it, or the model will scale the click it
 * just computed and miss. Stating the rule is not enough on its own: the model also needs the actual
 * factor, because a 2.25× panel with no `scale` field invited it to assume 2.0× and land ~12% short,
 * so the mapping is given explicitly, in arithmetic it can apply.
 */
function describeFrame(output: ScreenToolOutput): string {
  const { width, height } = output.display;
  const screen = `The screen you control is ${width}x${height} pixels`;
  const origin = `(0,0) is its top-left, x grows right, y grows down`;
  // A provider may downscale the attachment (a measured session saw 1280x800 arrive as 1024x640), and
  // nothing on this side can see that. Rather than let the model discover it by trial and error, the
  // rule is stated on every result that KNOWS the size it delivered — never with a guessed one, or it
  // would tell the model to multiply by the wrong ratio.
  const downscaleRule = (declared: { width: number; height: number }) =>
    `If the image you actually see is not ${declared.width}x${declared.height} (a provider may ` +
    `downscale it), multiply what you measure by declared / seen (screen_x = reading_x * ` +
    `${declared.width} / image width) before converting.`;

  if (!output.region) {
    // A full screenshot is display-sized by construction (the box filter emits exactly this frame),
    // but the ATTACHMENT may still be downscaled by the provider — so the sentence names the screen
    // space the coordinates belong to, never "THIS image".
    return `${SCREENSHOT_MARKER} ${output.summary}. ${screen}; coordinates you send are screen pixels in (0,0)-(${width},${height}), where ${origin}. ${downscaleRule({ width, height })}`;
  }

  const { x, y, width: w, height: h } = output.region;
  const image = output.image;
  const ratio = image && w > 0 ? image.width / w : undefined;
  if (image && ratio !== undefined && Number.isFinite(ratio)) {
    // EXACT arithmetic, per axis: a rounded divisor is off by up to `w * 0.005` display pixels
    // (6 px on a 1280-wide region), and a 1% "is it 1:1" window mis-classifies 401/400 as 1:1.
    // "1:1" is a wording, not a formula: it applies only when the dimensions are exactly equal.
    if (image.width === w && image.height === h) {
      return (
        `${SCREENSHOT_MARKER} ${output.summary}. This is the screen region (${x},${y})-(${x + w},${y + h}) ` +
        `at 1:1 (${image.width}x${image.height}) in the ${width}x${height} screen space. ` +
        `To place a point you see in it: screen_x = ${x} + image_x, screen_y = ${y} + image_y. ` +
        `Coordinates you SEND are screen pixels in (0,0)-(${width},${height}), where ${origin}. ${downscaleRule(image)}`
      );
    }
    const factor = Math.round(ratio * 100) / 100;
    return (
      `${SCREENSHOT_MARKER} ${output.summary}. This is a MAGNIFIED view: the image is ` +
      `${image.width}x${image.height} = ${factor}x the screen region (${x},${y})-(${x + w},${y + h}) ` +
      `in the ${width}x${height} screen space. ` +
      // The formula is exact; `factor` above is only the approximate reading of it.
      `To place a point you see in it: screen_x = ${x} + image_x * ${w} / ${image.width}, ` +
      `screen_y = ${y} + image_y * ${h} / ${image.height}. ` +
      `Coordinates you SEND are always screen pixels in (0,0)-(${width},${height}), where ${origin}. ${downscaleRule(image)}`
    );
  }
  // The bytes could not be measured, so the delivered size — and therefore whether this is magnified
  // or 1:1 — is unknown. Claim neither; say what the image covers, which is enough for the model to
  // map a position proportionally using the size it actually sees.
  return (
    `${SCREENSHOT_MARKER} ${output.summary}. This is a view of exactly the screen region ` +
    `(${x},${y})-(${x + w},${y + h}) in the ${width}x${height} screen space, at a scale this host ` +
    `could not report. Do NOT use this image's own pixels as coordinates: keep sending screen ` +
    `coordinates in (0,0)-(${width},${height}), where ${origin}.`
  );
}
