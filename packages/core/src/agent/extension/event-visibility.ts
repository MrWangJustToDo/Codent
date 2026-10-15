/**
 * Which events the extension observation surface exposes — the **read side** of the bus, as a
 * declaration rather than an implementation.
 *
 * Split out of `types.ts` (which hit the file-size limit) because this table is the one place a new
 * agent event must be classified, and it is consulted by three consumers that have nothing else in
 * common: the extension facade (`observeAny` expands the observable set), the bus (wildcard delivery
 * withholds internal events), and the validators that hold the two to each other.
 *
 * The exhaustiveness check is the point: `satisfies Record<AgentEventType, ExtensionEventVisibility>`
 * means a new event breaks compilation here until it is classified, so it can neither become
 * observable by accident nor be silently missing from `observeAny`.
 */

import type { AgentEvent, AgentEventType, AgentEvents } from "../agent-event-bus/types.js";

/**
 * Visibility of one observer event to extensions.
 *
 * - `observable` — an extension may subscribe to it or read its retained value.
 * - `internal` — deliberately withheld; the reason is recorded next to the row.
 */
export type ExtensionEventVisibility = "observable" | "internal";

/**
 * The observable set, exhaustively keyed by `AgentEventType`.
 *
 * The default is `observable`; an `internal` row must state why, so a blanket hide cannot creep in.
 */
export const EXTENSION_EVENT_VISIBILITY = {
  // Session lifecycle
  "session:start": "observable",
  "session:new": "observable",
  "session:doc": "observable",
  "session:skill": "observable",
  "session:mcp": "observable",
  "session:memory": "observable",
  "session:restore": "observable",
  "session:switch": "observable",
  "session:save-error": "observable",
  // Turn lifecycle
  "prompt:submit": "observable",
  "prompt:before": "observable",
  "turn:summary": "observable",
  // Agent lifecycle / tools / approvals
  "agent:thinking": "observable",
  "agent:tool-start": "observable",
  "agent:tool-approval-request": "observable",
  "agent:tool-approval-resolved": "observable",
  "agent:tool-end": "observable",
  "agent:tool-error": "observable",
  "agent:abort": "observable",
  "agent:retry": "observable",
  "agent:stream-error": "observable",
  "agent:stop": "observable",
  "agent:extension-error": "observable",
  // Memory
  "memory:prefetch": "observable",
  "memory:extract": "observable",
  "memory:consolidate": "observable",
  // LLM
  "llm:request": "observable",
  "llm:response": "observable",
  // Compaction
  "compaction:auto-start": "observable",
  "compaction:auto-complete": "observable",
  "compaction:auto-error": "observable",
  "compaction:reactive-start": "observable",
  "compaction:reactive-complete": "observable",
  "compaction:reactive-error": "observable",
  "compaction:reactive-max-retries": "observable",
  // Subagents
  "subagent:created": "observable",
  "subagent:queue": "observable",
  "subagent:started": "observable",
  "subagent:prefork-discarded": "observable",
  "subagent:completed": "observable",
  "subagent:error": "observable",
  "subagent:destroyed": "observable",
  "subagent:phase": "observable",
  "subagent:progress-summary-error": "observable",
  // Plan mode
  "plan:enter": "observable",
  "plan:ready": "observable",
  "plan:execute": "observable",
  "plan:cancel-execution": "observable",
  "plan:todo-replaced": "observable",
  "plan:retro": "observable",
  "plan:complete": "observable",
  "plan:exit": "observable",
  // Session channel projection
  "agent:state": "observable",
  "session:messages": "observable",
  "session:queues": "observable",
  "session:usage": "observable",
  "session:todos": "observable",
  "session:plan": "observable",
  "session:summary": "observable",
  "session:mode": "observable",
  "session:extensions": "observable",
  "session:tool-presentation": "observable",
  "session:interaction": "observable",
  "agent:iteration": "observable",
  "session:jobs": "observable",
  // Deliberately withheld (each needs a reason).
  // token-by-token streaming already has a dedicated UI path; observing it invites
  // per-chunk extension work on the hot path.
  "tool:chunk": "internal",
  "tool:clear": "internal",
  // the extension-UI channel is how extensions publish to the host; making it
  // observable would couple unrelated extensions through each other's output.
  "extension:ui": "internal",
} as const satisfies Record<AgentEventType, ExtensionEventVisibility>;

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
 * ⚠️ An `internal` event MUST NOT carry an event→entry rule (`DEFAULT_EVENT_LOG_RULES`): the
 * wildcard subscriber is what turns events into log entries, and wildcard delivery withholds
 * internal events, so such a rule can never run. It reads as though the event is logged while the
 * event silently never appears — asserted in `validate-extension-event-observation` §7b.
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
  event: AgentEvent<T>
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
