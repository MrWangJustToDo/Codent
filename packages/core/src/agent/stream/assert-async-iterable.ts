/**
 * Ensure a value is async-iterable before `for await` / `yield*`.
 * Prevents the cryptic `Cannot read properties of undefined (reading 'Symbol(Symbol.asyncIterator)')`.
 */
export function assertAsyncIterable<T>(value: unknown, context: string): asserts value is AsyncIterable<T> {
  if (value == null) {
    throw new Error(
      `${context} returned no stream (undefined). Check model baseURL, API key, and provider configuration.`
    );
  }
  if (typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] !== "function") {
    throw new Error(
      `${context} returned a non-stream value (${typeof value}). Expected an async iterable of stream chunks.`
    );
  }
}

/** Coerce any thrown value to an Error, preferring a real message over `String(value)`. */
function toStreamError(error: unknown, fallback: string): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string" && error) return new Error(error);
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return new Error(message);
  }
  return new Error(fallback);
}

/**
 * Map a thrown stream/run error to an actionable Error for UI display.
 *
 * The single formatter for every run profile (interactive chat and worker/subagent),
 * so the same failure reads identically in both. `fallback` names the run when the
 * thrown value carries no usable message.
 */
export function formatAgentStreamError(error: unknown, fallback = "Agent run failed"): Error {
  const err = toStreamError(error, fallback);
  if (/Symbol\.asyncIterator/.test(err.message)) {
    return new Error(
      "Agent stream failed to start. Verify BASE_URL (or --base-url), API_KEY, and that the model endpoint is reachable."
    );
  }
  return err;
}
