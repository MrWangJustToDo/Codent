/**
 * Bounded waits for extension callbacks.
 *
 * Extensions are third-party code and the contract bounds none of their callbacks, while the runner
 * awaits several of them on the session's critical path: bootstrap activates serially, `collect()`
 * runs before every turn, and teardown waits for `session:shutdown`. A callback that never settles
 * therefore used to hang the whole agent (the "quit does not quit" class of failure).
 *
 * Timeout is not cancellation — there is no signal in the contract — it only stops the runner from
 * waiting forever. The caller reports the failure like any other callback error and continues.
 */

/** Upper bound on one extension lifecycle / turn-context callback. */
export const EXTENSION_CALLBACK_TIMEOUT_MS = 60_000;

/**
 * A bounded wait that ran out.
 *
 * Typed so callers do not have to re-parse the message: teardown classifies a timeout as a warning
 * and anything else as a failure, and `/did not settle within \d+ms$/` flipped that classification
 * the moment someone reworded the text.
 */
export class CallbackTimeoutError extends Error {
  readonly code = "timeout";
  constructor(
    readonly label: string,
    readonly timeoutMs: number
  ) {
    super(`${label} did not settle within ${timeoutMs}ms`);
    this.name = "CallbackTimeoutError";
  }
}

export function isCallbackTimeoutError(error: unknown): error is CallbackTimeoutError {
  return error instanceof CallbackTimeoutError;
}

/** Settle `promise`, or reject with a labelled timeout. A late rejection is consumed by the race. */
export function withCallbackTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs: number = EXTENSION_CALLBACK_TIMEOUT_MS
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    // Deliberately NOT `unref()`d: a bounded wait whose timer does not hold the loop can be lost
    // entirely when it is the only pending work (Node exits with an unsettled top-level await
    // instead of rejecting), which silently turns "times out" into "never settles" — the exact
    // failure this helper exists to prevent.
    timer = setTimeout(() => reject(new CallbackTimeoutError(label, timeoutMs)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Normalize a configured callback timeout.
 *
 * `0` means "no wall-clock bound" (a producer bounded by the run signal instead). Anything that is
 * not a positive finite number is a typo in arbitrary extension JS, not a request — it used to be
 * passed through to `setTimeout`, where `NaN`/negative fire immediately: the section failed on
 * EVERY turn and wrote an `agent:extension-error` each time.
 */
export function normalizeCallbackTimeout(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) return undefined;
  if (timeoutMs === 0) return 0;
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined;
}
