import { assertNotCompactionSummaryInput } from "../../agent/compaction";
import { shouldDeferMidRunQueue } from "../../agent/queue/defer-mid-run-queue.js";
import { PendingMessageQueue, type QueueMode } from "../../agent/queue/pending-message-queue.js";
import { runManagedSpan } from "../../agent/run/managed-span.js";
import { formatAgentStreamError } from "../../agent/stream/assert-async-iterable.js";
import { stripEmptyAssistantShells } from "../../agent/stream/empty-assistant-shell.js";
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
import { peekTaskPreforkCoordinator } from "../../agent/subagent/task-prefork.js";
import { AgentUIChannel } from "../../agent/ui/ui-channel.js";
import { ApprovalDecisionCoordinator } from "../approval-decision-coordinator.js";

import type { AgentEventBus } from "../../agent/agent-event-bus";
import type { QueuedMessageContent, QueuedMessagesSnapshot } from "../../runtime-types/session-payloads.js";
import type { AgentManager } from "../agent-manager.js";
import type { ManagedAgent } from "../managed-agent.js";
import type { RunToken } from "../run-coordinator.js";
import type { ContentPart, UIMessage } from "@tanstack/ai";

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
  /** Channel/table/status/persist/repump transaction for approval decisions. */
  private readonly approvalDecisions: ApprovalDecisionCoordinator;

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
    this.approvalDecisions = new ApprovalDecisionCoordinator({
      getMessages: () => this.channel.getMessages(),
      addToolApprovalResponse: (approvalId, approved, reason) =>
        this.channel.addToolApprovalResponse(approvalId, approved, reason),
      upsertApproval: (input) => this.managed.approvals.upsert(input),
      shouldAutoApprove: () => this.managed.shouldAutoApprovePendingTools(),
      reconcile: () => this.managed.statusController.reconcileWithPolicy(this.channel.getMessages(), "during-run"),
      persist: () => this.persistMessages("pump-complete"),
      enqueueRun: () => this.enqueueRunOnce(),
      getCoreEnv: () => this.managed.getCoreEnv(),
    });
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

  clearMessages(options: { persistEmpty?: boolean } = {}): void {
    this.clearQueuedMessages();
    this.channel.clearMessages();
    this.managed.resetAdmittedTurnContext();
    this.managed.resetSessionSyncTracker();
    this.managed.statusController.resetToIdle();
    // The unhydratable `media://` refs lived in the transcript just dropped, so the wire seam's arm
    // goes with it — `/clear` does not run `reset()`, and a stale arm would keep the per-call part
    // walk alive for the rest of the agent's life. A later restore re-arms it from its own misses.
    this.managed.setMediaHydrationMisses(0);
    // The cleared transcript must also leave disk, or a later resume brings the
    // conversation the user just discarded back. A caller that is about to rotate
    // sessions flushes the empty write itself against the old session first.
    if (options.persistEmpty !== false) this.persistEmpty();
  }

  stop(): void {
    this.interruptCurrentRun("user-cancelled");
  }

  /** Whether a pump is currently executing (used to refuse conflicting commands). */
  isRunActive(): boolean {
    return this.pumpDepth > 0;
  }

  /**
   * Stop the in-flight run when any part of it is still running.
   *
   * `pumpDepth` is not the whole question. A run PAUSED for an approval or a client tool has no live
   * pump, yet it can still have eagerly started `task` subagents streaming into the channel this is
   * about to replace — nothing else will join them, and this is their only stop, so a registered
   * pre-fork is reason enough to stop the run. With neither a pump nor a pre-fork it stays a no-op,
   * so a plain resume fires no spurious abort/finalize.
   */
  stopIfActive(reason = "session-switch"): void {
    const registeredPrefork = peekTaskPreforkCoordinator(this.managed)?.size ?? 0;
    if (this.pumpDepth <= 0 && registeredPrefork === 0) return;
    this.interruptCurrentRun(reason);
  }

  /**
   * Abort the in-flight pump, cancel incomplete tools, and finalize the aborted turn.
   * Invalidates the run token so the old pump exits without double-finalizing.
   */
  private interruptCurrentRun(reason: string, options: { keepQueue?: boolean } = {}): void {
    // A plain abort DROPS pending input (the footer hint says so); force-submit interrupts the run to send
    // something NOW, which must not discard what the user queued before it — that is the `keepQueue` case,
    // and the cleared snapshot would otherwise be thrown away.
    if (!options.keepQueue) this.clearQueuedMessages();
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

  /**
   * Take back the most recently queued message, or null when nothing is queued.
   *
   * The queue is otherwise a one-way door: a queued message can only be waited for or dropped with the
   * whole queue (`Esc`). Follow-up first, because that is the queue Enter fills and its tail is the last
   * message written; steer is only enqueued programmatically on the CLI, so it is the fallback.
   */
  popQueuedMessage(): { kind: "steer" | "followUp"; content: QueuedMessageContent } | null {
    const followUp = this.followUpQueue.popLast();
    if (followUp !== undefined) {
      this.notifyQueueListeners();
      return { kind: "followUp", content: followUp };
    }
    const steer = this.steeringQueue.popLast();
    if (steer !== undefined) {
      this.notifyQueueListeners();
      return { kind: "steer", content: steer };
    }
    return null;
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
   *
   * Anything already queued is KEPT and delivered after this message, in the order it was written — the
   * interrupt stops the run, not the user's other input.
   */
  forceSubmit(content: string | ContentPart[]): void {
    assertNotCompactionSummaryInput(content);
    this.interruptCurrentRun("force-submit", { keepQueue: true });
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
    return this.approvalDecisions.respondToToolApproval(approvalId, approved, reason);
  }

  /**
   * Approve every pending tool approval, then resume the pump.
   *
   * A pending approval is a QUESTION, and turning on auto mode (or entering plan execution, which
   * auto-approves) has just answered it. Leaving it pending is not neutral: the pump is parked on
   * it, so the session looks like it is running auto mode while nothing runs. The TUI used to answer
   * these from its `/mode` command — a host-side workaround that the protocol hosts (ACP, remote
   * sessions) never had, which is why switching to auto mid-approval did nothing there.
   *
   * One channel write per approval (the channel is the SoT) with the approval table kept in step,
   * then ONE pump enqueue: `enqueueRunOnce` joins, so N decisions do not schedule N pumps.
   */
  approvePendingApprovals(): Promise<void> {
    return this.approvalDecisions.approvePendingApprovals();
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
        this.approvalDecisions.autoApprovePending();
        // Command-safety approval rules (no-op in auto mode / plan execution).
        await this.approvalDecisions.applyCommandSafetyPolicy();

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
        const outcomeKind = this.managed.runFinalizer.deriveChatOutcome({ hasError, waitingForUser });

        // Phase cap or early stream end while tools/model still need work — chain
        // another pump without finalizing the turn (avoids stale "running" + trapped queues).
        if (keepPumping && outcomeKind === "finished") {
          this.managed.statusController.reconcileWithPolicy(messages, "during-run");
          this.persistMessages("pump-complete");
          void this.enqueueRun();
          return;
        }

        this.managed.runFinalizer.finalizeChat({
          kind: outcomeKind,
          messages,
          waitingForUser,
          phases: toolPhases,
          turnStartedAt: turnStart,
          persist: () => this.persistMessages("pump-complete"),
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
    const result = await runManagedSpan({
      manager: this.manager,
      agentId: this.managed.id,
      messages,
      channel: this.channel,
      flagEmptyStream: true,
      abortErrorAsCancel: false,
      onAbort: () => this.applyCancelledIncompleteTools(true),
      onAbortError: (message) => {
        if (!token.isCurrent || this.managed.getStatus() === "aborted") return;
        this.managed.statusController.onExternalError(message, true);
        this.applyCancelledIncompleteTools(true);
      },
      onEmpty: (message) => {
        if (!token.isCurrent || this.managed.getStatus() === "error") return;
        this.managed.statusController.onRunError(message);
        this.managed.log?.error("agent", message);
      },
      onError: (message, error) => {
        if (!token.isCurrent || this.managed.getStatus() === "aborted") return;
        // Surface stream failures in status + agent:stream-error (not silent Completed).
        this.managed.statusController.onRunError(message);
        this.managed.log?.error("agent", "Stream execution failed", error);
      },
    });

    if (!token.isCurrent || this.managed.getStatus() === "aborted") {
      this.applyCancelledIncompleteTools(true);
      return;
    }
    if (result.aborted) return; // onAbort already applied the framework fallback
    if (result.errorMessage) {
      // onError / onAbortError / onEmpty already set the status and logged the fault. Reconciling
      // here would let a pending approval turn an empty-stream error back into `waiting`.
      return;
    }

    this.managed.statusController.reconcileWithPolicy(result.messages, "during-run");
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
}

/** Format stream errors for display (re-export for app convenience). */
export function formatChatError(error: Error | null): string | null {
  if (!error) return null;
  return formatAgentStreamError(error).message;
}
