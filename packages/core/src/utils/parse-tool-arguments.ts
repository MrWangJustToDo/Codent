/**
 * Parse a tool call's raw argument string — the one rule both the wire projection and the UI
 * presentation use.
 *
 * - non-string input (an adapter that already parsed it, or a streamed fragment) is returned as-is;
 * - an empty string means "no arguments" and becomes `undefined`;
 * - valid JSON is parsed;
 * - anything else is returned verbatim, because some adapters forward partial/free-form fragments
 *   that the caller must still be able to display.
 *
 * Deliberately no `undefined` fallback for a failed parse: the raw string is the information.
 */
export function parseToolArguments(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}
