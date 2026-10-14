/**
 * Trailing-edge throttle scheduler, keyed by string.
 *
 * The summary-stream flusher and the tool-output ingester both accumulate chunks per key
 * and flush once per window on the trailing edge. The window mechanics live here; each
 * caller keeps its own buffer and supplies the flush callback.
 *
 * The key space is per-scheduler (each caller creates its own via
 * {@link createTrailingScheduler}), so a tool call id and a summary-stream key can never
 * collide.
 */

export interface TrailingScheduler {
  /**
   * Run `flush` once per `throttleMs` window on the trailing edge. Repeated calls for the
   * same key within the window coalesce into one flush; `throttleMs <= 0` flushes
   * synchronously on every call.
   */
  schedule(key: string, throttleMs: number, flush: () => void): void;
  /** Drop any pending flush for `key` without running it. */
  cancel(key: string): void;
}

export function createTrailingScheduler(): TrailingScheduler {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  return {
    schedule(key, throttleMs, flush) {
      if (timers.has(key)) return;
      if (throttleMs <= 0) {
        flush();
        return;
      }
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          flush();
        }, throttleMs)
      );
    },

    cancel(key) {
      const timer = timers.get(key);
      if (timer) clearTimeout(timer);
      timers.delete(key);
    },
  };
}
