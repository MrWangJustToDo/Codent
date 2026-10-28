/**
 * Observer half of an extension's event surface (`observe` / `observeAny` / `retained`).
 *
 * Kept out of `runner.ts` because the runner is already at the file-size ceiling and because
 * this is a self-contained seam: it delegates to the bus's existing observer dispatch mode
 * (synchronous, registration-ordered, fire-and-forget, throw-isolated) rather than
 * reimplementing dispatch, and only adds the three things the bus does not do for an
 * extension:
 *
 *   - **rejected-promise containment** — the observer dispatch mode is synchronous, so a
 *     handler that returns a rejected promise would otherwise become an unhandled rejection
 *     (and, under the process guards, a fatal one);
 *   - **declared-set expansion** — `observeAny` subscribes per observable event instead of to
 *     `"*"`, so internal events stay internal and the Event→Log bridge remains core's only
 *     wildcard consumer;
 *   - **teardown bookkeeping** — every disposer is recorded so disabling the extension stops
 *     its observers.
 */

import { observableExtensionEvents } from "./types.js";

import type {
  ExtensionEventObserver,
  ExtensionObserverOptions,
  ExtensionObserverSurface,
  ExtensionRegistrations,
  ObservableExtensionEvent,
  ExtensionContext,
} from "./types.js";
import type { AgentEvent, AgentEventBus, AgentEventListener } from "../agent-event-bus";

export interface ObserverSurfaceDeps {
  /** The extension's scoped bus (events up-flow from subagent scopes). */
  bus: AgentEventBus;
  /**
   * Report a contained handler failure — logged and emitted as `agent:extension-error`.
   * `eventType` is the event being dispatched: reporting a failure of an
   * `agent:extension-error` observer must not re-emit that event.
   */
  reportFailure: (err: unknown, eventType?: string) => void;
  /**
   * The extension's live context, resolved per dispatch. Optional: a standalone observer surface
   * (no runner) calls handlers with the event alone.
   */
  getContext?: () => ExtensionContext | undefined;
  /**
   * Whether the owning extension may still register. Optional (a standalone surface is always
   * live). When it returns false the accessors are inert, so a disabled extension's leaked
   * callback cannot keep observing events for the rest of the session.
   */
  isLive?: () => boolean;
  /** Called once when a registration is refused (the runner logs a single warning per revoke). */
  onRefused?: () => void;
}

/**
 * Build the observer accessors bound to one extension's registrations.
 *
 * The returned disposers are pushed onto `registrations.unsubObservers` so
 * `unregisterInstanceArtifacts` releases them on disable/destroy.
 */
export function createObserverSurface(
  deps: ObserverSurfaceDeps,
  registrations?: ExtensionRegistrations
): ExtensionObserverSurface {
  const track = (unsub: () => void): (() => void) => {
    registrations?.unsubObservers.push(unsub);
    return unsub;
  };

  /** Refuse a post-disable registration before it reaches the bus. */
  const refused = (): boolean => {
    if (!deps.isLive || deps.isLive()) return false;
    deps.onRefused?.();
    return true;
  };

  /** Keep the handler's return, but surface a rejection as a contained failure. */
  const contained =
    <T extends ObservableExtensionEvent>(handler: ExtensionEventObserver<T>) =>
    (event: AgentEvent<T>): void => {
      try {
        // Second argument: the extension's live context (session/run/model facts). Resolved per
        // dispatch so a handler never sees the previous run's facts.
        const result = handler(event, deps.getContext?.());
        if (result && typeof (result as Promise<void>).then === "function") {
          void (result as Promise<void>).catch((err: unknown) => deps.reportFailure(err, event.type));
        }
      } catch (err) {
        // The bus contains a synchronous throw too; reporting it here keeps both failure
        // shapes on one observability path.
        deps.reportFailure(err, event.type);
      }
    };

  return {
    observe: (type, handler, options) => {
      if (refused()) return () => {};
      return track(
        deps.bus.on(type, contained(handler) as AgentEventListener<typeof type>, {
          replay: options?.replay ?? defaultReplay("observe", options),
        })
      );
    },
    observeAny: (handler, options) => {
      if (refused()) return () => {};
      const listener = contained(handler);
      // No `"*"`: expand the declared observable set so internal events are not delivered and
      // the wildcard-consumer invariant holds.
      const unsubs = observableExtensionEvents().map((type) =>
        deps.bus.on(type, listener as AgentEventListener<typeof type>, {
          replay: defaultReplay("observeAny", options),
        })
      );
      return track(() => {
        for (const unsub of unsubs) unsub();
      });
    },
    retained: (type) => (refused() ? undefined : deps.bus.retainedValue(type)),
  };
}

/**
 * Replay defaults differ by accessor: a single-event subscriber wants the current retained
 * value immediately, a broad subscriber must not be hit with a burst of snapshots at
 * subscribe time.
 */
function defaultReplay(accessor: "observe" | "observeAny", options?: ExtensionObserverOptions): boolean {
  if (options?.replay !== undefined) return options.replay;
  return accessor === "observe";
}
