/**
 * The shared synthetic output for a tool call whose argument payload never completed.
 *
 * Two shapes reach a settlement boundary, and they must not be collapsed into the user-cancel
 * marker:
 *
 * - **zero-byte arguments** (`""` / whitespace): the response announced a call and never streamed
 *   a byte of its arguments;
 * - **incomplete argument JSON** (`{"command":` or an empty object `{}` when the tool's schema
 *   requires a property): the stream stopped inside the payload.
 *
 * `{}` is deliberately NOT truncation in general: built-ins whose schema has every field optional
 * (`list_file`, `tree`) are legitimately called with `{}`.
 *
 * The marker is **exclusive** (`interrupted` + `argumentsIncomplete`, plus the cancel-marker fields)
 * for the same reason the cancel marker has its own key set: several built-ins legitimately return
 * a `truncated: true` field (`read_file`, `tree`, `webfetch`, `session_search` describe a clipped
 * RESULT). Keying the marker on that word alone painted a large successful read as "did not run".
 * No formatter may read this shape's tool fields; every one of them must short-circuit it first.
 */

/** One-line body for a truncated call, shown in the transcript and returned to the model. */
export const TRUNCATED_TOOL_CALL_MESSAGE =
  "The response ended before this tool call's arguments were complete. It did not run.";

/** Short header suffix for a truncated row (the body carries the full notice). */
export const TRUNCATED_TOOL_CALL_SUMMARY = "interrupted";

/** The fields the synthetic interruption payload carries — and nothing else. */
const INTERRUPTED_TOOL_KEYS = new Set(["success", "error", "reason", "interrupted", "argumentsIncomplete", "stalled"]);

/**
 * Whether an output is the shared interruption marker (a call that never ran), as opposed to a
 * real tool result.
 *
 * The exact key set is what distinguishes a framework-synthesized payload from a tool's own output
 * that happens to carry a similar word — the precedent `isSyntheticCancelOutput` set.
 */
export function isInterruptedToolOutput(output: unknown): boolean {
  if (typeof output !== "object" || output === null) return false;
  const record = output as Record<string, unknown>;
  if (record.interrupted !== true || record.success !== false) return false;
  if (typeof record.error !== "string") return false;
  return Object.keys(record).every((key) => INTERRUPTED_TOOL_KEYS.has(key));
}

/** Whether an output is specifically the "arguments never arrived" marker. */
export function isTruncatedToolOutput(output: unknown): boolean {
  if (!isInterruptedToolOutput(output)) return false;
  return (output as { argumentsIncomplete?: unknown }).argumentsIncomplete === true;
}

/** The notice an interruption marker carries (the marker's `error`, never a tool's field). */
export function interruptedToolMessage(output: unknown): string {
  const message = (output as { error?: unknown } | null | undefined)?.error;
  return typeof message === "string" && message.trim() ? message : TRUNCATED_TOOL_CALL_MESSAGE;
}
