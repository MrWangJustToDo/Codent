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
  width: number;
  height: number;
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
  /** Tool results are open records (see `ToolCallResult`); the index signature keeps that honest. */
  [key: string]: unknown;
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
  region?: CoreEnvImageRegion,
  signal?: AbortSignal
): Promise<CapturedScreen | null> {
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
  const maxWidth = region ? Math.min(region.width, MAX_ZOOM_WIDTH) : computer.display.width;
  // Hosts encode/copy synchronously, so an abort that arrived while the capture was in flight would
  // still pay for the whole frame. Cheap to check, and the work is discarded anyway.
  if (signal?.aborted) throw signal.reason;
  const resized = await env.resizeImage?.(bytes, { maxWidth });
  const mimeType = resized ? "image/jpeg" : "image/png";
  const base64 = (env.base64Encode ?? defaultBase64Encode)(resized ?? bytes);

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

  return { summary, base64, mimeType, width, height, ...(region ? { region } : {}), ...(cursor ? { cursor } : {}) };
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
 * just computed and miss.
 */
function describeFrame(output: ScreenToolOutput): string {
  const { width, height } = output.display;
  const screen = `The screen you control is ${width}x${height} pixels`;
  const origin = `(0,0) is its top-left, x grows right, y grows down`;

  if (!output.region) {
    return `${SCREENSHOT_MARKER} ${output.summary}. ${screen}; coordinates you send are pixels in THIS image — ${origin}.`;
  }

  const { x, y, width: w, height: h } = output.region;
  return (
    `${SCREENSHOT_MARKER} ${output.summary}. This is a MAGNIFIED view of the screen region ` +
    `(${x},${y})-(${x + w},${y + h}) in the ${width}x${height} screen space. ` +
    `Do NOT use this image's own pixels as coordinates: keep sending screen coordinates in ` +
    `(0,0)-(${width},${height}), where ${origin}.`
  );
}
