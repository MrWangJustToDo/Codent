/**
 * Character-bounded truncation with an omission marker — the one definition.
 *
 * The `text.length > n ? text.slice(0, n) + "..." : text` shape had been rewritten at ~20 call
 * sites, and the marker budget was hand-computed at each: some callers reserved three characters
 * (`slice(0, 57)` for a requested width of 60) and others did not (`slice(0, 60)`), so two callers
 * asking for "the same" width disagreed by a marker's length. The budget lives here once.
 */

/** The default omission marker. */
export const OMISSION_MARKER = "...";

export interface TruncateTextOptions {
  /** Marker appended when truncation occurs. Defaults to {@link OMISSION_MARKER}. */
  marker?: string;
}

/**
 * Truncate `text` to at most `maxLength` characters **including** the marker.
 *
 * The marker is reserved from the budget, so the returned string is never longer than `maxLength`
 * and two callers that pass the same width produce the same-length result.
 *
 * @example truncateText("abcdef", 5) // "ab..."
 */
export function truncateText(text: string, maxLength: number, options: TruncateTextOptions = {}): string {
  const marker = options.marker ?? OMISSION_MARKER;
  if (text.length <= maxLength) return text;
  const keep = Math.max(0, maxLength - marker.length);
  return text.slice(0, keep) + marker;
}
