/**
 * Is this error the user aborting the run, rather than a failure?
 *
 * The question has to be answered in three places that cannot share a call stack: the run
 * coordinator (did the pump stop because of an abort?), and any tool that received an
 * `abortSignal` and has to decide whether to settle as "cancelled" or to throw. Leaving each
 * one its own heuristic is how the shapes drifted apart — a tool matched
 * `ExecutionError.code === "aborted"`, the coordinator matched `name === "AbortError"` plus a
 * substring, and a remote CoreEnv reconstructs the error over HTTP so the class identity is
 * gone by the time it arrives. This is the one predicate for all of them.
 *
 * `signal` is checked first and is the strongest evidence: if the run's controller is already
 * aborted, the throw is the abort, whatever the error looks like.
 *
 * The message branch is the last resort, and it matches an abort WORD rather than one exact
 * string — because by the time the error has crossed into a tool-call part only its message is
 * left (TanStack writes `{ error: message }`), and the two producers disagree on the text:
 * `native-run` throws `ExecutionError("aborted", "Command aborted")` and the node shell throws a
 * bare `Error("aborted")`. Matching `=== "aborted"` recognized only the second, so an abort that
 * reached the render layer as "Command aborted" was classified as a plain failure. The word
 * anchor keeps it from over-reaching: "abort" must appear as a word, and a timeout is not an
 * abort ("Command timed out after 30s" does not match).
 */
export function isAbortError(err: unknown, signal?: AbortSignal | null): boolean {
  if (signal?.aborted) return true;
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return true;
  // A remote CoreEnv serializes `ExecutionError` as `{ name, code, message }` and rebuilds it
  // host-side; `instanceof` survives that, but the plain-object path does not, so match both.
  if ((err as { code?: unknown }).code === "aborted") return true;
  if (err.name === "ExecutionError" && (err as { code?: unknown }).code === "aborted") return true;
  return /\babort(?:ed)?\b/i.test(err.message);
}

/**
 * The ONE way to construct an abort-shaped `Error`.
 *
 * Four modules used to build this by hand (`abort-timeout`, `compaction/abort-classification`,
 * `extension-completion`, `code-mode`), and two of them set only `name` — so `isAbortError` (which
 * matches name, code, or the word in the message) classified a tool deadline as a user cancel
 * depending on which producer threw. Keeping the constructor beside the predicate means the shape
 * that is written and the shape that is recognized cannot drift.
 *
 * `code` defaults to `"aborted"`; a caller with a stricter vocabulary (compaction's
 * `isCompactionCancel`) passes its own and keeps it.
 */
export function abortError(message: string, options: AbortErrorOptions = {}): Error {
  const error = new Error(message, options.cause === undefined ? undefined : { cause: options.cause });
  error.name = "AbortError";
  (error as Error & { code?: string }).code = options.code ?? "aborted";
  return error;
}

export interface AbortErrorOptions {
  /** Structured code for consumers that branch on it (default `"aborted"`). */
  code?: string;
  cause?: unknown;
}

/**
 * Is this error a deadline expiry rather than a user abort or a plain failure?
 *
 * The counterpart to {@link isAbortError}, kept beside it because they answer the same question
 * twice: "the run stopped" is either the user (abort) or a deadline (timeout), and neither is a
 * tool failure. Structural on `code` for the same reason — a remote CoreEnv rebuilds the error
 * from `{ name, code, message }`, so `instanceof` does not survive the wire.
 */
export function isTimeoutError(err: unknown): boolean {
  return (err as { code?: unknown } | null | undefined)?.code === "timeout";
}

/**
 * A settled-tool output carrying the user-cancel marker, for either of the two shapes the
 * codebase writes: `cancelled` (what a tool sets when it caught its own abort) and `aborted`
 * (what the `task` tool sets, because its subagent cancels instead of throwing).
 */
export function isCancelledOutputMarker(output: unknown): boolean {
  if (typeof output !== "object" || output === null) return false;
  return (output as { cancelled?: boolean }).cancelled === true || (output as { aborted?: boolean }).aborted === true;
}

/** The fields the framework's synthetic cancel payload carries — and nothing else. */
const SYNTHETIC_CANCEL_KEYS = new Set(["success", "error", "cancelled", "aborted", "reason"]);

/**
 * The framework's synthetic cancel payload specifically, as opposed to any output that carries a
 * cancel marker.
 *
 * They need distinguishing because a cancelled tool has TWO possible outputs, written by two
 * different writers at two different moments, and they deserve different rendering:
 *
 * - the framework fallback (`cancelInFlightToolCalls` / `cancelIncompleteToolCalls`) settles an
 *   interrupted tool with `{ success: false, error, cancelled: true }` — a SHARED shape that is no
 *   tool's output schema, and which carries no output at all, because the tool never returned;
 * - a tool that caught its own abort returns a FULL output with `cancelled: true` — `run_command`
 *   includes the stdout the command managed to print before the stop.
 *
 * A formatter must not read the first (there is nothing there to read — `run_command` rendered the
 * literal `Exit code: undefined`, and `todo` threw). The second is a real result and must still
 * render, minus the exit code. Telling them apart by "does it carry anything besides the marker"
 * is exactly the difference between "we have no output" and "we have partial output".
 */
export function isSyntheticCancelOutput(output: unknown): boolean {
  if (!isCancelledOutputMarker(output)) return false;
  return Object.keys(output as object).every((key) => SYNTHETIC_CANCEL_KEYS.has(key));
}

/**
 * The text a synthetic cancel should show the UI **and** the model.
 *
 * The marker is shared by two writers with different reasons: a user abort writes
 * "Cancelled by user.", while crash recovery writes "Session restored after an interrupted run.".
 * Rendering one constant for both attributes a crash to the user (and it was the only reason ever
 * shown, because the formatters short-circuited before reading `error`).
 */
export function syntheticCancelMessage(output: unknown): string {
  const reason = (output as { reason?: unknown } | null | undefined)?.reason;
  return typeof reason === "string" && reason.trim() ? reason : "Cancelled by user.";
}
