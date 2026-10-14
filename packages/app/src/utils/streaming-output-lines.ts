/**
 * App streaming-output window — a thin adapter over core's shared line-window helper.
 *
 * The line splitting and the "latest N lines + `… N lines hidden above`" arithmetic live
 * once in `@codent/core` (`splitStreamingLines` / `buildLineWindow`); this module only
 * binds them to the raw-text input the streaming view has.
 */

import { buildLineWindow, splitStreamingLines } from "@codent/core";

import type { LineWindow, LineWindowOptions } from "@codent/core";

/**
 * Build a window of the latest lines from raw text: it grows up to `maxLines`, then
 * scrolls and replaces the first row with the overflow indicator.
 */
export function buildFixedStreamingWindow(text: string, maxLines: number, options?: LineWindowOptions): LineWindow {
  return buildLineWindow(splitStreamingLines(text), maxLines, options);
}
