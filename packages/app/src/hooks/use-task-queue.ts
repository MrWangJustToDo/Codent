/**
 * The pre-fork queue: `task` calls waiting for a concurrency slot.
 *
 * Core publishes the whole queue on every admission and discard as the `queued` field of the
 * retained `subagents` snapshot, because a waiting task is otherwise invisible: it has no subagent
 * yet, so it is not a row and has no `agent:tool-start`, and its transcript row would have nothing to
 * say about why it has not started. It used to be its own retained event on the append-only
 * `lifecycle` channel, which is the slot that channel can no longer use for a lifecycle fact.
 *
 * The snapshot is replaced, never merged — that is what makes a dropped, duplicated or re-ordered
 * event harmless, and what keeps this hook free of any per-task bookkeeping.
 *
 * Retained: a remount/subscription receives the current snapshot, and every mutation still emits a
 * full one. A late subscriber no longer starts empty.
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
 * Narrow one `session:subagents` payload (`{ subagents, queued }`), tolerating a host that omits a field.
 *
 * Only the queue membership is read: occupancy counts were deliberately left out of the payload
 * (a waiting entry *because* the cap is full says nothing with `n/m`, and the cap moves), so there
 * is nothing else to read.
 */
function readQueued(payload: { queued?: unknown }): QueuedTask[] {
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
        // The `subagents` channel is the typed snapshot (`{ subagents, queued }`), so no envelope
        // unwrapping is needed. A remote client only `JSON.parse`s a block, so `readQueued` still
        // tolerates a malformed payload.
        if (event.channel !== "subagents") return;
        setQueue(readQueued(event.payload as { queued?: unknown }));
      },
      { channels: ["subagents"] }
    );
  }, [session]);

  return queue;
};
