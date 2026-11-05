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

/** Settle `promise`, or reject with a labelled timeout. A late rejection is consumed by the race. */
export function withCallbackTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs: number = EXTENSION_CALLBACK_TIMEOUT_MS
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
