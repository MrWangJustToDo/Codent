/**
 * Human-readable byte sizes — the one definition.
 *
 * The `Math.round(size / 1024) + "KB"` shape had been rewritten in the read-file model text, its
 * display text, the session-log guard, and the read-file size guard, and the megabytes variant
 * (`Math.round(size / 1024 / 1024)`) alongside it. Two spellings of the same conversion are how
 * "12KB" and "12.0KB" end up in one transcript.
 */

/** Formatting choices for {@link formatByteSize}. */
export interface FormatByteSizeOptions {
  /** Decimal places for `KB`/`MB`. Defaults to `0` (whole units). */
  decimals?: number;
  /**
   * Render the `B` tier below 1 KiB (`500B`) instead of rounding to `0KB`.
   *
   * Defaults to `false` because the model-facing read/oversize guards report whole KB; a display
   * caller that shows attachments needs the sub-KiB value and asks for it explicitly.
   */
  showBytes?: boolean;
}

/**
 * Format a byte count as `KB` below 1 MiB and `MB` at or above it.
 *
 * Rounded to whole units by default, matching the numbers the read/oversize guards already
 * reported. Display callers can opt into decimals and the `B` tier (see the options); the point of
 * the function is that both callers make those choices here, not that they all look the same.
 */
export function formatByteSize(bytes: number, options: FormatByteSizeOptions = {}): string {
  const decimals = options.decimals ?? 0;
  if (options.showBytes && bytes < 1024) return `${Math.max(0, Math.round(bytes))}B`;
  const unit = (value: number): string => (decimals > 0 ? value.toFixed(decimals) : String(Math.round(value)));
  const kb = bytes / 1024;
  if (kb < 1024) return `${unit(kb)}KB`;
  return `${unit(kb / 1024)}MB`;
}
