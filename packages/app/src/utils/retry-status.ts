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

/**
 * Single-line retry status.
 *
 * The trailing segment is always the strategy reason, so it swaps per strategy
 * (`provider busy` / `content stripped` / `context compacted` / `output limit`) and keeps
 * naming *why* we are retrying into the request phase. The phase itself is the countdown's
 * presence: `~Ns` while the backoff is still running, gone once the request is out — no
 * second "awaiting" phrase, which only restated the reason and stretched the line.
 *
 * Pass `now` from a live ticker (`useRetryTicker`) to animate the countdown; omit it to
 * render the scheduled wait as a static value.
 *
 * @example `Retrying (2/3) ~4s · provider busy`  (backoff counting down)
 * @example `Retrying (2/3) · provider busy`      (request in flight)
 */
export function formatRetryStatus(retry: AgentRetryState, now?: number): string {
  const head = `Retrying (${retry.attempt}/${retry.maxAttempts})`;
  const remaining = retryRemainingMs(retry, now ?? retry.startedAt);
  const wait = retry.delayMs != null && remaining > 0 ? ` ~${Math.ceil(remaining / 1000)}s` : "";
  return `${head}${wait} · ${RETRY_STRATEGY_LABEL[retry.strategy]}`;
}
