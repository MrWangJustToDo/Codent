/**
 * Unknown-error normalization — the one definition.
 *
 * `error instanceof Error ? error : new Error(String(error))` was spelled at ~43 sites across 48
 * files, and `error instanceof Error ? error.message : String(error)` at as many more. The two
 * questions — "give me an Error" and "give me a message" — each have one answer here, so a subtle
 * divergence (for example `String(...)` vs `JSON.stringify(...)` for a non-Error) cannot reappear.
 */

/** Normalize an unknown thrown value to an `Error`. */
export function toError(error: unknown, fallback?: string): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string" && error) return new Error(error);
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return new Error(message);
  }
  if (fallback !== undefined) return new Error(fallback);
  return new Error(String(error));
}

/** Extract a message from an unknown thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
