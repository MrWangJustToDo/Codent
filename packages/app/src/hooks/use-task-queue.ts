/**
 * The pre-fork queue: `task` calls waiting for a concurrency slot.
 *
 * Core publishes the whole queue on every admission and discard (`subagent:queue`, a full
 * SNAPSHOT on the `lifecycle` channel) because a waiting task is otherwise invisible: it has no
 * subagent yet, so it appears in neither `snapshot.subagents` nor `agent:tool-start`, and its
 * transcript row would have nothing to say about why it has not started.
 *
 * The snapshot is replaced, never merged — that is what makes a dropped, duplicated or re-ordered
 * event harmless, and what keeps this hook free of any per-task bookkeeping.
 *
 * Not retained (an `emit` event, not a channel value): a remount mid-turn starts with an empty
 * queue and re-fills on the next transition. The row falls back to its own label, so the worst case
 * is a row that does not mention the wait.
 */

import { useEffect, useState } from "react";
import { toRaw } from "reactivity-store";

import { useAgent } from "./use-agent.js";

export interface QueuedTask {
  toolCallId: string;
  /** The task's own label, when core knows it (`description` from the tool input). */
  description?: string;
}

/**
 * Narrow one `subagent:queue` payload, tolerating a host that omits a field.
 *
 * Only the queue membership is read: occupancy counts were deliberately left out of the payload
 * (a waiting entry *because* the cap is full says nothing with `n/m`, and the cap moves), so there
 * is nothing else to read.
 */
function readQueued(payload: Record<string, unknown>): QueuedTask[] {
  if (!Array.isArray(payload.queued)) return [];
  return payload.queued.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { toolCallId, description } = entry as { toolCallId?: unknown; description?: unknown };
    if (typeof toolCallId !== "string") return [];
    return [{ toolCallId, ...(typeof description === "string" ? { description } : {}) }];
  });
}

export const useTaskQueue = (): QueuedTask[] => {
  const session = toRaw(useAgent((s) => s.session));
  const [queue, setQueue] = useState<QueuedTask[]>([]);

  useEffect(() => {
    // A different session's queue has nothing to do with this one's rows.
    setQueue([]);
    if (!session) return;

    return session.subscribe(
      (event) => {
        if (event.channel !== "lifecycle") return;
        if (event.payload.type !== "subagent:queue") return;
        setQueue(readQueued(event.payload as unknown as Record<string, unknown>));
      },
      { channels: ["lifecycle"] }
    );
  }, [session]);

  return queue;
};
