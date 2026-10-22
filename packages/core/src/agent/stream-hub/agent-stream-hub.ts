/**
 * Per-agent stream hub — one state machine for command / task / compact.
 *
 * The source-specific transport projection stays distinct (`tool` for command,
 * `summary` for text), but the buffer, reset/append/end state and snapshots are
 * shared. That keeps command output from growing a second storage/remount path.
 */

import { applyAgentStreamAppend, emptyAgentStreamLineBuffer, AGENT_STREAM_SNAPSHOT_LINE_CAP } from "./line-buffer.js";
import {
  agentStreamKey,
  type AgentStreamChannel,
  type AgentStreamEvent,
  type AgentStreamSnapshot,
  type AgentStreamSource,
} from "./types.js";

import type { AgentEventBus } from "../agent-event-bus";

interface StreamEntry {
  source: AgentStreamSource;
  channel: AgentStreamChannel;
  toolCallId?: string;
  compactId?: string;
  label?: string;
  epoch?: string;
  /** Session generation that created this entry; `clearAll()` advances the hub's generation. */
  generation: number;
  seq: number;
  lines: string[];
  pendingLine: string;
  status: AgentStreamSnapshot["status"];
}

export interface AgentStreamResetInput {
  source: AgentStreamSource;
  /** Required for source=command/task. */
  toolCallId?: string;
  /** Required for source=compact. */
  compactId?: string;
  /** Required for source=command; text for task/compact. */
  channel?: AgentStreamChannel;
  /** Optional phase label shown by UI consumers (e.g. multi-pass compaction). */
  label?: string;
  /** Compaction run identity — same-epoch resets become appends upstream. */
  epoch?: string;
  /**
   * Session generation captured when the producer started. A reset from an older generation is
   * ignored after `clearAll()`; omitted (commands, legacy callers) means "current generation".
   */
  generation?: number;
}

function resolveId(input: AgentStreamResetInput): { id: string; channel: AgentStreamChannel } {
  if (input.source === "command") {
    if (!input.toolCallId) throw new Error("agent stream reset(command) requires toolCallId");
    if (input.channel !== "stdout" && input.channel !== "stderr") {
      throw new Error("agent stream reset(command) requires stdout/stderr channel");
    }
    return { id: input.toolCallId, channel: input.channel };
  }
  if (input.source === "task") {
    if (!input.toolCallId) throw new Error("agent stream reset(task) requires toolCallId");
    return { id: input.toolCallId, channel: "text" };
  }
  if (!input.compactId) throw new Error("agent stream reset(compact) requires compactId");
  return { id: input.compactId, channel: "text" };
}

/** Owns live stream state for one ManagedAgent and multicasts events to listeners. */
/** Max completed commands retained for remount (both stdout/stderr channels count as one). */
const MAX_COMPLETED_COMMAND_ENTRIES = 16;
/** Max settled command ids remembered to reject late transport chunks. */
const MAX_CLOSED_COMMAND_IDS = 1024;

export class AgentStreamHub {
  private readonly streams = new Map<string, StreamEntry>();
  /**
   * Session generation. `clearAll()` advances it so a producer that started before a session
   * switch cannot recreate a task/compact stream in the new session.
   */
  private generation = 0;
  /**
   * Command ids that have already settled. A late chunk must not recreate a pruned stream:
   * `appendCommand` would otherwise reset it as active with no later tool-end to close it.
   */
  private readonly closedCommandIds = new Set<string>();
  /** Unified event bus for the owning agent (session `summary` / `tool` projection). */
  private eventBus?: AgentEventBus;

  /** @internal Attach the agent's scoped unified event bus. */
  setEventBus(bus: AgentEventBus): void {
    this.eventBus = bus;
  }

  /** Current session generation. Producers capture this before a run and pass it to reset/append. */
  getGeneration(): number {
    return this.generation;
  }

  /** Whether a captured generation still belongs to the current session. */
  isCurrentGeneration(generation: number | undefined): boolean {
    return generation === undefined || generation === this.generation;
  }

  getSnapshot(key: string): AgentStreamSnapshot | null {
    const entry = this.streams.get(key);
    if (!entry) return null;
    return this.toSnapshot(key, entry);
  }

  listSnapshots(): AgentStreamSnapshot[] {
    return [...this.streams.entries()].map(([key, entry]) => this.toSnapshot(key, entry));
  }

  reset(input: AgentStreamResetInput): AgentStreamSnapshot | null {
    const { id, channel } = resolveId(input);
    // A producer from a cleared session must not recreate its task/compact stream.
    if (input.generation !== undefined && input.generation !== this.generation) return null;
    const key = agentStreamKey(input.source, id, input.source === "command" ? channel : undefined);
    const entry: StreamEntry = {
      source: input.source,
      channel,
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      ...(input.compactId ? { compactId: input.compactId } : {}),
      ...(input.label ? { label: input.label } : {}),
      ...(input.epoch ? { epoch: input.epoch } : {}),
      generation: input.generation ?? this.generation,
      seq: 1,
      ...emptyAgentStreamLineBuffer(),
      status: "active",
    };
    this.streams.set(key, entry);
    this.emit({
      type: "reset",
      key,
      source: input.source,
      channel,
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      ...(input.compactId ? { compactId: input.compactId } : {}),
      ...(input.label ? { label: input.label } : {}),
      ...(input.epoch ? { epoch: input.epoch } : {}),
      seq: entry.seq,
    });
    return this.toSnapshot(key, entry);
  }

  append(
    key: string,
    chunk: string,
    options?: { epoch?: string; maxCompleteLines?: number; generation?: number }
  ): void {
    if (!chunk) return;
    const entry = this.streams.get(key);
    if (!entry) return;
    // A reset/append from a session that has already been cleared must not resurrect the stream.
    if (options?.generation !== undefined && entry.generation !== options.generation) return;
    // A compaction key is stable (`compact:<agentId>`), so an old epoch's late chunk must
    // never append to a newer compaction that is already active. This check applies to
    // active entries too; same-epoch follow-up passes still append normally.
    if (options?.epoch !== undefined && entry.epoch !== undefined && options.epoch !== entry.epoch) return;
    if (entry.status === "ended") {
      // Late chunks after end are ignored — unless the append belongs to the
      // same compaction epoch, which reopens the ended stream (follow-up pass
      // of a multi-pass summarization continues the banner instead of resetting).
      const sameEpoch = options?.epoch !== undefined && options.epoch === entry.epoch;
      if (!sameEpoch) return;
      entry.status = "active";
    }

    const next = applyAgentStreamAppend({ lines: entry.lines, pendingLine: entry.pendingLine }, chunk, {
      maxCompleteLines: options?.maxCompleteLines ?? AGENT_STREAM_SNAPSHOT_LINE_CAP,
    });
    entry.lines = next.lines;
    entry.pendingLine = next.pendingLine;
    entry.seq += 1;
    this.emit({
      type: "append",
      key,
      source: entry.source,
      channel: entry.channel,
      ...(entry.toolCallId ? { toolCallId: entry.toolCallId } : {}),
      chunk,
      seq: entry.seq,
    });
  }

  end(key: string, generation?: number): void {
    const entry = this.streams.get(key);
    if (!entry) return;
    if (generation !== undefined && entry.generation !== generation) return;
    if (entry.status === "ended") return;
    entry.status = "ended";
    entry.seq += 1;
    this.emit({
      type: "end",
      key,
      source: entry.source,
      channel: entry.channel,
      seq: entry.seq,
    });
  }

  /** Append a command chunk; opens the stdout/stderr stream on first use. */
  appendCommand(toolCallId: string, channel: "stdout" | "stderr", chunk: string): void {
    // A command that already settled must not be revived by a late transport chunk. Its final
    // output is owned by the tool result; recreating a preview here would leave an active entry
    // with no later tool-end to close it.
    if (this.closedCommandIds.has(toolCallId)) return;
    const key = agentStreamKey("command", toolCallId, channel);
    if (!this.streams.has(key)) {
      this.reset({ source: "command", toolCallId, channel });
      this.pruneCommandEntries(key);
    }
    // Command previews are byte-capped below; do not apply the task/compact line-snapshot cap
    // first, or a 500-line chatty command loses its head before the 256KB byte budget matters.
    this.append(key, chunk, { maxCompleteLines: 0 });
    this.capCommandEntry(this.streams.get(key));
  }

  /** Mark both command channels as settled, so pruning may evict them. */
  endCommand(toolCallId: string): void {
    this.rememberClosedCommand(toolCallId);
    for (const channel of ["stdout", "stderr"] as const) {
      this.end(agentStreamKey("command", toolCallId, channel));
    }
    this.pruneCommandEntries("");
  }

  /** Settle every command stream after an abandoned run, retaining completed previews. */
  endAllCommands(): void {
    for (const [key, entry] of this.streams) {
      if (entry.source !== "command") continue;
      if (entry.toolCallId) this.rememberClosedCommand(entry.toolCallId);
      this.end(key);
    }
    this.pruneCommandEntries("");
  }

  /**
   * Remember a settled command id so a late transport chunk cannot revive it.
   *
   * The set is insertion-ordered and capped. A command id older than the cap may in theory be
   * revived by an extremely late chunk, but that requires more than 1024 subsequent commands and
   * is preferable to growing the tombstone set for the lifetime of a long session.
   */
  private rememberClosedCommand(toolCallId: string): void {
    if (!toolCallId) return;
    this.closedCommandIds.add(toolCallId);
    while (this.closedCommandIds.size > MAX_CLOSED_COMMAND_IDS) {
      const oldest = this.closedCommandIds.values().next().value;
      if (oldest === undefined) break;
      this.closedCommandIds.delete(oldest);
    }
  }

  /** Keep command previews at the old 256KB per-stream ceiling (not just line count). */
  private capCommandEntry(entry: StreamEntry | undefined): void {
    if (!entry || entry.source !== "command") return;
    const MAX = 256 * 1024;
    let total = entry.pendingLine.length + entry.lines.reduce((sum, line) => sum + line.length + 1, 0);
    while (total > MAX && entry.lines.length > 0) {
      const removed = entry.lines.shift()!;
      total -= removed.length + 1;
    }
    if (total > MAX && entry.pendingLine.length > MAX) {
      entry.pendingLine = entry.pendingLine.slice(-MAX);
    }
  }

  /**
   * Bound completed commands; active streams are never evicted.
   *
   * A command owns two keys (stdout/stderr). Evicting by key could leave half a stream in
   * `/tool-buffers`, so group by toolCallId and drop both channels together.
   */
  private pruneCommandEntries(keepKey: string): void {
    const groups = new Map<string, { keys: string[]; completed: boolean }>();
    for (const [key, entry] of this.streams) {
      if (entry.source !== "command" || !entry.toolCallId) continue;
      const group = groups.get(entry.toolCallId) ?? { keys: [], completed: true };
      group.keys.push(key);
      group.completed &&= entry.status === "ended";
      groups.set(entry.toolCallId, group);
    }

    const completed = [...groups.values()].filter((group) => group.completed && !group.keys.includes(keepKey));
    while (completed.length > MAX_COMPLETED_COMMAND_ENTRIES) {
      const oldest = completed.shift();
      if (!oldest) break;
      for (const key of oldest.keys) this.streams.delete(key);
    }
  }

  /**
   * Clear both command channels for a tool call.
   *
   * Retry semantics: removing the tombstone too lets a re-executed call with the same
   * `toolCallId` stream again. A caller that only wants to hide a settled preview should not use
   * this method; `endCommand` / `clearAll` keep the tombstone so a late chunk stays discarded.
   */
  clearCommand(toolCallId: string, options: { emit?: boolean } = {}): void {
    this.closedCommandIds.delete(toolCallId);
    for (const channel of ["stdout", "stderr"] as const) {
      const key = agentStreamKey("command", toolCallId, channel);
      this.streams.delete(key);
    }
    if (options.emit !== false) {
      this.eventBus?.emit("tool:clear", { kind: "clear", toolCallId });
    }
  }

  /**
   * Drop every live stream (command / task / compact) on reset or session restore.
   *
   * Command ids are marked settled first so a transport chunk still in flight cannot recreate a
   * preview in the new session. Existing and previously-pruned command buffers are cleared for
   * subscribers before the local map is dropped; task/compact streams are ended. A client that
   * missed a frame still gets the new snapshot from `/summary-streams` / `/tool-buffers` on resync.
   */
  clearAll(): void {
    this.generation += 1;
    const commandIds = new Set(this.closedCommandIds);
    for (const [key, entry] of this.streams) {
      if (entry.source === "command") {
        if (entry.toolCallId) {
          commandIds.add(entry.toolCallId);
          this.rememberClosedCommand(entry.toolCallId);
        }
        continue;
      }
      this.end(key);
    }
    for (const toolCallId of commandIds) {
      this.eventBus?.emit("tool:clear", { kind: "clear", toolCallId });
    }
    this.streams.clear();
  }

  private toSnapshot(key: string, entry: StreamEntry): AgentStreamSnapshot {
    return {
      key,
      source: entry.source,
      channel: entry.channel,
      ...(entry.toolCallId ? { toolCallId: entry.toolCallId } : {}),
      ...(entry.compactId ? { compactId: entry.compactId } : {}),
      ...(entry.label ? { label: entry.label } : {}),
      ...(entry.epoch ? { epoch: entry.epoch } : {}),
      seq: entry.seq,
      lines: entry.lines.slice(),
      pendingLine: entry.pendingLine,
      status: entry.status,
    };
  }

  private emit(event: AgentStreamEvent): void {
    if (event.source === "command") {
      if (event.type === "append" && event.toolCallId) {
        this.eventBus?.emit("tool:chunk", {
          kind: "chunk",
          chunk: {
            toolCallId: event.toolCallId,
            type: event.channel === "stderr" ? "stderr" : "stdout",
            chunk: event.chunk,
          },
        });
      }
      return;
    }
    // Session `summary` projection — the bus is the single change mechanism.
    this.eventBus?.emit("session:summary", event);
  }
}
