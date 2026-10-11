/**
 * {@link ExtensionEventBus} backed by the unified {@link AgentEventBus}.
 *
 * Interception (async, ordered, shared mutable event, cancel short-circuit) is delegated
 * to the unified bus's `intercept` mode; hook names are unchanged. Kept in its own module
 * because it is a pure adapter: it owns the handler→disposer map and nothing else about
 * the extension runner.
 */

import type { AgentEventBus } from "../agent-event-bus";
import type { DispatchRank } from "./dispatch-order.js";
import type { EventInterceptor, ExtensionEventBus, InterceptableEvent } from "./types.js";

export class BusExtensionEventBus implements ExtensionEventBus {
  private readonly disposers = new Map<EventInterceptor<InterceptableEvent>, () => void>();

  constructor(private readonly bus: AgentEventBus) {}

  async emit<T extends InterceptableEvent>(event: T): Promise<T["defaultReturn"] | undefined> {
    return this.bus.intercept(event);
  }

  on<T extends InterceptableEvent>(type: string, handler: EventInterceptor<T>, rank?: DispatchRank): () => void {
    const key = handler as EventInterceptor<InterceptableEvent>;
    const unsub = this.bus.onIntercept(type, handler, rank);
    this.disposers.set(key, unsub);
    return () => {
      this.disposers.delete(key);
      unsub();
    };
  }

  off<T extends InterceptableEvent>(type: string, handler: EventInterceptor<T>): void {
    void type;
    const key = handler as EventInterceptor<InterceptableEvent>;
    const unsub = this.disposers.get(key);
    if (unsub) {
      this.disposers.delete(key);
      unsub();
    }
  }
}
