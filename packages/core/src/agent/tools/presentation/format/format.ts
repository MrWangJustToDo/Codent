/**
 * Options for {@link formatDuration}.
 */
export interface FormatDurationOptions {
  /**
   * Report whole seconds: no tenths, and no `ms` below one second.
   *
   * For a value that TICKS in place while the user waits, the tenths change on every tick and
   * read as noise — the display only has to answer "how long has this been running", and a
   * second is the smallest unit worth showing. A one-shot duration (a tool call's elapsed time)
   * keeps its tenths, which is why this is off by default.
   */
  wholeSeconds?: boolean;
}

/** Format duration in milliseconds to a human-readable string. */
export function formatDuration(ms: number, options: FormatDurationOptions = {}): string {
  if (options.wholeSeconds) {
    // Round once, then split: rounding inside the branches let 59.6s render as `60s`.
    const wholeSeconds = Math.round(ms / 1000);
    if (wholeSeconds < 60) return `${wholeSeconds}s`;
    return `${Math.floor(wholeSeconds / 60)}m ${wholeSeconds % 60}s`;
  }
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds.toFixed(0)}s`;
}

/**
 * Max characters for one stringified entry value in argument / input display.
 *
 * Owns the budget the generic-argument and tool-argument formatters share; it was 30 in one and
 * 50 in the other, so the same value rendered at two widths.
 */
export const ENTRY_VALUE_MAX_CHARS = 50;
