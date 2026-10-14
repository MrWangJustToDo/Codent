import type { AgentRetryState } from "@codent/core";

/** Human label per retry strategy (shared by footer / task UI / panels). */
export const RETRY_STRATEGY_LABEL: Record<AgentRetryState["strategy"], string> = {
  transient: "provider busy",
  capability: "content stripped",
  reactive_compact: "context compacted",
  max_tokens: "output limit",
};

/**
 * Milliseconds left in the backoff before a retry is issued.
 *
 * `delayMs` is the *scheduled* wait, recorded once when the retry is surfaced; the live
 * value has to be derived from `startedAt` against the wall clock. Clamped to
 * `[0, delayMs]` so a `now` captured before the retry was recorded cannot overshoot.
 * `0` means the backoff is over and the retry request is already in flight.
 */
export function retryRemainingMs(retry: AgentRetryState, now: number = retry.startedAt): number {
  if (retry.delayMs == null) return 0;
  return Math.max(0, Math.min(retry.delayMs, retry.delayMs - (now - retry.startedAt)));
}

/** In-flight marker: the backoff elapsed (or there was none) and the request is out. */
export const RETRY_IN_FLIGHT_LABEL = "awaiting response";

/**
 * Single-line retry status.
 *
 * The two phases a retry can be in share ONE trailing segment, never two: while the
 * backoff is still running the line carries the countdown plus the reason for waiting;
 * once it elapses (or for a strategy that retries immediately) the request is already out,
 * so the countdown and the reason are replaced by a single in-flight marker. Concatenating
 * them read as two ways of saying "still waiting" and stretched the line.
 *
 * Pass `now` from a live ticker (`useRetryTicker`) to animate the countdown; omit it to
 * render the scheduled wait as a static value.
 *
 * @example `Retrying (2/3) ~4s · provider busy`  (backoff counting down)
 * @example `Retrying (2/3) · awaiting response`  (request in flight)
 */
export function formatRetryStatus(retry: AgentRetryState, now?: number): string {
  const head = `Retrying (${retry.attempt}/${retry.maxAttempts})`;
  const remaining = retryRemainingMs(retry, now ?? retry.startedAt);
  if (retry.delayMs == null || remaining <= 0) {
    return `${head} · ${RETRY_IN_FLIGHT_LABEL}`;
  }
  return `${head} ~${Math.ceil(remaining / 1000)}s · ${RETRY_STRATEGY_LABEL[retry.strategy]}`;
}
