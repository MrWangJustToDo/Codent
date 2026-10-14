/**
 * Buffers streaming chunks and flushes to the reactive store on a throttle schedule.
 * Throttle is configured per toolCallId by {@link useStreamingOutput} consumers.
 *
 * Retention is bounded two ways, because the display only ever shows the latest few
 * lines (`StreamingOutputView`):
 *
 *   - each stream keeps at most {@link MAX_RETAINED_CHARS} as a **tail**, and
 *   - an entry is dropped outright once the tool call is over.
 *
 * Without both, a session that runs many commands holds every call's full output for
 * its whole lifetime (measured: 1000 ids, ~100MB streamed, all still retained), which
 * is the growth behind the command-tool OOM.
 */

import { useStreamingStore } from "../hooks/use-streaming-store.js";

import { isToolExecuting } from "./tool-part.js";
import { createTrailingScheduler } from "./trailing-throttle.js";

// ============================================================================
// Constants
// ============================================================================

/**
 * Characters retained per stream (stdout / stderr separately).
 *
 * 64KB is far more than the ~5 rendered lines (a line is typically well under 1KB),
 * and far less than a chatty command's full log. Cut on a line boundary so the first
 * visible line is not a half line. The "N lines hidden above" indicator counts lines
 * as well as any longer buffer would, so nothing the user sees changes.
 */
const MAX_RETAINED_CHARS = 64 * 1024;

// ============================================================================
// Types
// ============================================================================

interface StreamBuffer {
  stdout: string;
  stderr: string;
}

// ============================================================================
// State
// ============================================================================

const buffers = new Map<string, StreamBuffer>();
const throttleMsByToolCallId = new Map<string, Set<number>>();
const scheduler = createTrailingScheduler();

/** Keep the tail of `text`, starting at a line boundary when one is available. */
function tailOf(text: string): string {
  if (text.length <= MAX_RETAINED_CHARS) return text;
  const cut = text.length - MAX_RETAINED_CHARS;
  const newline = text.indexOf("\n", cut);
  return newline === -1 ? text.slice(cut) : text.slice(newline + 1);
}

function getEffectiveThrottleMs(toolCallId: string): number {
  const values = throttleMsByToolCallId.get(toolCallId);
  if (!values || values.size === 0) return 0;
  return Math.min(...values);
}

function flushToStore(toolCallId: string): void {
  const buffer = buffers.get(toolCallId);
  if (!buffer) return;

  scheduler.cancel(toolCallId);

  useStreamingStore.getActions().update(toolCallId, {
    stdout: buffer.stdout,
    stderr: buffer.stderr,
  });
}

function scheduleFlush(toolCallId: string): void {
  if (!buffers.has(toolCallId)) return;
  scheduler.schedule(toolCallId, getEffectiveThrottleMs(toolCallId), () => flushToStore(toolCallId));
}

// ============================================================================
// Public API
// ============================================================================

/** Register a consumer's throttle preference for a tool call. */
export function registerStreamingThrottle(toolCallId: string, throttleMs: number): () => void {
  const ms = Math.max(0, throttleMs);
  let values = throttleMsByToolCallId.get(toolCallId);
  if (!values) {
    values = new Set();
    throttleMsByToolCallId.set(toolCallId, values);
  }
  values.add(ms);

  return () => {
    const current = throttleMsByToolCallId.get(toolCallId);
    if (!current) return;
    current.delete(ms);
    if (current.size === 0) {
      throttleMsByToolCallId.delete(toolCallId);
    }
  };
}

/** Append a chunk to the buffer and schedule a throttled store flush. */
export function ingestStreamingChunk(toolCallId: string, type: "stdout" | "stderr", chunk: string): void {
  let buffer = buffers.get(toolCallId);
  if (!buffer) {
    buffer = { stdout: "", stderr: "" };
    buffers.set(toolCallId, buffer);
  }

  if (type === "stdout") {
    buffer.stdout = tailOf(buffer.stdout + chunk);
  } else {
    buffer.stderr = tailOf(buffer.stderr + chunk);
  }

  scheduleFlush(toolCallId);
}

/**
 * Drop everything held for a finished tool call: its streaming buffer, the throttled
 * store entry, and any consumer throttle registration.
 *
 * Called when the call ends (`agent:tool-end` / `agent:tool-error`), because
 * `StreamingOutputView` renders only while the call is executing — a settled call's
 * retained output is never read again.
 */
export function releaseFinishedTool(toolCallId: string): void {
  scheduler.cancel(toolCallId);
  buffers.delete(toolCallId);
  throttleMsByToolCallId.delete(toolCallId);
  useStreamingStore.getActions().clear(toolCallId);
}

/** Clear buffer + store for a tool call (e.g. subagent retry). */
export function clearStreamingIngest(toolCallId: string): void {
  releaseFinishedTool(toolCallId);
}

// ============================================================================
// Session-event mapping
// ============================================================================

/** What one session event means for the streaming buffers, or `null` to ignore it. */
export type StreamEventAction =
  | { kind: "ingest"; toolCallId: string; type: "stdout" | "stderr"; chunk: string }
  | { kind: "clear"; toolCallId: string }
  | { kind: "tool-end"; toolCallId: string }
  | { kind: "release"; toolCallId: string };

/**
 * Calls whose end was signalled but whose result is not on the channel yet.
 *
 * A tool's end and its result reach the app in the opposite order from what the names
 * suggest: `agent:tool-end` is emitted from `extensions-middleware`, which sits BEFORE
 * `early-tool-result-ui` in the `tools` phase, so it arrives one subscriber-tick before
 * the `messages` frame that carries the part's output. Releasing on the end event alone
 * emptied the buffer while the part was still `isExecuting` — `StreamingOutputView` is
 * mounted on exactly that condition, so the row visibly blanked for a frame before the
 * final output rendered.
 */
const endedAtToolEnd = new Set<string>();

/** Reap an `endedAtToolEnd` entry that never got a result frame (failed/aborted run). */
const END_FALLBACK_MS = 30_000;
const endFallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();

function markEnded(toolCallId: string): void {
  endedAtToolEnd.add(toolCallId);
  const existing = endFallbackTimers.get(toolCallId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    endFallbackTimers.delete(toolCallId);
    if (endedAtToolEnd.delete(toolCallId)) releaseFinishedTool(toolCallId);
  }, END_FALLBACK_MS);
  // Never hold the process open for a reaper.
  (timer as { unref?: () => void }).unref?.();
  endFallbackTimers.set(toolCallId, timer);
}

function settle(toolCallId: string): void {
  const timer = endFallbackTimers.get(toolCallId);
  if (timer) {
    clearTimeout(timer);
    endFallbackTimers.delete(toolCallId);
  }
  endedAtToolEnd.delete(toolCallId);
  releaseFinishedTool(toolCallId);
}

/**
 * Classify one AgentSession event. Pure, so the mapping can be pinned by tests — the
 * subscription that consumes it cannot be exercised without a live session, and a
 * source-text assertion on that subscription cannot tell an unconditional release from
 * a dead one (`if (id && false) ...` still matches the text).
 *
 * Three channels matter:
 * - `tool` — chunks, and the (runtime-dead) clear frame.
 * - `lifecycle` — `agent:tool-end` / `agent:tool-error`: the only "this call is over"
 *   signal that ever fires. Marks the call for release, but does not release on its own.
 * - `messages` — the call's result lands here; that is what actually releases it.
 */
export function classifyStreamEvent(event: {
  channel: string;
  payload: { type?: string; [k: string]: unknown };
}): StreamEventAction | null {
  if (event.channel === "tool") {
    const payload = event.payload as { kind?: string; chunk?: unknown; toolCallId?: unknown };
    if (payload.kind === "chunk") {
      const chunk = payload.chunk as { toolCallId: string; type: "stdout" | "stderr"; chunk: string };
      return { kind: "ingest", toolCallId: chunk.toolCallId, type: chunk.type, chunk: chunk.chunk };
    }
    return typeof payload.toolCallId === "string" ? { kind: "clear", toolCallId: payload.toolCallId } : null;
  }

  if (event.channel === "lifecycle") {
    const type = event.payload.type;
    if (type !== "agent:tool-end" && type !== "agent:tool-error") return null;
    const inner = event.payload.payload as { tool_call_id?: unknown } | undefined;
    const toolCallId = inner?.tool_call_id;
    return typeof toolCallId === "string" ? { kind: "tool-end", toolCallId } : null;
  }

  if (event.channel === "messages") {
    return classifyResultFrames(event.payload);
  }

  return null;
}

/**
 * Find the release signal in a `messages` frame.
 *
 * The test is {@link isToolExecuting} — the SAME predicate `ToolCallPartView` uses to
 * decide whether `StreamingOutputView` is mounted. Releasing on anything looser (any
 * part with an output, any settled part) can drop the buffer while the view is still on
 * screen, which is exactly the blank frame this release deferral exists to avoid. So the
 * two are tied together by construction rather than by two hand-written conditions that
 * happen to agree.
 *
 * The frame is only scanned while a release is pending — the set is empty almost always.
 */
function classifyResultFrames(payload: unknown): StreamEventAction | null {
  if (endedAtToolEnd.size === 0 || !Array.isArray(payload)) return null;
  for (const message of payload as Array<{ parts?: Array<Record<string, unknown>> }>) {
    for (const part of message?.parts ?? []) {
      if (part?.type !== "tool-call") continue;
      const id = part.id;
      if (typeof id !== "string" || !endedAtToolEnd.has(id)) continue;
      if (isToolExecuting(part as never)) continue;
      return { kind: "release", toolCallId: id };
    }
  }
  return null;
}

/** Apply a {@link classifyStreamEvent} result to the buffers (a `null` is a no-op). */
export function applyStreamEventAction(action: StreamEventAction | null): void {
  if (!action) return;
  switch (action.kind) {
    case "ingest":
      ingestStreamingChunk(action.toolCallId, action.type, action.chunk);
      return;
    case "tool-end":
      markEnded(action.toolCallId);
      return;
    case "release":
      settle(action.toolCallId);
      return;
    default:
      clearStreamingIngest(action.toolCallId);
  }
}

/** Test helper — read the reactive snapshot for a tool call. */
export function getStreamingStoreOutput(toolCallId: string) {
  return useStreamingStore.getReadonlyState().outputs[toolCallId];
}
