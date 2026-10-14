/**
 * Human-readable byte sizes — the one definition.
 *
 * The `Math.round(size / 1024) + "KB"` shape had been rewritten in the read-file model text, its
 * display text, the session-log guard, and the read-file size guard, and the megabytes variant
 * (`Math.round(size / 1024 / 1024)`) alongside it. Two spellings of the same conversion are how
 * "12KB" and "12.0KB" end up in one transcript.
 */

/**
 * Format a byte count as `KB` below 1 MiB and `MB` at or above it.
 *
 * Rounded to whole units, matching the numbers the read/oversize guards already reported.
 */
export function formatByteSize(bytes: number): string {
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)}KB`;
  return `${Math.round(kb / 1024)}MB`;
}
