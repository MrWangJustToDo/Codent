/**
 * Typed multicast event emitter for domain state notifications.
 *
 * Prefer composition: `private readonly events = new Emitter<{ change: T }>()`.
 */

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
    const wrapped = listener as EmitterListener<unknown>;
    set.add(wrapped);
    return () => {
      set!.delete(wrapped);
      if (set!.size === 0) {
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
      try {
        listener(payload);
      } catch (error) {
        onListenerError?.(error);
      }
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
