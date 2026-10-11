import { findToolCallIdForApproval, findToolCallNameForApproval } from "../../agent/approval/tool-approval-table.js";
import { assertNotCompactionSummaryInput } from "../../agent/compaction";
import { shouldDeferMidRunQueue } from "../../agent/queue/defer-mid-run-queue.js";
import { PendingMessageQueue, type QueueMode } from "../../agent/queue/pending-message-queue.js";
import { runAgentOnce } from "../../agent/run/run-agent-skeleton.js";
import { formatAgentStreamError } from "../../agent/stream/assert-async-iterable.js";
import { stripEmptyAssistantShells } from "../../agent/stream/empty-assistant-shell.js";
import { EMPTY_MODEL_STREAM_MESSAGE, shouldFlagEmptyModelStream } from "../../agent/stream/empty-model-stream.js";
import { extractAssistantText } from "../../agent/stream/extract-assistant-text.js";
import {
  TOOL_CANCELLED_MESSAGE,
  cancelIncompleteToolCalls,
  cancelInFlightToolCalls,
  hasCancellableIncompleteToolCalls,
  hasInFlightToolCalls,
} from "../../agent/stream/incomplete-tool-calls.js";
import {
  hasPendingAskUser,
  hasPendingToolApprovals,
  needsAgentResponseAfterTools,
  needsToolPhaseContinue,
  shouldContinueAgentPump,
} from "../../agent/stream/tool-phase-utils.js";
import { analyzeCommand, createAnalysisContext } from "../../agent/tools/command-safety/command-analyzer.js";
import { evaluateCommandApproval } from "../../agent/tools/command-safety/command-approval-policy.js";
import { AgentUIChannel } from "../../agent/ui-channel.js";

import type { AgentEventBus } from "../../agent/agent-event-bus";
import type { QueuedMessageContent, QueuedMessagesSnapshot } from "../../runtime-types/session-payloads.js";
import type { AgentManager } from "../agent-manager.js";
import type { ManagedAgent } from "../managed-agent.js";
import type { RunToken } from "../run-coordinator.js";
import type { ContentPart, ToolCallPart, UIMessage } from "@tanstack/ai";

const MAX_TOOL_PHASES = 40;

export type { QueuedMessageContent, QueuedMessagesSnapshot } from "../../runtime-types/session-payloads.js";

/**
 * Core-owned main chat session: StreamProcessor + explicit tool-phase continuation.
 * Status transitions are owned by {@link AgentStatusController} via status middleware.
 *
 * Mid-run user input uses two queues (Pi-style):
 * - {@link steer} — delivered after the current assistant/tool batch, before the next LLM call
 * - {@link followUp} — delivered only when the agent would otherwise stop
 */
export class AgentChatController {
  private readonly channel: AgentUIChannel;
  private runChain: Promise<void> = Promise.resolve();
  /** Currency token of the pump in flight — superseded/interrupted tokens go stale. */
  private currentToken: RunToken | null = null;
  /** Nested-safe depth; reset only by the single interrupt owner (see interruptCurrentRun). */
  private pumpDepth = 0;
  /** Pumps queued on {@link runChain} but not yet started (see {@link runPending}). */
  private pendingRuns = 0;

  private readonly steeringQueue = new PendingMessageQueue<QueuedMessageContent>();
  private readonly followUpQueue = new PendingMessageQueue<QueuedMessageContent>();

  /** Unified event bus for the owning agent (session `queues` projection). */
  private eventBus?: AgentEventBus;

  /** @internal Attach the agent's scoped unified event bus. */
  setEventBus(bus: AgentEventBus): void {
    this.eventBus = bus;
    this.channel.setEventBus(bus);
    bus.retain("session:queues", () => this.getQueuedMessages());
  }

  constructor(
    private readonly managed: ManagedAgent,
    private readonly manager: AgentManager,
    initialMessages?: UIMessage[]
  ) {
    this.channel = new AgentUIChannel({ initialMessages });
    this.managed.setUIChannel(this.channel);
  }

  getUIChannel(): AgentUIChannel {
    return this.channel;
  }

  getMessages(): UIMessage[] {
    return this.channel.getMessages();
  }

  setMessages(messages: UIMessage[]): void {
    this.channel.setMessages(messages);
  }

  clearMessages(): void {
    this.clearQueuedMessages();
    this.channel.clearMessages();
    this.managed.resetAdmittedTurnContext();
    this.managed.resetSessionSyncTracker();
    this.managed.statusController.resetToIdle();
    // The cleared transcript must also leave disk, or a later resume brings the
    // conversation the user just discarded back.
    this.persistEmpty();
  }

  stop(): void {
    this.interruptCurrentRun("user-cancelled");
  }

  /** Whether a pump is currently executing (used to refuse conflicting commands). */
  isRunActive(): boolean {
    return this.pumpDepth > 0;
  }

  /**
   * Stop the in-flight pump only when one is actually running.
   *
   * The transcript is about to be replaced (session switch); an interrupted
   * pump would otherwise keep writing chunks into the new session's channel and
   * persist the interleaved result. Unlike {@link stop} this is a no-op when
   * idle, so a plain resume does not emit a spurious abort/finalize or cancel
   * tool calls that merely *look* incomplete in a restored transcript.
   */
  stopIfActive(reason = "session-switch"): void {
    if (this.pumpDepth <= 0) return;
    this.interruptCurrentRun(reason);
  }

  /**
   * Abort the in-flight pump, cancel incomplete tools, and finalize the aborted turn.
   * Invalidates the run token so the old pump exits without double-finalizing.
   */
  private interruptCurrentRun(reason: string): void {
    this.clearQueuedMessages();
    this.managed.statusController.onUserCancel();
    this.managed.abort(reason);
    // Single owner of token invalidation + depth reset. The stale pump's finally
    // skips decrement when its token is not current (it holds a captured token),
    // so a subsequent sendMessage/forceSubmit is neither deferred by the stale
    // pump's queue logic nor desynchronized by its unwinding decrement.
    this.managed.run.invalidateCurrentRun();
    this.pumpDepth = 0;
    // Immediately clear loading tool rows; stream teardown may still finalize later.
    this.applyCancelledIncompleteTools(true);
    // App no longer checkpoints on status — persist cancelled tools on abort.
    this.persistMessages("pump-complete");
    // Turn finalize here: the invalidated token makes the in-flight pump skip its outcome path.
    this.managed.finalizeRun("aborted");
  }

  /** How steering messages are drained at each drain point. */
  setSteeringMode(mode: QueueMode): void {
    this.steeringQueue.mode = mode;
  }

  getSteeringMode(): QueueMode {
    return this.steeringQueue.mode;
  }

  /** How follow-up messages are drained when the agent would stop. */
  setFollowUpMode(mode: QueueMode): void {
    this.followUpQueue.mode = mode;
  }

  getFollowUpMode(): QueueMode {
    return this.followUpQueue.mode;
  }

  getQueuedMessages(): QueuedMessagesSnapshot {
    return {
      steer: [...this.steeringQueue.peekAll()],
      followUp: [...this.followUpQueue.peekAll()],
    };
  }

  clearQueuedMessages(): QueuedMessagesSnapshot {
    const snapshot = {
      steer: this.steeringQueue.clear(),
      followUp: this.followUpQueue.clear(),
    };
    this.notifyQueueListeners();
    return snapshot;
  }

  /**
   * Queue a mid-run correction. Delivered after the current assistant turn / tool batch.
   * When idle, behaves like {@link sendMessage}.
   *
   * NOTE: This is no longer the default Enter keybinding. The default Enter
   * (while running) now calls {@link followUp} — it queues the message for
   * after the agent would naturally stop, then starts a new LLM turn.
   * Option+Enter calls {@link forceSubmit} — it aborts the current run,
   * cancels incomplete tools, injects the message, and starts a new pump.
   * `steer` is kept for programmatic use where you want the message to be
   * delivered within the same turn (before the next LLM call).
   */
  steer(content: QueuedMessageContent): void {
    if (!this.shouldDeferQueue()) {
      void this.sendMessage(content);
      return;
    }
    this.steeringQueue.enqueue(content);
    this.notifyQueueListeners();
  }

  /**
   * Queue a message for after the agent would otherwise stop.
   * When idle, behaves like {@link sendMessage}.
   *
   * This is the default Enter keybinding while the agent is running:
   * the message is delivered only after the current turn completes, then
   * starts a new LLM turn.
   */
  followUp(content: QueuedMessageContent): void {
    // Reject forged compaction markers before they can be queued or land on
    // the channel (marker matching drives compaction checkpoint detection).
    assertNotCompactionSummaryInput(content);
    if (!this.shouldDeferQueue()) {
      void this.sendMessage(content);
      return;
    }
    this.followUpQueue.enqueue(content);
    this.notifyQueueListeners();
  }

  /**
   * Force-submit: abort the current run, cancel incomplete tools, finalize the
   * aborted turn, inject the message, and start a new pump immediately.
   *
   * This is the Option/Ctrl+Enter keybinding while the agent is running.
   */
  forceSubmit(content: string | ContentPart[]): void {
    assertNotCompactionSummaryInput(content);
    this.interruptCurrentRun("force-submit");
    this.channel.addUserMessage(content);
    this.persistMessages("user-message");
    this.managed.statusController.reconcileWithPolicy(this.channel.getMessages(), "during-run");
    void this.enqueueRun();
  }

  sendMessage(content: string | ContentPart[]): Promise<void> {
    // User-authored text must not forge compaction checkpoint markers (see
    // assertNotCompactionSummaryInput in agent/compaction).
    assertNotCompactionSummaryInput(content);
    if (this.shouldDeferQueue()) {
      this.steer(content);
      return Promise.resolve();
    }
    // Only strips truncated/invalid leftover tools — never approval-responded / valid queues.
    this.applyCancelledIncompleteTools();
    this.channel.addUserMessage(content);
    this.persistMessages("user-message");
    return this.enqueueRunOnce();
  }

  respondToToolApproval(approvalId: string, approved: boolean, reason?: string): Promise<void> {
    // The channel stamps the decision time onto the tool-call part (that is what
    // the session log stores); the approval table reuses the same value so the
    // in-memory and persisted timelines never diverge.
    const decidedAt = this.channel.addToolApprovalResponse(approvalId, approved, reason);
    const toolCallId = findToolCallIdForApproval(this.channel.getMessages(), approvalId) ?? approvalId;
    this.managed.approvals.upsert({
      id: approvalId,
      toolCallId,
      status: approved ? "approved" : "denied",
      reason: approved ? undefined : reason,
      toolName: findToolCallNameForApproval(this.channel.getMessages(), approvalId),
      updatedAt: decidedAt,
    });
    this.managed.statusController.reconcileWithPolicy(this.channel.getMessages(), "during-run");
    this.persistMessages("pump-complete");
    // Join a queued pump when one exists rather than scheduling a second for the
    // same decision (see `enqueueRunOnce`).
    return this.enqueueRunOnce();
  }

  addToolResult(toolCallId: string, output: Record<string, unknown>): Promise<void> {
    this.channel.addToolResult(toolCallId, output);
    return this.enqueueRunOnce();
  }

  private shouldDeferQueue(): boolean {
    // A stale (interrupted/superseded) pump still unwinding must not swallow new
    // input into the queues — new submissions execute immediately.
    if (this.currentToken && !this.currentToken.isCurrent) return false;
    // `runPending` closes the same-tick window `pumpDepth` misses: a pump is queued
    // but has not started, so `pumpDepth` is still 0 while the status is already
    // waiting. Deferring here queues the message for that pump instead of enqueueing
    // a second one that would find nothing to do.
    return this.runPending() || shouldDeferMidRunQueue({ pumpDepth: this.pumpDepth, status: this.managed.getStatus() });
  }

  private notifyQueueListeners(): void {
    const snapshot = this.getQueuedMessages();
    // Single notification path: the session `queues` projection on the unified
    // bus (the domain Emitter was removed — see unified-agent-event-bus).
    this.eventBus?.emit("session:queues", snapshot);
  }

  private enqueueRun(): Promise<void> {
    // Recover from a previous rejected pump so later sendMessage/approval calls still run.
    const run = () => this.pumpToolPhases();
    this.runChain = this.runChain.then(run, run);
    return this.runChain;
  }

  /**
   * Whether a pump is queued on {@link runChain} but has not started yet.
   *
   * `pumpDepth` alone cannot answer "will a pump start?": it increments only once
   * the pump begins, so two state changes in the same tick both see 0, each
   * enqueue a pump, and the second finds nothing left to do — status is no longer
   * waiting and tools are done — yet still executes a model turn, producing a reply
   * nobody asked for. Counting the pending chain closes that window.
   */
  private runPending(): boolean {
    return this.pendingRuns > 0;
  }

  /**
   * Enqueue a pump unless one is already queued. The queued pump re-reads the
   * channel, so a change made after it was scheduled (an approval response, a tool
   * result) is handled by that run rather than needing a second one.
   */
  private enqueueRunOnce(): Promise<void> {
    if (this.pendingRuns > 0) return this.runChain;
    this.pendingRuns += 1;
    const run = () => {
      this.pendingRuns -= 1;
      return this.pumpToolPhases();
    };
    this.runChain = this.runChain.then(run, run);
    return this.runChain;
  }

  private drainSteerIntoChannel(): boolean {
    const items = this.steeringQueue.drain();
    if (items.length === 0) return false;
    for (const content of items) {
      this.channel.addUserMessage(content);
    }
    this.notifyQueueListeners();
    this.persistMessages("user-message");
    return true;
  }

  private drainFollowUpIntoChannel(): boolean {
    const items = this.followUpQueue.drain();
    if (items.length === 0) return false;
    for (const content of items) {
      this.channel.addUserMessage(content);
    }
    this.notifyQueueListeners();
    this.persistMessages("user-message");
    return true;
  }

  private hasQueuedMessages(): boolean {
    return this.steeringQueue.hasItems() || this.followUpQueue.hasItems();
  }

  private shouldKeepPumping(messages: UIMessage[]): boolean {
    return shouldContinueAgentPump(messages) || this.hasQueuedMessages();
  }

  /**
   * After tools finish (or when idle between turns): inject steer before the next LLM call.
   * Follow-up only when the agent would otherwise stop.
   * Returns false when the pump should exit.
   */
  private prepareContinuationPhase(messages: UIMessage[]): { continue: boolean; messages: UIMessage[] } {
    if (needsToolPhaseContinue(messages)) {
      // Still executing / resuming tools — do not inject user messages yet.
      this.managed.markNextPrepareAsContinuation();
      return { continue: true, messages };
    }

    const steered = this.drainSteerIntoChannel();
    let current = this.channel.getMessages();

    if (steered || needsAgentResponseAfterTools(current)) {
      this.managed.markNextPrepareAsContinuation();
      return { continue: true, messages: current };
    }

    const followed = this.drainFollowUpIntoChannel();
    if (!followed) {
      return { continue: false, messages: current };
    }
    current = this.channel.getMessages();
    this.managed.markNextPrepareAsContinuation();
    return { continue: true, messages: current };
  }

  private async pumpToolPhases(): Promise<void> {
    const token = this.managed.run.beginRun();
    this.currentToken = token;
    const turnStart = Date.now();
    this.pumpDepth += 1;
    this.managed.resetTurnLifecycle();
    this.managed.clearPrepareAsContinuation();
    this.managed.setError("");
    // Safe: skips approval-responded and valid input-complete (needed for `y` / tool-phase).
    this.applyCancelledIncompleteTools();

    let hasError = false;
    let toolPhases = 0;
    const messages = this.channel.getMessages();
    this.managed.statusController.prepareRunPhase(messages);

    try {
      for (let toolPhase = 0; toolPhase < MAX_TOOL_PHASES; toolPhase++) {
        if (hasError) break;
        if (!token.isCurrent) return;

        let currentMessages = this.channel.getMessages();
        if (hasPendingToolApprovals(currentMessages)) break;
        if (hasPendingAskUser(currentMessages)) break;

        if (toolPhase > 0) {
          const prepared = this.prepareContinuationPhase(currentMessages);
          if (!prepared.continue) break;
          currentMessages = prepared.messages;
        }

        await this.executeStream(currentMessages, token);
        toolPhases = toolPhase + 1;
        if (this.managed.getStatus() === "error") {
          hasError = true;
        }
        if (!token.isCurrent) {
          // Stream may have finalized truncated tool args after Esc — cancel again.
          this.applyCancelledIncompleteTools(true);
          this.persistMessages("pump-complete");
          return;
        }

        this.syncPlanModeFromMessages();

        // Auto-approve tools during plan execution so the agent can
        // run without waiting for user confirmation on each tool call.
        this.autoApprovePendingTools();
        // Command-safety approval rules (no-op in auto mode / plan execution).
        await this.applyApprovalRules();

        const after = this.channel.getMessages();
        if (hasPendingToolApprovals(after)) break;
        if (hasPendingAskUser(after)) break;
        if (!this.shouldKeepPumping(after)) break;
      }

      if (token.isCurrent) {
        this.syncPlanModeFromMessages();
        const messages = this.channel.getMessages();
        const waitingForUser = hasPendingToolApprovals(messages) || hasPendingAskUser(messages);
        const keepPumping = !waitingForUser && this.shouldKeepPumping(messages);
        // Prefer status already set by executeStream (error/abort) over message-derived waits.
        const outcomeKind =
          this.managed.getStatus() === "aborted"
            ? "aborted"
            : hasError || this.managed.getStatus() === "error"
              ? "error"
              : waitingForUser
                ? "waiting"
                : "finished";

        // Phase cap or early stream end while tools/model still need work — chain
        // another pump without finalizing the turn (avoids stale "running" + trapped queues).
        if (keepPumping && outcomeKind === "finished") {
          this.managed.statusController.reconcileWithPolicy(messages, "during-run");
          this.persistMessages("pump-complete");
          void this.enqueueRun();
          return;
        }

        this.managed.statusController.applyRunOutcome({
          kind: outcomeKind,
          messages,
          path: "chat",
          // Only supply a message when status is not already error (avoids duplicate stream-error).
          errorMessage:
            outcomeKind === "error" && this.managed.getStatus() !== "error"
              ? this.managed.getError() || "Stream execution failed"
              : undefined,
        });
        this.persistMessages("pump-complete");

        // Waiting (approval / ask_user) keeps turn context for the resume pump.
        if (outcomeKind === "finished" || outcomeKind === "aborted" || outcomeKind === "error") {
          this.managed.finalizeRun(outcomeKind);
        }

        const totalUsage = this.managed.usage?.getTotal();
        const toolCallCount = this.channel
          .getMessages()
          .filter((m) => m.role === "assistant")
          .reduce((count, m) => count + m.parts.filter((p) => p.type === "tool-call").length, 0);
        this.managed.emitEvent("turn:summary", {
          ...(outcomeKind !== "waiting" ? { outcome: outcomeKind } : {}),
          phases: toolPhases,
          toolCalls: toolCallCount,
          inputTokens: totalUsage?.inputTokens ?? 0,
          outputTokens: totalUsage?.outputTokens ?? 0,
          cacheReadTokens: totalUsage?.cacheReadTokens ?? 0,
          cacheWriteTokens: totalUsage?.cacheWriteTokens ?? 0,
          costUsd: this.managed.usage?.getTotalCostUsd() ?? 0,
          durationMs: Date.now() - turnStart,
        });
      }
    } finally {
      // A non-current (interrupted/superseded) pump must not decrement: the
      // interrupt owner already reset depth to 0, and the decrement would
      // otherwise steal depth from a newer pump. No Math.max guard needed.
      if (token.isCurrent) this.pumpDepth -= 1;
    }
  }

  private async executeStream(messages: UIMessage[], token: RunToken): Promise<void> {
    // AbortController is created inside prepareForRun (via runAgentStream) and wired
    // directly into TanStack chat. Do not create a second controller here — that used
    // to leave ManagedAgent.abort() aborting a controller chat was not listening to.
    // Outcome finalization (path: "chat") stays in pumpToolPhases after the full loop.
    const messagesBefore = messages;
    try {
      await runAgentOnce({
        manager: this.manager,
        agentId: this.managed.id,
        messages,
        channel: this.channel,
      });
      if (!token.isCurrent || this.managed.getStatus() === "aborted") {
        this.applyCancelledIncompleteTools(true);
        return;
      }

      // OpenAI-compatible streaming against SSO/HTML (HTTP 200) can yield zero chunks
      // without throwing. Treat "no model progress" as an error instead of Completed.
      const messagesAfter = this.channel.getMessages();
      if (shouldFlagEmptyModelStream(messagesBefore, messagesAfter) && this.managed.getStatus() !== "error") {
        this.managed.statusController.onRunError(EMPTY_MODEL_STREAM_MESSAGE);
        this.managed.log?.error("agent", EMPTY_MODEL_STREAM_MESSAGE);
        return;
      }

      this.managed.statusController.reconcileWithPolicy(messagesAfter, "during-run");
    } catch (err) {
      if (!token.isCurrent || this.managed.getStatus() === "aborted") {
        this.applyCancelledIncompleteTools(true);
        return;
      }
      const error = err instanceof Error ? err : new Error(String(err));
      const message = formatAgentStreamError(error).message;
      if (this.managed.isAbortError(err)) {
        this.managed.statusController.onExternalError(message, true);
        this.applyCancelledIncompleteTools(true);
      } else {
        // Surface stream failures in status + agent:stream-error (not silent Completed).
        this.managed.statusController.onRunError(message);
        this.managed.log?.error("agent", "Stream execution failed", error);
      }
      // Do not rethrow — hosts often do not catch sendMessage; an unhandled rejection
      // aborts the entire CLI process. Status/error on ManagedAgent is the signal.
    }
  }

  /**
   * Mark aborted/truncated tool calls so they stop loading and are not resumed
   * by the next pump. When {@link includeInFlight} (abort paths only), also
   * finalizes currently-executing tools as `complete` + user-cancel — this is the
   * framework fallback that lets extension/MCP tools benefit automatically even
   * if their execute never resolved before the run was torn down.
   */
  private applyCancelledIncompleteTools(includeInFlight = false): void {
    const current = this.channel.getMessages();
    const hasCancellable =
      hasCancellableIncompleteToolCalls(current) || (includeInFlight && hasInFlightToolCalls(current));
    if (!hasCancellable) return;
    let cancelled = cancelIncompleteToolCalls(current, TOOL_CANCELLED_MESSAGE);
    if (includeInFlight) cancelled = cancelInFlightToolCalls(cancelled, TOOL_CANCELLED_MESSAGE);
    const cleaned = stripEmptyAssistantShells(cancelled);
    this.channel.setMessages(cleaned);
  }

  private persistMessages(reason: "user-message" | "pump-complete"): void {
    const messages = this.channel.getMessages();
    if (messages.length > 0) {
      this.managed.maybeSaveSessionUIMessages(messages, reason);
    }
  }

  /**
   * Persist an empty transcript over the current session file.
   *
   * `persistMessages` above is a no-op on an empty channel, and the persist
   * helpers early-return on an empty array too — so `/clear` used to leave the
   * cleared messages on disk and a later resume resurrected them. This is the one
   * path that must write the empty list.
   */
  persistEmpty(): void {
    this.managed.clearPersistedSession();
  }

  /** Extract ## Plan / [DONE:n] from the latest assistant text while plan mode is active. */
  private syncPlanModeFromMessages(): void {
    if (this.managed.planMode.getPhase() === "off") return;
    const text = extractAssistantText(this.channel.getMessages());
    if (text) this.managed.planMode.onAssistantText(text);
  }

  /**
   * Apply command-safety approval rules to pending run_command tool calls.
   *
   * Runs after {@link autoApprovePendingTools}. In auto mode / plan execution
   * it is a no-op (everything was already auto-approved). Otherwise the
   * tree-sitter command policy runs: project-internal read-only commands are
   * auto-approved, denies are answered with a reason (visible to the LLM), and
   * anything uncertain stays pending for the user's y/n decision.
   */
  private async applyApprovalRules(): Promise<void> {
    if (this.managed.shouldAutoApprovePendingTools()) return;

    const messages = this.channel.getMessages();
    let handled = false;

    for (const part of messages.flatMap((m) => m.parts)) {
      if (part.type !== "tool-call") continue;
      const toolCall = part as ToolCallPart;
      if (toolCall.name !== "run_command") continue;
      if (toolCall.approval?.needsApproval !== true || toolCall.approval.approved !== undefined) continue;
      const approvalId = toolCall.approval.id;
      const input = parseToolCallInput(toolCall);
      const command = input?.command;
      if (!approvalId || !command) continue;

      const ctx = await createAnalysisContext();
      const report = await analyzeCommand(command, ctx);
      const decision = evaluateCommandApproval(report, { agentKind: "root" });

      if (decision.action === "allow") {
        const decidedAt = this.channel.addToolApprovalResponse(approvalId, true);
        this.managed.approvals.upsert({
          id: approvalId,
          toolCallId: toolCall.id,
          status: "approved",
          toolName: toolCall.name,
          updatedAt: decidedAt,
        });
        handled = true;
      } else if (decision.action === "deny") {
        const decidedAt = this.channel.addToolApprovalResponse(approvalId, false, decision.reason);
        this.managed.approvals.upsert({
          id: approvalId,
          toolCallId: toolCall.id,
          status: "denied",
          reason: decision.reason,
          toolName: toolCall.name,
          updatedAt: decidedAt,
        });
        handled = true;
      }
      // ask → keep pending so the user can approve/deny (y/n).
    }

    if (handled) {
      this.managed.statusController.reconcileWithPolicy(this.channel.getMessages(), "during-run");
      this.persistMessages("pump-complete");
    }
  }

  /**
   * Auto-approve pending tools when auto mode is on, or plan mode is building.
   */
  private autoApprovePendingTools(): void {
    if (!this.managed.shouldAutoApprovePendingTools()) return;

    const messages = this.channel.getMessages();
    let didApprove = false;

    for (const part of messages.flatMap((m) => m.parts)) {
      if (part.type !== "tool-call") continue;
      const toolCall = part as ToolCallPart;
      if (toolCall.approval?.needsApproval === true && toolCall.approval.approved === undefined) {
        const approvalId = toolCall.approval.id;
        if (approvalId) {
          const decidedAt = this.channel.addToolApprovalResponse(approvalId, true);
          this.managed.approvals.upsert({
            id: approvalId,
            toolCallId: toolCall.id,
            status: "approved",
            toolName: toolCall.name,
            updatedAt: decidedAt,
          });
          didApprove = true;
        }
      }
    }

    if (didApprove) {
      this.managed.statusController.reconcileWithPolicy(this.channel.getMessages(), "during-run");
      this.persistMessages("pump-complete");
    }
  }
}

/** Format stream errors for display (re-export for app convenience). */
export function formatChatError(error: Error | null): string | null {
  if (!error) return null;
  return formatAgentStreamError(error).message;
}

/**
 * Safely extract a tool-call's parsed input, falling back to the raw
 * `arguments` JSON string when `input` is not yet populated.
 */
function parseToolCallInput(toolCall: ToolCallPart): { command?: string } | undefined {
  if (toolCall.input) {
    return toolCall.input as { command?: string };
  }
  try {
    const parsed = JSON.parse(toolCall.arguments ?? "{}") as { command?: string };
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}
