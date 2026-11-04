/**
 * Tool-call argument parsing — one rule for the wire projection, the approval gate and the UI.
 *
 * See {@link parseToolArguments} for the four input shapes and {@link parseToolInput} for the
 * part-level helper every consumer actually calls.
 */

/** The verdict of a parse, so "valid but empty" is distinguishable from "not valid JSON". */
export type ToolArgumentsParse = { ok: true; value: unknown } | { ok: false; value: unknown };

/**
 * Parse without losing the verdict.
 *
 * A caller that needs "is this callable at all" (a resumed `input-complete` call must have parseable
 * JSON) cannot answer that from {@link parseToolArguments}' value alone: a failed parse and a parsed
 * string both come back as strings. This is the single parser; the two projections below are views
 * of it, so validity and extraction can never disagree.
 */
export function tryParseToolArguments(raw: unknown): ToolArgumentsParse {
  if (typeof raw !== "string") return { ok: true, value: raw };
  if (raw.length === 0) return { ok: false, value: undefined };
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, value: raw };
  }
}

/**
 * Parse a tool call's raw argument string.
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
  return tryParseToolArguments(raw).value;
}

/**
 * A tool-call part's input, whatever stage of the call it is at.
 *
 * The engine exposes `input` once it has parsed the arguments; while the call is still streaming
 * only `arguments` exists. A reader that looks at one field alone therefore shows nothing for half
 * the call's life — and the approval gate saw `{}` for every non-command gated tool for exactly that
 * reason. Every consumer (approval, presentation, ACP projection) goes through this function.
 */
export function parseToolInput(part: { input?: unknown; arguments?: unknown }): unknown {
  return parseToolArguments(part.input ?? part.arguments);
}
