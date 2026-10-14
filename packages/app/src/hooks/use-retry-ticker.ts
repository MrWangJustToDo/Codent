/**
 * use-retry-ticker — live clock for a pending LLM retry.
 *
 * `AgentRetryState.delayMs` is the *scheduled* backoff, recorded once when the retry is
 * surfaced — reading it directly freezes the countdown. The value a host renders has to be
 * derived from `startedAt` against the wall clock, so this hook ticks while the backoff is
 * still running and stops the interval the moment it elapses. Two consequences matter:
 * a long in-flight retry request costs no re-renders, and `formatRetryStatus` sees the
 * backoff → in-flight transition and can switch its label.
 */

import { useEffect, useState } from "react";

import type { AgentRetryState } from "@codent/core";

// ============================================================================
// Constants
// ============================================================================

/** Countdown tick interval (ms) — fast enough to read as a clock, cheap to render. */
const TICK_MS = 250;

// Exported so a test can pin the cadence (mirrors `useToolElapsed`).
export { TICK_MS };

// ============================================================================
// Hook
// ============================================================================

/**
 * @param retry - Pending retry state, or null/undefined when not retrying.
 * @returns `Date.now()` that advances while the backoff counts down, then freezes.
 */
export function useRetryTicker(retry?: AgentRetryState | null): number {
  const [now, setNow] = useState(() => Date.now());
  const active = retry != null && retry.delayMs != null;
  const startedAt = retry?.startedAt ?? 0;
  const delayMs = retry?.delayMs ?? 0;

  useEffect(() => {
    if (!active) return;
    // Re-sync on entry: `now` may belong to a previous retry (or an earlier render).
    const tick = (): boolean => {
      const current = Date.now();
      setNow(current);
      return current - startedAt >= delayMs;
    };
    if (tick()) return;
    const id = setInterval(() => {
      if (tick()) clearInterval(id);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [active, startedAt, delayMs]);

  return now;
}
