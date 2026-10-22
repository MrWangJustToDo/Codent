/**
 * TanStack StreamProcessor wrapper for subagent preview and non-useChat consumers.
 */

import { StreamProcessor } from "@tanstack/ai";

import { generateId } from "../../utils/generate-id.js";
import { repairMessagesSnapshotChunk } from "../media/repair-stringified-multimodal.js";
import { applyToolApprovalDecision, applyToolDenialReason, approvalStamp } from "../stream/apply-tool-denial-reason.js";
import { stripEmptyAssistantShells } from "../stream/empty-assistant-shell.js";
import {
  resolveTaskRunPhase,
  type TaskSummaryPhase,
  type TaskSummaryStreamState,
} from "../stream/extract-assistant-text.js";
import { isToolCallPart } from "../stream/message-parts.js";
import { throwOnRunError } from "../stream/stream-errors.js";
import { shouldSuppressMessagesSnapshot } from "../stream/suppress-messages-snapshot.js";
import { shouldSuppressReplayedToolChunk } from "../stream/suppress-replayed-tool-chunks.js";
import { shouldSuppressStaleTextChunk } from "../stream/suppress-stale-text-chunks.js";
import { agentStreamKey, type AgentStreamHub } from "../stream-hub";
import { BEGIN_SUMMARY_TOOL_NAME } from "../subagent/begin-summary-tool.js";
import { computeToolDisplay } from "../tools/presentation/compute-display.js";

import type { AgentEventBus } from "../agent-event-bus";
import type { ToolDisplayPayload } from "../tools/presentation/types.js";
import type { StreamChunk, StreamProcessorEvents, UIMessage as TanStackUIMessage, ContentPart } from "@tanstack/ai";

// ============================================================================
// Types
// ============================================================================

export type UIApprovalRequest =
  NonNullable<StreamProcessorEvents["onApprovalRequest"]> extends (args: infer A) => void ? A : never;

export type UICustomEventListener = NonNullable<StreamProcessorEvents["onCustomEvent"]>;

export interface AgentUIChannelOptions {
  initialMessages?: TanStackUIMessage[];
  onApprovalRequest?: (request: UIApprovalRequest) => void;
  onCustomEvent?: UICustomEventListener;
}

export interface ConsumeRunOptions {
  stream: AsyncIterable<StreamChunk>;
  /** Parent task tool call ID — summary text streams via {@link summaryHub}. */
  parentTaskToolCallId?: string;
  /**
   * Parent agent's summary stream hub. When set with task or compact ids,
   * TEXT deltas are appended after the stream is unlocked (begin_summary or compact).
   */
  summaryHub?: AgentStreamHub;
  /** Compact stream id when this run produces a compact summary. */
  compactId?: string;
  /** Phase label for the compact banner (multi-pass compaction). */
  compactLabel?: string;
  /**
   * Compaction run identity. When set and the hub snapshot already carries the
   * same epoch, this pass APPENDS to the existing stream instead of resetting.
   */
  compactEpoch?: string;
  /**
   * Hub generation captured when the producer started. A producer that began before a session
   * switch must not recreate a task/compact stream after `clearAll()`.
   */
  summaryGeneration?: number;
  onUpdate?: (messages: TanStackUIMessage[]) => void;
}

type ApprovalListener = (request: UIApprovalRequest) => void;

function readToolCallName(chunk: StreamChunk): string | undefined {
  if (chunk.type !== "TOOL_CALL_START") return undefined;
  const record = chunk as { toolName?: string };
  return typeof record.toolName === "string" ? record.toolName : undefined;
}

/**
 * Some adapters emit the `toolName` alias on `TOOL_CALL_START`; TanStack's
 * processor only reads `toolCallName`, so the created tool-call part would
 * end up nameless. Copy the alias over before feeding the processor.
 */
function normalizeToolCallName(chunk: StreamChunk): StreamChunk {
  if (
    chunk.type === "TOOL_CALL_START" &&
    !chunk.toolCallName &&
    typeof chunk.toolName === "string" &&
    chunk.toolName.length > 0
  ) {
    return { ...chunk, toolCallName: chunk.toolName };
  }
  return chunk;
}

/**
 * Decision timestamp the patch put on the tool-call part carrying `approvalId`.
 *
 * Read from the array we just patched — never from the engine — so the value is
 * ours by construction: the engine keeps it only so the UI snapshot and the
 * persisted log agree, and `touchToolPart`/`setMessages` merge (never rebuild)
 * parts. `undefined` when no tool call carries `approvalId`.
 */
function findApprovalDecisionTime(messages: TanStackUIMessage[], approvalId: string): number | undefined {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (!isToolCallPart(part) || part.approval?.id !== approvalId) continue;
      return approvalStamp(part.approval);
    }
  }
  return undefined;
}

function readTextMessageId(chunk: StreamChunk): string | undefined {
  if (chunk.type !== "TEXT_MESSAGE_START") return undefined;
  const record = chunk as { messageId?: string };
  return typeof record.messageId === "string" && record.messageId.length > 0 ? record.messageId : undefined;
}

function readTextDelta(chunk: StreamChunk): string | undefined {
  if (chunk.type !== "TEXT_MESSAGE_CONTENT") return undefined;
  const record = chunk as { delta?: unknown };
  return typeof record.delta === "string" ? record.delta : undefined;
}

// ============================================================================
// AgentUIChannel
// ============================================================================

/**
 * Converts agent run streams into observable TanStack {@link UIMessage} snapshots.
 * InteractiveChat and Worker UI runs attach this via `ensureUIChannel` / `runAgentOnce`.
 */
export class AgentUIChannel {
  private readonly processor: StreamProcessor;
  /** Unified event bus for the owning agent (session `messages` projection). */
  private eventBus?: AgentEventBus;

  /** @internal Attach the agent's scoped unified event bus. */
  setEventBus(bus: AgentEventBus): void {
    this.eventBus = bus;
    bus.retain("session:messages", () => (this.getMessages() ?? []) as never);
  }
  private readonly approvalListeners = new Set<ApprovalListener>();
  private readonly customEventListeners = new Set<UICustomEventListener>();
  private parentTaskToolCallId?: string;
  private summaryHub?: AgentStreamHub;
  private compactId?: string;
  private compactLabel?: string;
  private compactEpoch?: string;
  private summaryGeneration?: number;
  private activeSummaryKey?: string;
  private onUpdate?: (messages: TanStackUIMessage[]) => void;
  private summaryStreamState: TaskSummaryStreamState = { summaryPhaseUnlocked: false };
  /**
   * Message ids that existed before the current run started. Late/replayed
   * TEXT chunks referencing these must be dropped (see shouldSuppressStaleTextChunk):
   * TanStack >= 0.53 `resumeAssistantState` would otherwise reopen the completed
   * assistant row and append to it. Refreshed at every run boundary
   * (consumeRun / setMessages / clearMessages), never mid-run.
   */
  private historicalMessageIds: ReadonlySet<string> = new Set();
  /** Active agent-loop turn assistant message (per-turn streaming scope). */
  private currentTurnMessageId?: string;
  /** Monotonic revision bumped on every messages change (wire projection cache). */
  private revision = 0;

  /** Current task run phase for parent task tool UI (`tools` vs `summary`). */
  getTaskRunPhase(): TaskSummaryPhase {
    return resolveTaskRunPhase(this.getMessages(), this.summaryStreamState);
  }

  /** Channel generation for cheap wire-projection fingerprints. */
  getRevision(): number {
    return this.revision;
  }

  constructor(options: AgentUIChannelOptions = {}) {
    if (options.initialMessages?.length) {
      this.historicalMessageIds = new Set(options.initialMessages.map((message) => message.id));
    }
    this.processor = new StreamProcessor({
      initialMessages: options.initialMessages,
      events: {
        onMessagesChange: (messages) => this.handleMessagesChange(messages),
        onApprovalRequest: (request) => {
          options.onApprovalRequest?.(request);
          for (const listener of this.approvalListeners) {
            try {
              listener(request);
            } catch {
              // Ignore listener errors
            }
          }
        },
        onCustomEvent: (eventType, data, context) => {
          options.onCustomEvent?.(eventType, data, context);
          for (const listener of this.customEventListeners) {
            try {
              listener(eventType, data, context);
            } catch {
              // Ignore listener errors
            }
          }
        },
      },
    });
  }

  getMessages(): TanStackUIMessage[] {
    return this.processor.getMessages();
  }

  setMessages(messages: TanStackUIMessage[]): void {
    this.processor.setMessages(messages);
    this.historicalMessageIds = new Set(messages.map((message) => message.id));
  }

  clearMessages(): void {
    this.processor.clearMessages();
    this.historicalMessageIds = new Set();
  }

  addUserMessage(content: string | ContentPart[], id?: string): TanStackUIMessage {
    return this.processor.addUserMessage(content, id);
  }

  /**
   * Record an approval decision on the channel: decision status, denial reason,
   * and the decision timestamp (the single time value shared by the log and the
   * in-memory approval table). Returns the decision time.
   *
   * The time is resolved BEFORE anything is handed to the engine (reusing the
   * approval's own stamp when it already has one), and only the already-patched
   * array is read back afterwards — never `processor.getMessages()`. The engine
   * is where we write the patch (its `StreamProcessor` owns the UI snapshot);
   * it is not where we ask for the value.
   */
  addToolApprovalResponse(approvalId: string, approved: boolean, reason?: string, decidedAt?: number): number {
    const before = this.processor.getMessages() as TanStackUIMessage[];
    // Resolve the time here: the decision is made now, and an approval that
    // already carries a time keeps it.
    const at = findApprovalDecisionTime(before, approvalId) ?? decidedAt ?? Date.now();
    const next = applyToolApprovalDecision(before, approvalId, approved, { reason, decidedAt: at });
    let patched = next;
    if (!approved) {
      // Model-facing denial result (idempotent: keeps an existing one).
      patched = applyToolDenialReason(next, approvalId, reason);
    }
    // The UI snapshot and the session log must see the same parts; one write for both.
    this.processor.setMessages(patched);
    return at;
  }

  addToolResult(toolCallId: string, output: unknown, error?: string): void {
    this.processor.addToolResult(toolCallId, output, error);
  }

  /**
   * Attach the core-rendered display payload to that tool call's part.
   *
   * Host-facing only: `uiMessageToModelMessages` copies a fixed set of fields, so an
   * extra top-level field on the part never reaches the model wire.
   */
  attachToolDisplay(toolCallId: string, display: ToolDisplayPayload): void {
    type DisplayAwarePart = { type?: string; id?: string; display?: ToolDisplayPayload };

    let changed = false;
    const next = this.getMessages().map((message) => {
      const parts = (message as { parts?: DisplayAwarePart[] }).parts;
      if (!parts?.length) return message;

      let touched = false;
      const patched = parts.map((part) => {
        if (part?.type !== "tool-call" || part.id !== toolCallId) return part;
        touched = true;
        return { ...part, display };
      });
      if (!touched) return message;

      changed = true;
      return { ...message, parts: patched } as typeof message;
    });

    // Patch the processor directly, NOT the channel-level `setMessages`: that one also
    // refreshes the run-boundary snapshot (`historicalMessageIds`), and doing so mid-run
    // makes `shouldSuppressStaleTextChunk` drop every remaining TEXT delta of the
    // assistant message that is still streaming — the tool call is normally mid-message,
    // so the model's text after the tool would be lost. `addToolApprovalResponse`
    // patches the processor for the same reason.
    if (changed) this.processor.setMessages(next);
  }

  subscribeApprovalRequests(listener: ApprovalListener): () => void {
    this.approvalListeners.add(listener);
    return () => {
      this.approvalListeners.delete(listener);
    };
  }

  subscribeCustomEvents(listener: UICustomEventListener): () => void {
    this.customEventListeners.add(listener);
    return () => {
      this.customEventListeners.delete(listener);
    };
  }

  /**
   * Reset channel history after a failed run: drop stale partial tool rows /
   * summary text, keep the seeded task prompt, and optionally append a synthetic
   * assistant message describing the failure.
   *
   * Used by subagent runners so a failed (non-aborted) run does not leave stale
   * work in the preview — while still keeping the prompt so the detail view never
   * spins forever on an empty transcript (e.g. 429 retries exhausted). Aborted
   * runs intentionally keep partial work.
   */
  failRun(errorMessage?: string): void {
    // Keep ALL leading user messages — subagent channels may hold leading
    // synthetic <ctx kind=...> user messages around the real task prompt, so
    // keeping only the first user message could drop the prompt itself.
    const kept: TanStackUIMessage[] = [];
    for (const message of this.getMessages()) {
      if (message.role !== "user") break;
      kept.push(message);
    }

    if (errorMessage) {
      kept.push({
        id: generateId("msg"),
        role: "assistant",
        parts: [{ type: "text", content: `⚠️ Task failed: ${errorMessage}` }],
        createdAt: new Date(),
      });
    }

    this.setMessages(kept);
    this.currentTurnMessageId = undefined;
    this.endSummaryStream();
  }

  /**
   * Reset the ATTEMPT-scoped UI state before a restart-style stream retry.
   *
   * Never the message history. The history is not a preview: `compaction.onConfig` re-projects the
   * wire from this channel on every attempt, so dropping rows here did not clear "stale work" — it
   * deleted the model's context and forced the retry to redo it. That is exactly what happened to
   * subagents (this method was called for them and nobody else): a task that had completed five
   * tool calls before a network drop came back as a fresh exploration, while a root agent, which
   * never had this reset, resumed from the same five results.
   *
   * What IS attempt-scoped, and therefore reset here:
   * - the summary text streamed into the task / compact banner — the retry re-streams it from the
   *   start, so keeping the old text would splice two attempts into one line;
   * - the phase unlock that gates that text;
   * - the in-flight assistant message id.
   *
   * Unlike {@link failRun}, the active summary hub subscription is **not** ended — {@link consumeRun}
   * still owns that lifecycle.
   */
  resetRetryUiState(): void {
    this.currentTurnMessageId = undefined;

    if (this.summaryHub && !this.summaryGenerationCurrent()) {
      // A retry from a session that was cleared must not recreate its banner.
      this.activeSummaryKey = undefined;
      this.summaryStreamState = { summaryPhaseUnlocked: false };
      return;
    }

    if (this.summaryHub && this.parentTaskToolCallId && !this.compactId) {
      this.summaryHub.reset({
        source: "task",
        toolCallId: this.parentTaskToolCallId,
        ...(this.summaryGeneration !== undefined ? { generation: this.summaryGeneration } : {}),
      });
      this.activeSummaryKey = agentStreamKey("task", this.parentTaskToolCallId);
      this.summaryStreamState = { summaryPhaseUnlocked: false };
      return;
    }

    if (this.summaryHub && this.compactId) {
      // Stream restart within a pass: always reset (the retried LLM stream
      // re-emits from scratch), keeping epoch/label so later passes append.
      this.summaryHub.reset({
        source: "compact",
        compactId: this.compactId,
        ...(this.compactLabel ? { label: this.compactLabel } : {}),
        ...(this.compactEpoch ? { epoch: this.compactEpoch } : {}),
        ...(this.summaryGeneration !== undefined ? { generation: this.summaryGeneration } : {}),
      });
      this.activeSummaryKey = agentStreamKey("compact", this.compactId);
      this.summaryStreamState = { summaryPhaseUnlocked: true };
      return;
    }

    this.summaryStreamState = { summaryPhaseUnlocked: false };
  }

  private summaryGenerationCurrent(): boolean {
    return !this.summaryHub || this.summaryHub.isCurrentGeneration(this.summaryGeneration);
  }

  /** Process a single stream chunk (for incremental bridge during `runAgent`). */
  processChunk(chunk: StreamChunk): void {
    // Engine snapshots must not replace the chronological channel (summary-first
    // wire, or ordinary interrupt rebuilds that drop approval/state).
    if (shouldSuppressMessagesSnapshot(chunk)) {
      return;
    }
    // Upstream >= 0.53.0 fixed the stringified-ContentPart snapshot corruption
    // (collectUserContent in ag-ui-wire.js); keep the repair as a defensive
    // passthrough for legacy snapshots if suppression is ever relaxed.
    const normalized = normalizeToolCallName(repairMessagesSnapshotChunk(chunk));
    if (shouldSuppressReplayedToolChunk(this.getMessages(), normalized)) {
      return;
    }
    // TanStack >= 0.53 resumeAssistantState: a late chunk with a historical
    // messageId re-opens the completed assistant message and appends to it.
    // Drop those (late chunks after abort/finalize, or replays of rendered
    // content) so stale text cannot resurrect old rows. The predicate is the
    // run-boundary snapshot (historicalMessageIds), NOT the live messages
    // array — within a run the first TEXT chunk materializes its message
    // immediately, so live-membership would suppress every legitimate delta
    // of the active message (and after abort + resend, the new reply too).
    if (shouldSuppressStaleTextChunk(this.historicalMessageIds, normalized)) {
      return;
    }
    this.trackSummaryStreamPhase(normalized);
    this.appendSummaryDelta(normalized);
    this.processor.processChunk(normalized);
  }

  /** Finalize an incrementally processed stream. */
  finalizeStream(): void {
    this.processor.finalizeStream();
    const cleaned = stripEmptyAssistantShells(this.processor.getMessages());
    if (cleaned.length !== this.processor.getMessages().length) {
      this.processor.setMessages(cleaned);
    }
    // Safety net for the tool paths the early-result middleware does not see
    // (batched tool phase, replayed results): attach each completed call's display
    // payload once, here, before the turn becomes historical.
    const withDisplay = attachMissingToolDisplays(this.getMessages());
    if (withDisplay) this.processor.setMessages(withDisplay);
    // End of run: everything now materialized becomes historical for the next
    // one (matters when the next stream is fed via processChunk directly).
    this.historicalMessageIds = new Set(this.getMessages().map((message) => message.id));
  }

  /**
   * Consume a TanStack {@link StreamChunk} stream and return final messages.
   */
  async consumeRun(options: ConsumeRunOptions): Promise<TanStackUIMessage[]> {
    this.beginSummaryStream(options);
    // TanStack >= 0.53: getActiveAssistantMessageId() gained a fallback over ALL
    // retained messageStates, but finalizeStream() only clears activeMessageIds.
    // Our consumeRun is incremental (never calls processor.process()), so without
    // a per-run reset a new turn whose first content chunk carries no usable id
    // (tool-first response without preceding text, or client-tool result replay)
    // resumes the PREVIOUS turn's assistant message and appends the new output
    // there — i.e. above the just-sent user message. prepareAssistantMessage()
    // clears stream state while keeping messages, restoring 0.48 semantics where
    // the fallback only saw the (cleared) active set.
    this.processor.prepareAssistantMessage();
    // Run boundary: everything materialized up to now is historical for this
    // run. Stale-chunk suppression keys off this snapshot so in-run deltas of
    // the active message are never mistaken for late/replayed chunks.
    this.historicalMessageIds = new Set(this.getMessages().map((message) => message.id));

    try {
      for await (const chunk of throwOnRunError(options.stream)) {
        this.processChunk(chunk);
      }
      this.finalizeStream();
      return this.getMessages();
    } finally {
      this.endSummaryStream();
    }
  }

  private beginSummaryStream(options: ConsumeRunOptions): void {
    this.parentTaskToolCallId = options.parentTaskToolCallId;
    this.summaryHub = options.summaryHub;
    this.compactId = options.compactId;
    this.compactLabel = options.compactLabel;
    this.compactEpoch = options.compactEpoch;
    this.summaryGeneration = options.summaryGeneration ?? options.summaryHub?.getGeneration();
    this.onUpdate = options.onUpdate;
    this.summaryStreamState = { summaryPhaseUnlocked: false };
    this.currentTurnMessageId = undefined;
    this.activeSummaryKey = undefined;

    // Compact summarizer: unlock immediately. First pass of a compaction run
    // resets the banner; same-epoch follow-up passes APPEND so sequential
    // phases read as one continuous stream (run-subagent injects [label]
    // separators between them).
    if (this.summaryHub && this.compactId) {
      if (!this.summaryGenerationCurrent()) {
        this.activeSummaryKey = undefined;
        return;
      }
      this.summaryStreamState = { summaryPhaseUnlocked: true };
      const key = agentStreamKey("compact", this.compactId);
      const continuing = Boolean(this.compactEpoch) && this.summaryHub.getSnapshot(key)?.epoch === this.compactEpoch;
      if (!continuing) {
        this.summaryHub.reset({
          source: "compact",
          compactId: this.compactId,
          ...(this.compactLabel ? { label: this.compactLabel } : {}),
          ...(this.compactEpoch ? { epoch: this.compactEpoch } : {}),
          ...(this.summaryGeneration !== undefined ? { generation: this.summaryGeneration } : {}),
        });
      }
      this.activeSummaryKey = key;
    }
  }

  private endSummaryStream(): void {
    if (this.summaryHub && this.activeSummaryKey && this.summaryGenerationCurrent()) {
      this.summaryHub.end(
        this.activeSummaryKey,
        this.summaryGeneration === undefined ? undefined : this.summaryGeneration
      );
    }
    this.parentTaskToolCallId = undefined;
    this.summaryHub = undefined;
    this.compactId = undefined;
    this.compactLabel = undefined;
    this.compactEpoch = undefined;
    this.summaryGeneration = undefined;
    this.activeSummaryKey = undefined;
    this.onUpdate = undefined;
    this.summaryStreamState = { summaryPhaseUnlocked: false };
    this.currentTurnMessageId = undefined;
  }

  private trackSummaryStreamPhase(chunk: StreamChunk): void {
    const messageId = readTextMessageId(chunk);
    if (messageId) {
      this.currentTurnMessageId = messageId;
    }

    if (!this.summaryHub || !this.parentTaskToolCallId || this.compactId) return;
    if (!this.summaryGenerationCurrent()) return;

    const toolName = readToolCallName(chunk);
    if (toolName !== BEGIN_SUMMARY_TOOL_NAME) return;

    this.summaryStreamState = { summaryPhaseUnlocked: true };
    this.summaryHub.reset({
      source: "task",
      toolCallId: this.parentTaskToolCallId,
      ...(this.summaryGeneration !== undefined ? { generation: this.summaryGeneration } : {}),
    });
    this.activeSummaryKey = agentStreamKey("task", this.parentTaskToolCallId);
  }

  private appendSummaryDelta(chunk: StreamChunk): void {
    if (!this.summaryHub || !this.activeSummaryKey) return;
    if (!this.summaryStreamState.summaryPhaseUnlocked) return;
    if (!this.summaryGenerationCurrent()) return;
    const delta = readTextDelta(chunk);
    if (!delta) return;
    this.summaryHub.append(this.activeSummaryKey, delta, {
      epoch: this.compactEpoch,
      ...(this.summaryGeneration !== undefined ? { generation: this.summaryGeneration } : {}),
    });
  }

  private handleMessagesChange(messages: TanStackUIMessage[]): void {
    this.revision += 1;
    this.onUpdate?.(messages);
    // Session `messages` projection — the bus is the single change mechanism.
    this.eventBus?.emit("session:messages", messages);
    // Summary streaming is driven by TEXT_MESSAGE_CONTENT chunks in processChunk —
    // do not diff UIMessage snapshots (that caused mid-stream flicker).
  }
}

/**
 * Attach the core-rendered display payload to completed tool-call parts that lack one.
 *
 * The early-result middleware covers the sequential tool path; batched results and
 * replayed chunks materialize only when the run finalizes. Runs once per turn and is
 * idempotent (a part that already has a payload is left untouched), so restored
 * sessions keep the payload they were persisted with — no history rewrite.
 */
function attachMissingToolDisplays(messages: TanStackUIMessage[]): TanStackUIMessage[] | null {
  type ToolCallPartLike = {
    type?: string;
    id?: string;
    name?: string;
    state?: string;
    output?: unknown;
    arguments?: unknown;
    display?: ToolDisplayPayload;
  };
  const displayableStates = new Set(["complete", "output-available", "output-error"]);

  let changed = false;
  const next = messages.map((message) => {
    const parts = (message as { parts?: ToolCallPartLike[] }).parts;
    if (!parts?.length) return message;

    let touched = false;
    const patched = parts.map((part) => {
      if (part?.type !== "tool-call" || !part.name || part.display) return part;
      if (!part.state || !displayableStates.has(part.state) || part.output === undefined) return part;

      let input: unknown;
      if (typeof part.arguments === "string" && part.arguments) {
        try {
          input = JSON.parse(part.arguments);
        } catch {
          input = undefined;
        }
      }

      const display = computeToolDisplay(part.name, part.output, input);
      if (!display) return part;

      touched = true;
      return { ...part, display };
    });
    if (!touched) return message;

    changed = true;
    return { ...message, parts: patched } as typeof message;
  });

  return changed ? next : null;
}
