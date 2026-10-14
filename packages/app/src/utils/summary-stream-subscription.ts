/**
 * Summary-stream subscription plumbing (task / compact), in one place.
 *
 * Both stream previews subscribe to the session's `summary` channel for a single key and
 * share the same mechanics: channel + key filter, throttled append batching, snapshot
 * seeding for remount, and buffer cleanup on teardown. Only the reducer differs — the task
 * view renders a bounded line window, the compact banner accumulates raw text — so that
 * stays at the call site.
 */

import { cancelSummaryBuffer, flushSummaryBuffer, scheduleSummaryFlush } from "./summary-stream-throttle.js";

import type { AgentSession, SummaryStreamEvent, SummaryStreamSnapshot } from "@codent/core";

/** A reset event (carries the optional phase `label`). */
export type SummaryStreamResetEvent = Extract<SummaryStreamEvent, { type: "reset" }>;

export interface SummaryStreamHandlers {
  /** A reset arrived — clear prior state (the buffer is already cancelled). */
  onReset: (event: SummaryStreamResetEvent) => void;
  /** A batch of appended text (throttled), or the synchronous `end` flush. */
  onAppend: (accumulated: string) => void;
  /** The stream ended (after the trailing flush). */
  onEnd: () => void;
  /** Called once after subscribing with the current snapshot, or `null` when none exists. */
  onSnapshot: (snapshot: SummaryStreamSnapshot | null) => void;
}

/**
 * Subscribe to one keyed summary stream on `session`.
 *
 * @returns the disposer (cancels the pending buffer and unsubscribes).
 */
export function subscribeSummaryStream(
  session: AgentSession,
  key: string,
  handlers: SummaryStreamHandlers
): () => void {
  const applyEvent = (event: SummaryStreamEvent) => {
    if (event.key !== key) return;
    if (event.type === "reset") {
      cancelSummaryBuffer(key);
      handlers.onReset(event);
      return;
    }
    if (event.type === "append") {
      scheduleSummaryFlush(key, event.chunk, handlers.onAppend);
      return;
    }
    flushSummaryBuffer(key, handlers.onAppend);
    handlers.onEnd();
  };

  const unsubscribe = session.subscribe(
    (evt) => {
      if (evt.channel !== "summary") return;
      applyEvent(evt.payload as SummaryStreamEvent);
    },
    { channels: ["summary"] }
  );

  handlers.onSnapshot(session.getSummaryStreamSnapshot(key));

  return () => {
    cancelSummaryBuffer(key);
    unsubscribe();
  };
}
