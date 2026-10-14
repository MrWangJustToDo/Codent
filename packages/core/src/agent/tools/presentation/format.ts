/** Format duration in milliseconds to a human-readable string. */
export function formatDuration(ms: number): string {
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
