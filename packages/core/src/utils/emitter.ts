/**
 * Typed multicast event emitter for domain state notifications.
 *
 * Prefer composition: `private readonly events = new Emitter<{ change: T }>()`.
 */

import { deliverContained } from "./contained-report.js";

export type EmitterListener<T> = (payload: T) => void;

export class Emitter<TEvents extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof TEvents & string, Set<EmitterListener<unknown>>>();

  /**
   * Subscribe to an event type. Returns an idempotent unsubscribe function.
   */
  on<K extends keyof TEvents & string>(type: K, listener: EmitterListener<TEvents[K]>): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    // One wrapper per registration: storing the listener function itself collapsed two subscribers
    // sharing a callback into one entry, so the first disposer cancelled both.
    const wrapped = ((payload: unknown) => listener(payload as TEvents[K])) as EmitterListener<unknown>;
    set.add(wrapped);
    return () => {
      set!.delete(wrapped);
      // Identity check: a disposer called twice (or after the type was re-subscribed) must not
      // delete a NEW listener set that now owns the entry.
      if (this.listeners.get(type) === set && set!.size === 0) {
        this.listeners.delete(type);
      }
    };
  }

  /**
   * Emit an event to current subscribers. A listener error does not stop delivery (one faulty
   * subscriber must not cost the others their frame); it is handed to `onListenerError` so the
   * seam's owner can report it instead of losing it.
   */
  emit<K extends keyof TEvents & string>(
    type: K,
    payload: TEvents[K],
    onListenerError?: (error: unknown) => void
  ): void {
    const set = this.listeners.get(type);
    if (!set || set.size === 0) return;
    for (const listener of [...set]) {
      // A subscriber typed `void` may still be async (the server's SSE writer is): the shared
      // delivery helper catches both the synchronous throw and the rejection, which Node's default
      // policy would otherwise turn into process exit.
      deliverContained(listener as (value: TEvents[K]) => unknown, [payload], onListenerError);
    }
  }

  /** Number of listeners for `type`, or total if omitted. */
  listenerCount(type?: keyof TEvents & string): number {
    if (type !== undefined) {
      return this.listeners.get(type)?.size ?? 0;
    }
    let total = 0;
    for (const set of this.listeners.values()) {
      total += set.size;
    }
    return total;
  }
}
