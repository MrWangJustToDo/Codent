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

/**
 * Stable identity for "this handler failed, in this dispatch mode, on this scope".
 *
 * `kind` is part of it on purpose: one handler name can be registered as BOTH an observer and an
 * interceptor, and without it the first failure claimed the key so the other mode's failure never
 * reached the console. Shared by the bus (default reporter) and the scope cache (stderr fallback),
 * which had two hand-written copies of this string.
 */
export interface HandlerFailureIdentity {
  kind?: "interceptor" | "observer";
  scopeId: string;
  event: string;
  pattern: string;
}

export function handlerFailureKey(info: HandlerFailureIdentity): string {
  return `${info.kind ?? "interceptor"}\0${info.scopeId}\0${info.event}\0${info.pattern}`;
}
