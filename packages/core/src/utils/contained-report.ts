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

/**
 * Hand one failure to the owner's reporter without letting the report escape.
 *
 * The async branch runs inside a `.catch`, so a throwing reporter there became an unhandled
 * rejection; the sync branch runs inside the delivery loop, so a throwing reporter cost the
 * remaining listeners their frame. With NO reporter the failure is still surfaced: silently
 * dropping it is the one outcome a multicast primitive must not pick by default.
 */
export function safeReport(report: ((error: unknown) => void) | undefined, error: unknown): void {
  if (!report) {
    console.error("[listener] notification failed:", error);
    return;
  }
  reportContained(() => report(error));
}

/**
 * Deliver one notification to one subscriber.
 *
 * A throw, and an async rejection from a `void`-typed subscriber, are both contained and handed to
 * the reporter. Every dispatcher in core (the event bus, `Emitter`, the UI channel) shares this,
 * because three copies of the try/catch + thenable check is how one of them ends up silent.
 */
export function deliverContained<TArgs extends unknown[]>(
  listener: (...args: TArgs) => unknown,
  args: TArgs,
  report?: (error: unknown) => void
): void {
  try {
    const result = listener(...args);
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(result).catch((error) => safeReport(report, error));
    }
  } catch (error) {
    safeReport(report, error);
  }
}
