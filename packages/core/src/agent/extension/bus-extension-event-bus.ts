/**
 * {@link ExtensionEventBus} backed by the unified {@link AgentEventBus}.
 *
 * Interception (async, ordered, shared mutable event, cancel short-circuit) is delegated
 * to the unified bus's `intercept` mode; hook names are unchanged. Kept in its own module
 * because it is a pure adapter: it owns the handler→disposer map and nothing else about
 * the extension runner.
 */

import type { AgentEventBus } from "../agent-event-bus";
import type { DispatchRank } from "../dispatch-order.js";
import type { EventInterceptor, ExtensionEventBus, InterceptableEvent } from "./types.js";

export class BusExtensionEventBus implements ExtensionEventBus {
  /**
   * Disposer per (type, handler).
   *
   * Keyed by handler alone, `off(typeB, h)` after `on(typeA, h)` removed typeA's registration and
   * left typeB's live — and the per-dispatch wrapper the runner memoizes made that collision the
   * normal case rather than a corner one.
   */
  private readonly disposers = new Map<string, Map<EventInterceptor<InterceptableEvent>, () => void>>();

  constructor(private readonly bus: AgentEventBus) {}

  async emit<T extends InterceptableEvent>(event: T): Promise<T["defaultReturn"] | undefined> {
    return this.bus.intercept(event);
  }

  on<T extends InterceptableEvent>(type: string, handler: EventInterceptor<T>, rank?: DispatchRank): () => void {
    const key = handler as EventInterceptor<InterceptableEvent>;
    const unsub = this.bus.onIntercept(type, handler, rank);
    const byHandler = this.disposers.get(type) ?? new Map();
    byHandler.set(key, unsub);
    this.disposers.set(type, byHandler);
    return () => {
      const current = this.disposers.get(type);
      if (current?.get(key) === unsub) current.delete(key);
      if (current?.size === 0) this.disposers.delete(type);
      unsub();
    };
  }

  off<T extends InterceptableEvent>(type: string, handler: EventInterceptor<T>): void {
    const key = handler as EventInterceptor<InterceptableEvent>;
    const unsub = this.disposers.get(type)?.get(key);
    if (unsub) {
      this.disposers.get(type)!.delete(key);
      if (this.disposers.get(type)!.size === 0) this.disposers.delete(type);
      unsub();
    }
  }
}
