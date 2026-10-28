/**
 * The remote session's event reducer: an SSE channel payload -> the cached snapshot.
 *
 * Extracted from `remote-session-client.ts` so the reducer reads as one unit and the client stays a
 * transport. It is EXHAUSTIVE by construction: the `default` branch assigns the event to `never`, so
 * adding a channel to `AGENT_SESSION_CHANNELS` without handling it fails to compile. The silent
 * `default: return snapshot` this replaced is what let a new snapshot field stop updating on the
 * remote path while the local projection stayed correct.
 */

import { AGENT_STREAM_SNAPSHOT_LINE_CAP } from "@codent/core";

import type { AgentSessionEvent, AgentSessionSnapshot, AgentStreamEvent, AgentStreamSnapshot } from "@codent/core";

export type ToolBufferMap = Map<string, { stdout: string; stderr: string }>;

function applySummaryEvent(cache: Map<string, AgentStreamSnapshot>, payload: unknown): void {
  const event = payload as AgentStreamEvent;
  if (!event?.key) return;

  if (event.type === "reset") {
    cache.set(event.key, {
      key: event.key,
      source: event.source,
      channel: event.channel,
      seq: event.seq,
      lines: [],
      pendingLine: "",
      status: "active",
      ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
      ...(event.compactId ? { compactId: event.compactId } : {}),
      ...(event.label ? { label: event.label } : {}),
      ...(event.epoch ? { epoch: event.epoch } : {}),
    });
    return;
  }

  let current = cache.get(event.key);
  if (!current) {
    // A task/compact row can mount after its `reset` (the first SSE subscription may skip a
    // resync when the snapshot is fresh). The append carries enough identity to reconstruct the
    // entry; dropping it loses the rest of the stream permanently.
    if (event.type !== "append") return;
    current = {
      key: event.key,
      source: event.source,
      channel: event.channel,
      ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
      seq: event.seq - 1,
      lines: [],
      pendingLine: "",
      status: "active",
    };
    cache.set(event.key, current);
  }
  if (event.seq <= current.seq) return;

  if (event.type === "append") {
    // A same-epoch append reopens an ended multi-pass stream; mirror the producer contract.
    current.status = "active";
    const text = current.pendingLine + event.chunk;
    const parts = text.split("\n");
    current.pendingLine = parts.pop() ?? "";
    current.lines = [...current.lines, ...(parts.length ? parts : [])].slice(-AGENT_STREAM_SNAPSHOT_LINE_CAP);
  } else if (event.type === "end") {
    if (current.pendingLine) {
      current.lines = [...current.lines, current.pendingLine].slice(-AGENT_STREAM_SNAPSHOT_LINE_CAP);
      current.pendingLine = "";
    }
    current.status = "ended";
  }
  current.seq = event.seq;
  cache.set(event.key, current);
}
function applyToolEvent(buffers: ToolBufferMap, payload: unknown): void {
  const event = payload as
    | { kind: "chunk"; chunk: { toolCallId: string; type: "stdout" | "stderr"; chunk: string } }
    | { kind: "clear"; toolCallId: string };
  if (!event?.kind) return;
  if (event.kind === "clear") {
    buffers.delete(event.toolCallId);
    return;
  }
  const entry = buffers.get(event.chunk.toolCallId) ?? { stdout: "", stderr: "" };
  entry[event.chunk.type] += event.chunk.chunk;
  buffers.set(event.chunk.toolCallId, entry);
}

export function applyEvent(
  snapshot: AgentSessionSnapshot,
  event: AgentSessionEvent,
  summaryCache: Map<string, AgentStreamSnapshot>,
  toolBuffers: ToolBufferMap
): AgentSessionSnapshot {
  switch (event.channel) {
    case "state":
      return {
        ...snapshot,
        status: event.payload.status,
        ...(event.payload.name !== undefined ? { name: event.payload.name } : {}),
        error: event.payload.error,
        pendingApprovalCount: event.payload.pendingApprovalCount,
        retry: event.payload.retry ?? undefined,
        // Model / effort travel on the retained state channel so a live switch
        // refreshes the cached snapshot (e.g. `/models` reads `modelInfo` to offer depths).
        model: event.payload.model,
        modelInfo: event.payload.modelInfo ?? undefined,
        reasoningEffort: event.payload.reasoningEffort ?? undefined,
        // The run duration is set at the END of a run, when no other channel fires, so it has to
        // ride this event. Without it the footer's "Completed in 1.2s" only appeared after an
        // unrelated full resync — `dispatch()` deliberately does not refetch the snapshot.
        lastStreamDurationMs: event.payload.lastStreamDurationMs,
        lastFinishReason: event.payload.lastFinishReason,
        // The finalized turn's iteration reading: `iteration` itself is reset at finalize, and the
        // stop reason is classified from the snapshot afterwards (ACP `max_turn_requests`).
        lastIteration: event.payload.lastIteration,
        // On-disk session identity (agent identity is the connection, not this). The snapshot
        // field is `activeSessionId`; writing `sessionId` here left every consumer reading the
        // value from the last full resync, so an in-place switch showed the old identity. A null
        // payload (no bound session) must clear it rather than retain the previous value.
        activeSessionId: event.payload.sessionId ?? undefined,
      };
    case "lifecycle": {
      // The envelope carries the emitting agent; for a child event that is the subagent id.
      const lifecycle = event.payload as {
        type?: string;
        agentId?: string;
        payload?: {
          subagentId?: string;
          description?: string;
          parentTaskToolCallId?: string;
          phase?: "running" | "summary" | "limit";
          cancelled?: boolean;
        };
      };
      const data = lifecycle.payload ?? {};
      const subagentId = data.subagentId ?? lifecycle.agentId;
      if (!lifecycle.type?.startsWith("subagent:") || !subagentId) return snapshot;

      /**
       * The row(s) a lifecycle event describes.
       *
       * The child's id is the normal key. When an event carries only its parent `task` call (some
       * lifecycle paths do), fall back to the row registered for that call — but only when it is
       * **unambiguous**. One `task` call can own a discarded pre-fork generation and the respawn
       * that replaced it, and writing a call-level phase onto every match is exactly the bug
       * `resolveSubagentRowDisplay` documents (the discarded generation read "limit reached").
       */
      const targetsFor = (allowTaskFallback: boolean): Set<string> | null => {
        if (snapshot.subagents.some((entry) => entry.id === subagentId)) return new Set([subagentId]);
        // A child-scoped event (`created`/`started`/`completed`/`error`) names its own child and
        // must never land on a sibling that merely shares the task call — that is how a respawn
        // overwrote the discarded generation's row. Only a call-scoped `phase` may fall back.
        if (!allowTaskFallback) return null;
        const taskId = data.parentTaskToolCallId;
        if (!taskId) return null;
        const byTask = snapshot.subagents.filter((entry) => entry.parentTaskToolCallId === taskId);
        return byTask.length === 1 ? new Set([byTask[0]!.id]) : null;
      };

      /**
       * Patch the resolved row, or create it for the two events that introduce a child.
       *
       * Only `created`/`started` may create a row: a `phase`/`completed`/`error` whose target
       * cannot be resolved is a call-scoped event with an ambiguous owner (see above), and
       * inventing a row from it would show a child that never existed.
       */
      const upsert = (
        patch: Partial<(typeof snapshot.subagents)[number]>,
        options: { create: boolean; taskFallback?: boolean }
      ): AgentSessionSnapshot => {
        const targets = targetsFor(options.taskFallback === true);
        if (!targets) {
          if (!options.create) return snapshot;
          const row = { id: subagentId, status: "running" as const, ...patch };
          return { ...snapshot, subagents: [...snapshot.subagents, row] };
        }
        return {
          ...snapshot,
          subagents: snapshot.subagents.map((entry) => {
            if (!targets.has(entry.id)) return entry;
            return { ...entry, ...patch };
          }),
        };
      };

      switch (lifecycle.type) {
        case "subagent:created":
          return upsert(
            {
              status: "running",
              ...(data.parentTaskToolCallId ? { parentTaskToolCallId: data.parentTaskToolCallId } : {}),
            },
            { create: true }
          );
        case "subagent:started":
          return upsert(
            {
              status: "running",
              ...(data.description ? { description: data.description } : {}),
              ...(data.parentTaskToolCallId ? { parentTaskToolCallId: data.parentTaskToolCallId } : {}),
            },
            { create: true }
          );
        case "subagent:phase":
          return data.phase ? upsert({ taskPhase: data.phase }, { create: false, taskFallback: true }) : snapshot;
        case "subagent:completed":
          return upsert({ status: "completed" }, { create: false });
        case "subagent:error":
          return upsert({ status: data.cancelled ? "aborted" : "error" }, { create: false });
        case "subagent:destroyed":
          // A destroyed child is not a row any more; keeping it made `stop()` decide from a
          // child that no longer exists (and made a remount render a stale preview).
          return { ...snapshot, subagents: snapshot.subagents.filter((entry) => entry.id !== subagentId) };
        default:
          return snapshot;
      }
    }
    case "queues":
      return { ...snapshot, queues: event.payload };
    case "usage":
      return { ...snapshot, usage: event.payload };
    case "todos":
      return { ...snapshot, todos: event.payload.items, todosTitle: event.payload.title };
    case "plan":
      return { ...snapshot, plan: event.payload };
    case "summary":
      applySummaryEvent(summaryCache, event.payload);
      return snapshot;
    case "tool":
      applyToolEvent(toolBuffers, event.payload);
      return snapshot;
    case "extensions":
      return { ...snapshot, extensions: event.payload };
    case "tool-presentation":
      return { ...snapshot, toolDescriptors: event.payload.descriptors };
    case "mcp":
      return { ...snapshot, mcp: event.payload };
    case "mode":
      return { ...snapshot, mode: event.payload.mode, autoMode: event.payload.autoMode };
    case "interaction":
      return { ...snapshot, interactions: event.payload };
    case "iteration":
      return { ...snapshot, iteration: event.payload };
    case "jobs":
      return { ...snapshot, jobs: event.payload };
    case "subagents":
      return { ...snapshot, subagents: event.payload.subagents };
    case "messages":
      // Applied by the SSE loop's delta writer (`upsertMessages` + `setMessages`), which needs the
      // previous transcript to merge a patch. Listed here so the exhaustiveness guard stays honest —
      // it is a "no snapshot field of its own" branch, not a forgotten one.
      return snapshot;
    case "extension-ui":
      // Push-only: subscribers render the slot update; the snapshot has no extension-UI field.
      return snapshot;
    default: {
      // Exhaustiveness. Every channel is handled above, so `event` is `never` here — dropping or
      // adding a channel (`AGENT_SESSION_CHANNELS`) is then a COMPILE error instead of a silent
      // `return snapshot`. That silent default is what let a new snapshot field (`lastIteration`)
      // stop updating on the remote path while the local projection stayed correct.
      const uncovered: never = event;
      void uncovered;
      return snapshot;
    }
  }
}
