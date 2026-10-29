/**
 * Which events the extension observation surface exposes — the **read side** of the bus, as a
 * declaration rather than an implementation.
 *
 * The classification itself lives beside the event (`AGENT_EVENT_META[...].visibility`), so a new
 * event is classified in one place and the registry's `satisfies` check refuses to compile without
 * it. This module derives the read-side shapes from that table; three consumers need them and have
 * nothing else in common — the extension facade (`observeAny` expands the observable set), the bus
 * (wildcard delivery withholds internal events), and the validators that hold the two to each other.
 */

import { AGENT_EVENT_META } from "../agent-event-bus/meta.js";

import type { ExtensionContext } from "./types.js";
import type { AgentEvent, AgentEventType, AgentEvents, EventVisibility } from "../agent-event-bus/types.js";

/**
 * Visibility of one observer event to extensions.
 *
 * - `observable` — an extension may subscribe to it or read its retained value.
 * - `internal` — deliberately withheld; the reason is recorded next to the row.
 */
export type ExtensionEventVisibility = EventVisibility;

/**
 * Extension visibility, derived from the event registry.
 *
 * The classification belongs beside the event (`AGENT_EVENT_META[...].visibility`), so adding an
 * event cannot leave a second table behind. `ExtensionEventVisibility` is the public name for the
 * same union.
 */
export const EXTENSION_EVENT_VISIBILITY = Object.fromEntries(
  (Object.keys(AGENT_EVENT_META) as AgentEventType[]).map((type) => [type, AGENT_EVENT_META[type].visibility])
) as { readonly [K in AgentEventType]: (typeof AGENT_EVENT_META)[K]["visibility"] };

/**
 * The same classification as a runtime `Set`, for the bus's wildcard delivery.
 *
 * Derived from {@link EXTENSION_EVENT_VISIBILITY} so there is one source of truth (and the
 * compile-time exhaustiveness check stays on that table). A `Set` of a literal union was chosen
 * over an `Object.values(...).includes(...)` filter so the per-event check is a hash lookup rather
 * than a `readonly string[]` scan on the bus's emit path.
 *
 * The bus imports this runtime value; it holds no dependency back, so there is no cycle.
 *
 * ⚠️ An `internal` event MUST NOT carry a *rendering* event→entry rule: the wildcard subscriber is
 * what turns events into log entries, and wildcard delivery withholds internal events, so a formatter
 * can never run. It must be `false` in `DEFAULT_EVENT_LOG_RULES` — an explicit "never logged" cell —
 * because the table is exhaustive: an omitted internal event would be indistinguishable from one
 * whose author forgot it. Asserted in `validate-extension-event-observation` §7b, which accepts
 * `false` and rejects a formatter.
 */
export const INTERNAL_EXTENSION_EVENTS: ReadonlySet<string> = new Set(
  Object.entries(EXTENSION_EVENT_VISIBILITY)
    .filter(([, visibility]) => visibility === "internal")
    .map(([type]) => type)
);

/** Every event an extension may observe. */
export type ObservableExtensionEvent = {
  [K in keyof typeof EXTENSION_EVENT_VISIBILITY]: (typeof EXTENSION_EVENT_VISIBILITY)[K] extends "observable"
    ? K
    : never;
}[keyof typeof EXTENSION_EVENT_VISIBILITY];

/**
 * The observable set as a runtime list, in declaration order.
 *
 * Used by `observeAny` to expand into per-event subscriptions; exported so a validator can assert
 * the expansion matches the table rather than reproducing the filter.
 */
export function observableExtensionEvents(): ObservableExtensionEvent[] {
  return (Object.keys(EXTENSION_EVENT_VISIBILITY) as AgentEventType[]).filter(
    (type) => EXTENSION_EVENT_VISIBILITY[type] === "observable"
  ) as ObservableExtensionEvent[];
}

/**
 * Observer handler. The payload is the **same object** every in-scope consumer receives (the session
 * channel projection, the event→entry consumer), so it MUST be treated as read-only: mutating it
 * mutates live state.
 */
export type ExtensionEventObserver<T extends ObservableExtensionEvent = ObservableExtensionEvent> = (
  event: AgentEvent<T>,
  /** Live extension context for this dispatch; absent on a standalone observer surface. */
  ctx?: ExtensionContext
) => void | Promise<void>;

export interface ExtensionObserverOptions {
  /**
   * For a retained event, deliver the current value once, synchronously, at subscription time.
   * Defaults to `true` for `observe` and `false` for `observeAny` (a broad subscriber must not be
   * hit with a burst of snapshots).
   */
  replay?: boolean;
}

/**
 * Observation half of the extension event surface. `ExtensionContext.events` carries this alongside
 * the interception facade.
 *
 * Failure containment: a synchronous throw is contained by the observer dispatch mode (other
 * observers still run), and a returned rejected promise is caught here and reported as
 * `agent:extension-error` with phase `event-observer`, so an observer can never abort a run.
 */
export interface ExtensionObserverSurface {
  /** Subscribe to one observable event. Returns a disposer. */
  observe<T extends ObservableExtensionEvent>(
    type: T,
    handler: ExtensionEventObserver<T>,
    options?: ExtensionObserverOptions
  ): () => void;
  /** Subscribe to every observable event. Returns a disposer. */
  observeAny(handler: ExtensionEventObserver, options?: ExtensionObserverOptions): () => void;
  /** Current retained value of an observable event, or `undefined` when none. */
  retained<T extends ObservableExtensionEvent>(type: T): AgentEvents[T] | undefined;
}
