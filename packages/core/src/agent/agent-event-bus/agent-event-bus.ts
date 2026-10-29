import { reportContained } from "../../utils/contained-report.js";
import { Emitter } from "../../utils/emitter.js";
import { compareDispatchRank, resolveExtensionOrder } from "../dispatch-order.js";
import { INTERNAL_EXTENSION_EVENTS } from "../extension/event-visibility.js";

import type {
  AgentEvent,
  AgentEventBus,
  AgentEventListener,
  AgentEventMetaInput,
  AgentEventType,
  AgentEventWildcardListener,
  EventInterceptor,
  InterceptableEvent,
} from "./types.js";
import type { DispatchRank } from "../dispatch-order.js";

// ============================================================================
// Scope node
// ============================================================================

/**
 * One node in the scope tree. Observer fan-out uses a per-node {@link Emitter}
 * (the synchronous multicast primitive); an event emitted at a node is delivered
 * to that node and every ancestor (so the root observes all, siblings stay
 * isolated, and subagent scopes up-flow to their parent).
 */
class EventBusScopeNode {
  readonly observers = new Emitter<Record<string, AgentEvent>>();
  readonly wildcards = new Set<AgentEventWildcardListener>();
  /**
   * Interceptors in **dispatch order** (declared order, then load sequence) — kept sorted on
   * mutation so the hot `intercept` walk stays a plain array scan. A registration that declares
   * no order carries the default, which preserves insertion sequence via the tie-break.
   */
  readonly interceptors: Array<{
    pattern: string;
    handler: EventInterceptor<InterceptableEvent>;
    rank: DispatchRank;
    /** Cleared by the disposer; a snapshot taken before an await must not run a removed entry. */
    active: boolean;
  }> = [];
  readonly retained = new Map<string, () => unknown>();

  constructor(
    readonly id: string,
    readonly parent: EventBusScopeNode | null
  ) {}
}

// ============================================================================
// Helpers
// ============================================================================

/** Match an interceptor key against a concrete event name (`prefix:*` supported). */
function interceptorMatches(pattern: string, name: string): boolean {
  if (pattern === name) return true;
  if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
  return false;
}

// ============================================================================
// DefaultAgentEventBus
// ============================================================================

/**
 * Unified event bus implementation. One registry, two dispatch modes:
 * - observer `emit` / `on` (synchronous, error-isolated, retained replay);
 * - interceptor `intercept` / `onIntercept` (async, ordered, shared mutable
 *   event, cancel short-circuit).
 */
export class DefaultAgentEventBus implements AgentEventBus {
  constructor(
    private readonly node: EventBusScopeNode,
    /**
     * Reports an interceptor that threw. Interceptors are the channel third-party
     * extensions write most, so an exception there must not fail the tool call or
     * turn it wraps — but silently swallowing it hides a broken extension. The
     * host wires this to its log; without it the failure is only counted.
     */
    private readonly onInterceptorError?: (info: {
      pattern: string;
      event: string;
      /** Scope the interceptor was registered on (an agent id for scoped buses). */
      scopeId: string;
      error: unknown;
      /** Which dispatch mode failed. Absent means interceptor (the original caller shape). */
      kind?: "interceptor" | "observer";
    }) => void
  ) {}

  get scopeId(): string {
    return this.node.id;
  }

  // --------------------------------------------------------------------------
  // Observer mode
  // --------------------------------------------------------------------------

  on<T extends AgentEventType>(type: T, listener: AgentEventListener<T>, options?: { replay?: boolean }): () => void;
  on(type: "*", listener: AgentEventWildcardListener): () => void;
  on(
    type: AgentEventType | "*",
    listener: AgentEventListener | AgentEventWildcardListener,
    options?: { replay?: boolean; includeParents?: boolean }
  ): () => void {
    if (type === "*") {
      const wildcard = listener as AgentEventWildcardListener;
      this.node.wildcards.add(wildcard);
      return () => {
        this.node.wildcards.delete(wildcard);
      };
    }

    const typed = listener as AgentEventListener;
    const unsub = this.node.observers.on(type, typed);

    // Retained replay: late subscribers synchronously receive the current value.
    // Callers that reconcile retained values themselves opt out via `replay:false`.
    if (options?.replay !== false) {
      const retained = this.findRetained(type, options?.includeParents === true);
      if (retained) {
        // Two independent failure sources, two different owners: a throwing PROVIDER belongs to the
        // node that holds the value (an `includeParents` replay carries a parent's payload), while a
        // throwing LISTENER belongs to this node — `scopeId` is what routes the report to a log.
        let payload: unknown;
        try {
          payload = retained.provider();
        } catch (error) {
          reportContained(() =>
            this.onInterceptorError?.({
              pattern: type,
              event: type,
              scopeId: retained.node.id,
              error,
              kind: "observer",
            })
          );
          return unsub;
        }
        try {
          const event = this.buildEventAt(retained.node, type, payload as never);
          const result = (typed as (value: AgentEvent) => unknown)(event);
          if (result && typeof (result as PromiseLike<unknown>).then === "function") {
            void Promise.resolve(result).catch((error) =>
              reportContained(() =>
                this.onInterceptorError?.({
                  pattern: type,
                  event: type,
                  scopeId: this.node.id,
                  error,
                  kind: "observer",
                })
              )
            );
          }
        } catch (error) {
          // A retained replay is still a listener notification. Without this guard a throwing
          // handler escaped `on()` AFTER the subscription was registered, so the caller never
          // received a disposer and leaked the listener.
          reportContained(() =>
            this.onInterceptorError?.({
              pattern: type,
              event: type,
              scopeId: this.node.id,
              error,
              kind: "observer",
            })
          );
        }
      }
    }

    return unsub;
  }

  retainedValue<T extends AgentEventType>(
    type: T,
    options?: { includeParents?: boolean }
  ): AgentEvent<T>["payload"] | undefined {
    const retained = this.findRetained(type, options?.includeParents === true);
    if (!retained) return undefined;
    try {
      return retained.provider() as AgentEvent<T>["payload"];
    } catch (error) {
      // Same containment as the `on()` replay: this is a user-facing read, and one faulty provider
      // must not turn `subscribe()` (which reconciles retained values) into a failed subscription.
      reportContained(() =>
        this.onInterceptorError?.({ pattern: type, event: type, scopeId: retained.node.id, error, kind: "observer" })
      );
      return undefined;
    }
  }

  emit<T extends AgentEventType>(type: T, payload: AgentEvent<T>["payload"], meta?: AgentEventMetaInput): void {
    const event = this.buildEvent(type, payload, meta) as AgentEvent;
    // Internal events are withheld from the wildcard fan-out: "internal" means "the caller must not
    // observe this", and wildcard delivery is an observation path, so the exclusion is applied
    // here rather than left to each subscriber's discipline. It also makes wildcard delivery equal
    // to `observeAny` (already "wildcard over the observable set") by construction. Typed observers
    // still receive internal events, so "internal" narrows *how* an event is consumed, never
    // whether it is emitted.
    const deliverToWildcards = !INTERNAL_EXTENSION_EVENTS.has(type);
    for (let node: EventBusScopeNode | null = this.node; node; node = node.parent) {
      // A live observer gets the same containment as a retained replay (see `on()`): one broken
      // subscriber loses its frame, not the notification, and the failure is reported instead of
      // vanishing in `Emitter`'s catch. Silence here was the worst case to debug — a projector or
      // log sink failing on every live frame with no diagnostic at all.
      node.observers.emit(type, event, (error) =>
        reportContained(() =>
          this.onInterceptorError?.({ pattern: type, event: type, scopeId: node.id, error, kind: "observer" })
        )
      );
      if (!deliverToWildcards) continue;
      for (const listener of [...node.wildcards]) {
        try {
          // A wildcard listener typed `void` may still be async (`agentManager.on("*", …)` is a
          // public entry). Its rejection is not caught here, so attach a handler like `Emitter`.
          const result = (listener as (value: AgentEvent) => unknown)(event);
          if (result && typeof (result as PromiseLike<unknown>).then === "function") {
            void Promise.resolve(result).catch((error) =>
              reportContained(() =>
                this.onInterceptorError?.({ pattern: "*", event: type, scopeId: node.id, error, kind: "observer" })
              )
            );
          }
        } catch (error) {
          reportContained(() =>
            this.onInterceptorError?.({ pattern: "*", event: type, scopeId: node.id, error, kind: "observer" })
          );
        }
      }
    }
  }

  retain<T extends AgentEventType>(type: T, provider: () => AgentEvent<T>["payload"]): () => void {
    const stored = provider as () => unknown;
    this.node.retained.set(type, stored);
    return () => {
      // Only clear if this node still owns the same provider.
      if (this.node.retained.get(type) === stored) this.node.retained.delete(type);
    };
  }

  scope(id: string): AgentEventBus {
    // Child scopes share the parent's error sink: a scoped bus is the same bus
    // with a narrower view, not a separate pipeline.
    return new DefaultAgentEventBus(new EventBusScopeNode(id, this.node), this.onInterceptorError);
  }

  // --------------------------------------------------------------------------
  // Interceptor mode
  // --------------------------------------------------------------------------

  async intercept<T extends InterceptableEvent>(event: T): Promise<T["defaultReturn"] | undefined> {
    for (let node: EventBusScopeNode | null = this.node; node; node = node.parent) {
      // Snapshot: `node.interceptors` is mutated by onIntercept()/its disposer, and this loop
      // awaits between entries. Iterating the live array let an interceptor registered during
      // dispatch run twice and one unregistered during dispatch shift indices (skipping a later
      // interceptor, including one that would have cancelled).
      for (const registration of [...node.interceptors]) {
        // The disposer may have run while a previous interceptor was awaiting: the snapshot keeps
        // the entry alive, but it is no longer registered.
        if (!registration.active) continue;
        if (!interceptorMatches(registration.pattern, event.type)) continue;
        // Isolated like the observer wildcards: a throwing interceptor must not
        // propagate into the tool call it wraps (one broken extension would fail
        // every tool it touches). The observer/transformer/context-provider
        // channels are already isolated — this one is the most-written and was
        // the only one that was not.
        let result: unknown;
        try {
          result = await registration.handler(event as InterceptableEvent);
        } catch (error) {
          reportContained(() =>
            this.onInterceptorError?.({ pattern: registration.pattern, event: event.type, scopeId: node.id, error })
          );
          continue;
        }
        // `cancel` = return false or set `skipDefault`; stop the chain.
        if (result === false || (event as { skipDefault?: boolean }).skipDefault) {
          return undefined;
        }
      }
    }
    return (event as { defaultReturn?: T["defaultReturn"] }).defaultReturn;
  }

  onIntercept<T extends InterceptableEvent>(
    pattern: string,
    handler: EventInterceptor<T>,
    rank?: DispatchRank
  ): () => void {
    const registration = {
      pattern,
      handler: handler as EventInterceptor<InterceptableEvent>,
      // Default when the caller supplies none (a non-extension interceptor): order 0, and a
      // sequence past every explicit one so insertion order is preserved as before.
      rank: rank ?? { order: resolveExtensionOrder(undefined), seq: Number.MAX_SAFE_INTEGER },
      active: true,
    };
    const list = this.node.interceptors;
    list.push(registration);
    // Sorted on mutation, not on dispatch: `intercept` runs on every tool call and must keep
    // walking a plain array. Ties keep insertion order via the rank's sequence tie-break.
    list.sort((a, b) => compareDispatchRank(a.rank, b.rank));
    return () => {
      registration.active = false;
      const index = list.indexOf(registration);
      if (index >= 0) list.splice(index, 1);
    };
  }

  hasInterceptors(name: string): boolean {
    for (let node: EventBusScopeNode | null = this.node; node; node = node.parent) {
      if (node.interceptors.some((registration) => interceptorMatches(registration.pattern, name))) {
        return true;
      }
    }
    return false;
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private buildEvent<T extends AgentEventType>(
    type: T,
    payload: AgentEvent<T>["payload"],
    meta?: AgentEventMetaInput
  ): AgentEvent<T> {
    return this.buildEventAt(this.node, type, payload, meta);
  }

  /** Build an event in the scope of `node` (its `agentId`/`parentId`, not the caller's). */
  private buildEventAt<T extends AgentEventType>(
    node: EventBusScopeNode,
    type: T,
    payload: AgentEvent<T>["payload"],
    meta?: AgentEventMetaInput
  ): AgentEvent<T> {
    // A scope under another AGENT is a child scope; a scope under the synthetic root node is a root
    // agent (`AgentEventBusScope.of` scopes parent-less agents directly on the root bus). Deriving
    // it here is what makes EVERY emitter carry the parent — including the domain objects that
    // emit straight on the bus (`usage` / `todo` / `ui` / `stream-hub` / `plan`), which used to
    // produce child events with only `agentId`.
    const parentNode = node.parent;
    const parentId = meta?.parentId ?? (parentNode && parentNode.parent !== null ? parentNode.id : undefined);
    return {
      type,
      ts: Date.now(),
      agentId: meta?.agentId ?? node.id,
      ...(parentId !== undefined ? { parentId } : {}),
      ...(meta?.sessionId !== undefined ? { sessionId: meta.sessionId } : {}),
      payload,
    } as AgentEvent<T>;
  }

  /**
   * Nearest retained provider for `type`, with the node that owns it.
   *
   * The owner matters for `includeParents` replay: the event must be stamped with the scope the
   * value came from, not the subscriber's.
   */
  private findRetained(
    type: string,
    includeParents = false
  ): { node: EventBusScopeNode; provider: () => unknown } | undefined {
    for (let node: EventBusScopeNode | null = this.node; node; node = includeParents ? node.parent : null) {
      const provider = node.retained.get(type);
      if (provider) return { node, provider };
    }
    return undefined;
  }
}

/** Create a root event bus (no parent scope). */
export function createAgentEventBus(
  id = "root",
  onInterceptorError?: (info: {
    pattern: string;
    event: string;
    scopeId: string;
    error: unknown;
    kind?: "interceptor" | "observer";
  }) => void
): AgentEventBus {
  return new DefaultAgentEventBus(new EventBusScopeNode(id, null), onInterceptorError);
}
