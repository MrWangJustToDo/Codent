/**
 * Run a diagnostic sink without letting a failure there escape.
 *
 * `report` is host-wired (an agent-log sink, an event projector, an SSE writer). Its callers run
 * inside dispatch loops and `Promise.catch` handlers, so a throwing sink would either cost the
 * remaining subscribers their frame or turn into an unhandled rejection. Containing it in one
 * helper keeps the "a broken error sink must not break dispatch" rule from being re-implemented
 * (and diverging) at every call site.
 */
export function reportContained(report: (() => void) | undefined): void {
  if (!report) return;
  try {
    report();
  } catch {
    // A broken error sink must not break dispatch or throw from a catch.
  }
}
