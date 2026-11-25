/**
 * The marker that lets a host see a turn which has no user message.
 *
 * A background completion wakes an idle session into a real turn — own `runId`, own turn boundaries,
 * own `turn:summary` — but nothing in the transcript says so: the last message is still the previous
 * turn's ANSWER (the wake is driven by the model reading the background-notification context block
 * the middleware injects, not by anything the user typed).
 *
 * Hosts that group a stream into turns by user message are therefore blind to it. ACP is the concrete
 * case: its `messageId` is "one id per turn" and a user message is what opens one, so the wake's
 * output shared the previous turn's id — appended to the answer the client had already rendered, and
 * never a new (visibly running) turn on that side. The app was unaffected because it reads the status
 * snapshot instead of grouping.
 *
 * The mark is a fact about the message, not about the client: `metadata.turnStart` is persisted with
 * the transcript (a reload replays the same grouping) and ignored by the model wire.
 */

import type { UIMessage } from "@tanstack/ai";

/**
 * Mark the first assistant message this run materialized, or `null` when there is none yet.
 *
 * `historicalIds` is the run-start snapshot: the previous turn's answer is still the last message
 * until this run produces its own (a `RUN_STARTED` chunk produces none), and stamping that answer
 * would open the new turn at the wrong place. Pure and copy-on-write: the caller owns the array.
 */
export function withTurnStartMark(
  messages: readonly UIMessage[],
  historicalIds: ReadonlySet<string>
): UIMessage[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "assistant") continue;
    if (historicalIds.has(message.id)) continue;
    const next = [...messages];
    next[i] = { ...message, metadata: { ...(message.metadata ?? {}), turnStart: true } };
    return next;
  }
  return null;
}
