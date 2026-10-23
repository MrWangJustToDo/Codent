/**
 * Image previews for the workspace panel.
 *
 * The panel can only draw text, so an image file is decoded by the host (`CoreEnv.imageToText`) and
 * cached here as the rows to render. Three things shape this module:
 *
 *  - **Every selection re-reads.** `FileContent` remounts on `refreshToken`, so a stale entry is
 *    invisible rather than merely wrong: it would show the file as it was before the refresh. The
 *    cache key therefore carries `size` + `mtime`, which costs one `stat` per preview and makes an
 *    out-of-band edit invalidate the entry on its own.
 *  - **`null` is a result.** A file the decoder cannot read must not be retried on every re-render;
 *    a failed preview is cached exactly like a successful one.
 *  - **A zoom window is part of the rendering parameters.** The host renders only the source
 *    rectangle it is given, so the same path at 1× and at 2× are different pictures, not different
 *    draws of one picture.
 *
 * The cache is bounded because the panel is browsed and zoomed: ↑/↓ over a folder of screenshots, or
 * pressing `+` eight times, would otherwise pin every decoded grid in memory for the session.
 */

import { sanitizeAnsi } from "./ansi.js";

import type { CoreEnv, CoreEnvImageRegion, CoreEnvImageTextResult } from "@codent/core";

/** Rows kept in memory. One preview is a few KB of text, so this covers a folder plus a zoom range. */
const MAX_CACHED_PREVIEWS = 32;

export interface ImagePreviewRequest {
  env: CoreEnv;
  /** Absolute path of the selected file. */
  path: string;
  /** Terminal cells available to the preview. */
  maxCols: number;
  maxRows: number;
  /** 24-bit color when true; the colorless ramp when false (`NO_COLOR`, screen reader). */
  color: boolean;
  /** Source-pixel window (zoom/pan). Omitted = the whole image, fitted into the cell box. */
  region?: CoreEnvImageRegion;
}

/**
 * Cache key: the file *identity* plus the rendering parameters.
 *
 * `size`/`mtimeMs` are what make a re-used entry safe across `r` refreshes; without them the panel
 * would keep showing the previous contents of the same path. The region is rounded to whole pixels
 * because that is what the host renders — a sub-pixel pan step re-uses the entry it lands on.
 */
export function imagePreviewCacheKey(input: {
  path: string;
  size: number;
  mtimeMs: number;
  maxCols: number;
  maxRows: number;
  color: boolean;
  region?: CoreEnvImageRegion;
}): string {
  const color = input.color ? "c" : "m";
  const region = input.region
    ? `@${Math.round(input.region.x)},${Math.round(input.region.y)},${Math.round(input.region.width)},${Math.round(input.region.height)}`
    : "@fit";
  return `${input.path}\u0000${input.size}\u0000${Math.floor(input.mtimeMs)}\u0000${input.maxCols}x${input.maxRows}\u0000${color}\u0000${region}`;
}

/**
 * Rounds a window to the whole pixels the host actually renders.
 *
 * The cache key already rounds, so an unrounded request would be a "hit" for a different picture:
 * two sub-pixel pan steps would share one cache slot while rendering different regions. Rounding at
 * the boundary keeps key and request describing the same pixels.
 */
function roundedRegion(region: CoreEnvImageRegion): CoreEnvImageRegion {
  return {
    x: Math.round(region.x),
    y: Math.round(region.y),
    width: Math.round(region.width),
    height: Math.round(region.height),
  };
}

/** Settled results, in LRU order (Map insertion order). */
const cache = new Map<string, CoreEnvImageTextResult | null>();

/** In-flight requests, so two renders of the same file share one decode. */
const pending = new Map<string, Promise<CoreEnvImageTextResult | null>>();

/**
 * Bumped by {@link clearImagePreviewCache}.
 *
 * Clearing `pending` does not cancel a decode already running, and that task would otherwise write
 * its result into the cache AFTER the clear — resurrecting exactly the entry the clear removed.
 */
let cacheGeneration = 0;

function readCache(key: string): { hit: true; result: CoreEnvImageTextResult | null } | { hit: false } {
  if (!cache.has(key)) return { hit: false };
  const result = cache.get(key) ?? null;
  // Re-insert: Map iteration order is the eviction order, so a hit has to move to the end.
  cache.delete(key);
  cache.set(key, result);
  return { hit: true, result };
}

function writeCache(key: string, result: CoreEnvImageTextResult | null): void {
  cache.delete(key);
  cache.set(key, result);
  while (cache.size > MAX_CACHED_PREVIEWS) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/** Drop every entry. Wired into the panel's existing cache-clearing path (`clearContentCache`). */
export function clearImagePreviewCache(): void {
  cacheGeneration++;
  cache.clear();
  pending.clear();
}

/**
 * Resolve the preview for a file, or `null` when it cannot be shown.
 *
 * `null` covers every "no preview" case on purpose — no decoder on this host, unreadable bytes, a
 * file that vanished between `stat` and `read` — because the panel's response is the same for all
 * of them (keep the binary placeholder), and a thrown error there would blank the pane.
 */
export async function loadImagePreview(request: ImagePreviewRequest): Promise<CoreEnvImageTextResult | null> {
  const { env, path, maxCols, maxRows, color, region } = request;

  // Feature-detect before touching the filesystem: a browser host has no decoder, and reading the
  // bytes only to find that out would be work with a known answer.
  if (!env.imageToText) return null;

  let stat;
  try {
    stat = await env.fs.stat(path);
  } catch {
    return null;
  }
  if (!stat.isFile) return null;

  const key = imagePreviewCacheKey({
    path,
    size: stat.size,
    mtimeMs: stat.mtime.getTime(),
    maxCols,
    maxRows,
    color,
    ...(region ? { region } : {}),
  });

  const cached = readCache(key);
  if (cached.hit) return cached.result;

  const inFlight = pending.get(key);
  if (inFlight) return inFlight;

  const generation = cacheGeneration;
  const task = (async () => {
    try {
      // Deliberately NOT pre-shrunk with `env.resizeImage`. Two reasons, both correctness: the host
      // reports `imageWidth`/`imageHeight` of the bytes it was given, so a shrunken copy makes every
      // zoom window be computed in the wrong coordinate system (a 2172px screenshot reported as 512
      // → zoom crops a 250px box out of the original); and `resizeImage` has no EXIF rotation, so the
      // fitted view would disagree with every zoomed view of the same photo.
      const bytes = await env.fs.readFile(path, "buffer");
      const result = await env.imageToText!(bytes, {
        maxCols,
        maxRows,
        color,
        ...(region ? { region: roundedRegion(region) } : {}),
      });
      if (!result) return null;
      // Sanitize at the boundary, not at paint time: these rows can come from a remote env, and
      // the same policy that guards extension payloads applies to anything that reaches a `<Text>`.
      return { ...result, rows: result.rows.map((line) => sanitizeAnsi(line)) };
    } catch {
      return null;
    } finally {
      pending.delete(key);
    }
  })();

  pending.set(key, task);
  const result = await task;
  // A clear that landed while this ran wins: its whole point is that nothing cached survives it.
  if (generation === cacheGeneration) writeCache(key, result);
  return result;
}
