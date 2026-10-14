/**
 * Per-key trailing flush scheduler for summary streams (compact / task).
 *
 * Accumulates append chunks per summary-stream key and flushes them to the consumer once
 * per throttle window, via the shared {@link createTrailingScheduler}. Consumers keep
 * their own state and pass a flush callback that receives the accumulated text.
 */

import { createTrailingScheduler } from "./trailing-throttle.js";

interface SummaryBuffer {
  text: string;
}

/** Default throttle window for summary-stream appends. */
export const SUMMARY_STREAM_THROTTLE_MS = 50;

const buffers = new Map<string, SummaryBuffer>();
const scheduler = createTrailingScheduler();

/**
 * Accumulate `chunk` for `key` and schedule a single trailing flush.
 * The flush callback receives the accumulated text since the last flush.
 */
export function scheduleSummaryFlush(
  key: string,
  chunk: string,
  flush: (accumulated: string) => void,
  throttleMs: number = SUMMARY_STREAM_THROTTLE_MS
): void {
  let buffer = buffers.get(key);
  if (!buffer) {
    buffer = { text: "" };
    buffers.set(key, buffer);
  }

  buffer.text += chunk;

  scheduler.schedule(key, throttleMs, () => {
    const pending = buffers.get(key);
    if (!pending) return;
    buffers.delete(key);
    flush(pending.text);
  });
}

/** Cancel any pending flush for `key` (e.g. on reset, key change, or unmount). */
export function cancelSummaryBuffer(key: string): void {
  scheduler.cancel(key);
  buffers.delete(key);
}

/**
 * Synchronously flush any buffered text for `key` (e.g. on stream `end`, so
 * trailing chunks are not lost). No-op when there is nothing buffered.
 */
export function flushSummaryBuffer(key: string, flush: (accumulated: string) => void): void {
  const buffer = buffers.get(key);
  if (!buffer || buffer.text.length === 0) return;
  scheduler.cancel(key);
  const accumulated = buffer.text;
  buffers.delete(key);
  flush(accumulated);
}
