/* eslint-disable max-lines -- Chat run orchestration. One loop owns admission, the mid-run queue
   (steer / follow-up / force-submit), the switch refusal contract, approval answering and
   stream-outcome finalization; those are separate protocols but their ORDER is the invariant, so
   moving one out would separate a decision from the loop that enforces it. The refusal gate and
   the queue drain helpers are the next extracted unit; the `SendMessageOutcome` contract added here
   is what pushed the file over the ceiling. */
import { assertNotCompactionSummaryInput } from "../../agent/compaction";
import { shouldDeferMidRunQueue } from "../../agent/queue/defer-mid-run-queue.js";
import { PendingMessageQueue, type QueueMode } from "../../agent/queue/pending-message-queue.js";
import { runManagedSpan } from "../../agent/run/managed-span.js";
import { stripEmptyAssistantShells } from "../../agent/stream/empty-assistant-shell.js";
import { extractAssistantText } from "../../agent/stream/extract-assistant-text.js";
import {
  TOOL_CANCELLED_MESSAGE,
  settleToolCalls,
  hasCancellableIncompleteToolCalls,
  hasInFlightToolCalls,
} from "../../agent/stream/incomplete-tool-calls.js";
import { findToolCallPart } from "../../agent/stream/suppress-replayed-tool-chunks.js";
import {
  hasPendingAskUser,
  hasPendingInteraction,
  needsAgentResponseAfterTools,
  needsToolPhaseContinue,
  shouldContinueAgentPump,
} from "../../agent/stream/tool-phase-utils.js";
import { peekTaskPreforkCoordinator } from "../../agent/subagent/subagent-runs.js";
import { CLIENT_TOOL_NAMES } from "../../agent/tools/catalog/tool-names.js";
import { AgentUIChannel } from "../../agent/ui/ui-channel.js";
import { toError } from "../../utils/errors.js";
import { ApprovalDecisionCoordinator } from "../approval-decision-coordinator.js";
import { countToolCalls } from "../run-finalizer.js";

import type { AgentEventBus } from "../../agent/agent-event-bus";
import type { AgentStatus } from "../../runtime-types/agent-status.js";
import type { QueuedMessageContent, QueuedMessagesSnapshot } from "../../runtime-types/session-payloads.js";
import type { AgentManager } from "../agent-manager.js";
import type { ManagedAgent } from "../managed-agent.js";
import type { RunToken } from "../run-coordinator.js";
import type { ContentPart, UIMessage } from "@tanstack/ai";

const MAX_TOOL_PHASES = 40;

/** Statuses a background completion may wake (see {@link AgentChatController.wakeForBackgroundCompletion}). */
const WAKEABLE_STATUSES: ReadonlySet<AgentStatus> = new Set<AgentStatus>(["idle", "completed"]);

/**
 * What happened to a submitted message.
 *
 * `dropped` is a REFUSAL, not a silent success: a session switch (unload → load) is in flight, so
 * the text belongs to neither the transcript being replaced nor the target the user has not seen
 * yet. Hosts must report it back to the user instead of clearing their input on a false `ok`.
 */
export type SendMessageOutcome = "sent" | "queued" | "dropped";

export type { QueuedMessageContent, QueuedMessagesSnapshot } from "../../runtime-types/session-payloads.js";

/** Plain text of a queued message: the string itself, or the text parts of a content array. */
function queuedContentText(content: QueuedMessageContent): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      const record = part as { text?: unknown; content?: unknown };
      if (typeof record.text === "string") return record.text;
      if (typeof record.content === "string") return record.content;
      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

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
  /**
   * Epoch of the single pump queued on {@link runChain} but not yet started. A stale
   * callback must not clear a newer epoch's slot; `null` means no current-epoch pump
   * is pending (stale callbacks may still be in the chain).
   */
  private pendingRunEpoch: number | null = null;
  /**
   * Session-generation token for queued pumps. A pump captures this when scheduled;
   * `clearTranscript` / `stopIfActive` advance it so work queued for the old
   * transcript cannot start a real LLM turn after a clear/resume.
   */
  private lifecycleEpoch = 0;

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
      addToolApprovalResponse: (approvalId, approved, reason, overwrite) =>
        this.channel.addToolApprovalResponse(
          approvalId,
          approved,
          reason,
          undefined,
          overwrite ? { overwrite } : undefined
        ),
      upsertApproval: (input) => this.managed.getApprovals().upsert(input),
      shouldAutoApprove: () => this.managed.shouldAutoApprovePendingTools(),
      reconcile: () => this.managed.statusController.reconcileWithPolicy(this.channel.getMessages(), "during-run"),
      persist: () => this.persistMessages("pump-complete"),
      enqueueRun: () => this.enqueueRunOnce(),
      isSessionSwitching: () => this.managed.isSessionSwitching(),
      getCoreEnv: () => this.managed.getCoreEnv(),
      isIncumbentTool: (name) => this.managed.toolService.isIncumbent(name),
      reportDiagnostic: (message, details) =>
        this.managed.emitEvent("session:diagnostic", {
          area: "tool",
          level: "warn",
          message,
          ...(details ? { details } : {}),
        }),
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

  /** Advance the queued-pump generation and invalidate the current pending slot. */
  private advanceLifecycleEpoch(): void {
    this.lifecycleEpoch += 1;
    this.pendingRunEpoch = null;
  }

  /** Drop queued and visible transcript state only; lifecycle owns the other resets. */
  clearTranscript(): void {
    this.advanceLifecycleEpoch();
    this.clearQueuedMessages();
    this.channel.clearMessages();
  }

  /** A pump is executing or queued. Distinct from "the run is parked on the user". */
  private isPumpLive(): boolean {
    return this.pumpDepth > 0 || this.runPending();
  }

  stop(): void {
    // A switch is unload → load: the run being abandoned there already has its stop (the unload
    // half), and a late Esc must not cancel an approval the target session restored after commit.
    if (this.dropIfSwitching("stop")) return;
    // A manual `/compact` has no pump, but it is still the user's Esc target: the summarizer is a
    // real model call. Aborting it must stop BOTH the summary and anything queued behind it — the
    // same verdict an Esc reaches on the auto path (where the pump is live, so it lands below).
    // Without this branch the guard below returned early and Esc did nothing at all.
    if (this.managed.compactions.ownsManual()) {
      this.clearQueuedMessages();
      this.managed.compactions.cancel("user-cancelled");
      return;
    }
    // An idle stop is not a run: it must not abort a completed turn's controller (that signal is
    // still held by finalize-time memory extraction, and aborting it cancelled work the run had
    // already started), nor emit `agent:abort` for a run that does not exist. A run PARKED on an
    // approval has no live pump but is still the user's Esc target, so a pending interaction is
    // reason enough — as is a live pump, a queued pump, or an eagerly started `task` subagent.
    const registeredPrefork = peekTaskPreforkCoordinator(this.managed)?.size ?? 0;
    if (!this.isPumpLive() && registeredPrefork === 0 && !hasPendingInteraction(this.channel.getMessages())) return;
    this.interruptCurrentRun("user-cancelled");
  }

  /**
   * Whether a pump is executing or queued, OR the run is parked on a user interaction (tool
   * approval / `ask_user`), OR a manual `/compact` owns the agent.
   *
   * The parked case matters: `pumpDepth` is 0 and nothing is queued while the agent waits, yet
   * the turn is still open. `/compact` inside that window appended a checkpoint in front of a
   * tool loop that had not finished, and `/clone` / `/fork` dehydrated a branch whose last turn
   * can never complete.
   *
   * The compaction term matters for the same reason one level up: a manual `/compact` is a real
   * summarizer call running with **no pump**, so every check keyed on the pump reported "idle".
   * Anything that promises "the transcript is settled" (`/clone`, `/fork`) must see it.
   */
  isRunActive(): boolean {
    return (
      this.isPumpLive() || hasPendingInteraction(this.channel.getMessages()) || this.managed.compactions.isRunning()
    );
  }

  /**
   * Stop the in-flight run when any part of it is still running.
   *
   * `pumpDepth` is not the whole question. A run PAUSED for an approval or a client tool has no live
   * pump, yet it can still have eagerly started `task` subagents streaming into the channel this is
   * about to replace — nothing else will join them, and this is their only stop, so a registered
   * pre-fork is reason enough to stop the run. With neither a pump nor a pre-fork it stays a no-op,
   * so a plain resume fires no spurious abort/finalize. The parked-interaction term is deliberately
   * absent here: a session switch replaces a parked session instead of fabricating an abort for it.
   */
  stopIfActive(reason = "session-switch"): void {
    const registeredPrefork = peekTaskPreforkCoordinator(this.managed)?.size ?? 0;
    if (!this.isPumpLive() && registeredPrefork === 0) return;
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
    this.advanceLifecycleEpoch();
    // Abort BEFORE recording the new status. `abortManagedAgentRun` emits `agent:abort` only when
    // the agent is still in an active status — that is its "a run was actually interrupted" test —
    // so flipping the status first made the Esc path (the main cancel path) silent while parked
    // agents, which `onUserCancel` does not touch, still reported. The exact inverse of the intent:
    // the log bridge never wrote its abort row and `agent:abort` observers (memory selection
    // discard) never ran on a real cancel.
    this.managed.abort(reason);
    this.managed.statusController.onUserCancel();
    // Single owner of token invalidation + depth reset. The stale pump's finally
    // skips decrement when its token is not current (it holds a captured token),
    // so a subsequent sendMessage/forceSubmit is neither deferred by the stale
    // pump's queue logic nor desynchronized by its unwinding decrement.
    this.managed.run.invalidateCurrentRun();
    this.pumpDepth = 0;
    // Immediately clear loading tool rows; stream teardown may still finalize later.
    this.applyCancelledIncompleteTools(true);
    // An approval prompt is a question the interrupted turn no longer has. Leaving it pending
    // kept the part in `interactions.approvals` while the run was over: the next input was
    // admitted against a status that said `aborted`, then parked on the old question forever.
    // Deny here (channel write + table) so the turn ends with no unanswered interaction.
    this.approvalDecisions.denyPendingApprovals(TOOL_CANCELLED_MESSAGE);
    // The deny rewrote the channel AFTER the last status flip, so the retained count would
    // otherwise keep reporting the approvals that no longer exist (snapshot / ACP consumers).
    this.managed.setPendingApprovalCount(0);
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
   * Release input that queued while a manual `/compact` held the agent.
   *
   * A manual compaction runs with no pump (`pumpDepth === 0`), so `shouldDeferMidRunQueue` now
   * queues the user's message instead of starting a second turn over a half-finished compaction.
   * Nothing would ever drain that queue — the queue drains inside a pump — so the compaction's
   * completion has to hand the message over and start the turn it was always meant to start.
   *
   * A CANCELLED compaction is a different outcome: `stop()` clears the queue first (Esc aborts and
   * drops pending input, exactly as it does for a run), so this is a no-op there.
   */
  resumeAfterCompaction(): void {
    // A switch is unload → load: the queues belong to the session being left and are cleared by
    // the unload half, so there is nothing to release into the target.
    if (this.dropIfSwitching("resume-after-compaction")) return;
    // A late `compact()` finally (its lease superseded by a NEW compaction) must not drain input
    // that belongs to the new compaction's turn into a pump beside its summarizer.
    if (this.managed.compactions.isRunning()) return;
    if (!this.hasQueuedMessages()) return;
    const drained = this.drainSteerIntoChannel() || this.drainFollowUpIntoChannel();
    if (drained) void this.enqueueRunOnce();
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
  steer(content: QueuedMessageContent): boolean {
    // The message belongs to the transcript that is being replaced. Do not queue it: the unload
    // half clears the queues, and re-targeting it at the session the user has not seen yet would
    // deliver input they wrote about the old conversation.
    if (this.dropIfSwitching("steer")) return false;
    if (!this.shouldDeferQueue()) {
      void this.sendMessage(content);
      return true;
    }
    this.steeringQueue.enqueue(content);
    this.notifyQueueListeners();
    return true;
  }

  /**
   * Queue a message for after the agent would otherwise stop.
   * When idle, behaves like {@link sendMessage}.
   *
   * This is the default Enter keybinding while the agent is running:
   * the message is delivered only after the current turn completes, then
   * starts a new LLM turn.
   */
  followUp(content: QueuedMessageContent): boolean {
    // Reject forged compaction markers before they can be queued or land on
    // the channel (marker matching drives compaction checkpoint detection).
    assertNotCompactionSummaryInput(content);
    // Same policy as `steer`: input offered mid-switch is dropped, not queued for a transcript
    // the unload half is about to clear.
    if (this.dropIfSwitching("follow-up")) return false;
    if (!this.shouldDeferQueue()) {
      void this.sendMessage(content);
      return true;
    }
    this.followUpQueue.enqueue(content);
    this.notifyQueueListeners();
    return true;
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
  forceSubmit(content: string | ContentPart[]): boolean {
    assertNotCompactionSummaryInput(content);
    // A switch is unload → load. The message is about the session being left, so it is dropped
    // here — queueing it would either be cleared by the unload or delivered to a transcript the
    // user has not seen yet.
    if (this.dropIfSwitching("force-submit")) return false;
    // A manual `/compact` is work in flight with NO pump, so there is nothing to interrupt: the
    // message would start a pump beside the summarizer, appending the checkpoint inside a
    // half-finished turn and resetting the window usage the new turn is accumulating. Queue it —
    // `resumeAfterCompaction()` releases exactly like a follow-up when the compaction ends.
    //
    // `ownsManual()`, not `isRunning()`: auto/reactive compaction runs INSIDE a live pump, and
    // there the interrupt is exactly what the user asked for (`isRunActive()` below handles it).
    if (this.managed.compactions.ownsManual()) {
      this.followUp(content);
      return true;
    }
    // Only a live run is interrupted. On an idle agent `interruptCurrentRun` emitted `agent:abort`
    // and finalized an "aborted" turn that never existed (`agent:stop` with no `turn:start`), which
    // inflates any consumer that counts runs by `agent:stop`.
    if (this.isRunActive() || this.managed.run.isCurrentRunValid()) {
      this.interruptCurrentRun("force-submit", { keepQueue: true });
    }
    this.channel.addUserMessage(content);
    this.persistMessages("user-message");
    this.managed.statusController.reconcileWithPolicy(this.channel.getMessages(), "during-run");
    void this.enqueueRunOnce();
    return true;
  }

  async sendMessage(content: string | ContentPart[]): Promise<SendMessageOutcome> {
    // User-authored text must not forge compaction checkpoint markers (see
    // assertNotCompactionSummaryInput in agent/compaction).
    assertNotCompactionSummaryInput(content);
    // A resume/new is unload → load. Input offered inside that window belongs to neither session:
    // writing it would target the one being left, and replaying it into the target would attach a
    // message to a transcript the user has not seen yet. Report the refusal — a host that only
    // sees `ok` would clear the user's input on a message nothing accepted.
    if (this.dropIfSwitching("send")) return "dropped";
    if (this.shouldDeferQueue()) {
      this.steer(content);
      return "queued";
    }
    // Only strips truncated/invalid leftover tools — never approval-responded / valid queues.
    this.applyCancelledIncompleteTools();
    this.channel.addUserMessage(content);
    this.persistMessages("user-message");
    await this.enqueueRunOnce();
    return "sent";
  }

  async respondToToolApproval(approvalId: string, approved: boolean, reason?: string): Promise<boolean> {
    // The pending question belongs to the turn being unloaded. Answering it now would settle a
    // tool row in the leaving transcript (and could start a pump after the target is adopted).
    if (this.dropIfSwitching("respond-approval")) return false;
    await this.approvalDecisions.respondToToolApproval(approvalId, approved, reason);
    return true;
  }

  /**
   * Start a turn for a background completion that landed while no run was in flight.
   *
   * The notification is a one-shot push from `background-middleware`, injected at the next model
   * call — which an idle session never makes, so the result would wait for the user to type. This
   * supplies the missing reason to start a turn; delivery still happens in the middleware.
   *
   * @returns whether a pump was enqueued.
   */
  wakeForBackgroundCompletion(): boolean {
    // A switch is replacing the transcript; the completion is delivered on the next turn.
    if (this.managed.isSessionSwitching()) return false;
    // A live pump delivers the notification at its next model call (the old behavior), and a
    // session parked on the user — approval / `ask_user` — must not be resumed behind their back.
    if (this.shouldDeferQueue()) return false;
    // Explicit allowlist, not "anything that is not parked". A run the user ABORTED or that ended in
    // ERROR is deliberately left alone: they just stopped it (or it failed), and a background job
    // finishing is not a reason to start talking again. `compacting` is excluded by the same set.
    if (!WAKEABLE_STATUSES.has(this.managed.getStatus())) return false;
    // `ready` is review — the user is reading the plan. `planning` has no approved plan yet, so a
    // promptless turn there could author one. `executing` / `retro` stay wakeable: that plan was
    // approved, and the mode already auto-approves its tools.
    const planPhase = this.managed.planMode.getPhase();
    if (planPhase === "ready" || planPhase === "planning") return false;
    // A wake is a new turn with no prompt: `startsNewTurn` gives it a run id and turn boundaries
    // even though the channel's last message is an assistant message.
    void this.enqueueRunOnce({ startsNewTurn: true });
    return true;
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
    // Same policy as a single answer: the pending set belongs to the turn being unloaded.
    if (this.dropIfSwitching("approve-pending")) return Promise.resolve();
    return this.approvalDecisions.approvePendingApprovals();
  }

  async addToolResult(toolCallId: string, output: Record<string, unknown>): Promise<boolean> {
    // A client-tool answer (`ask_user`) belongs to the question the leaving turn asked.
    if (this.dropIfSwitching("add-tool-result")) return false;
    // This command is reachable from the session control plane (`POST /api/agent/:id/command`), so
    // it must prove the answer belongs here before writing: a client tool, still unanswered. Without
    // the check any connected client could overwrite an executed `write_file`/`run_command` result
    // (channel + disk + model wire) or fabricate one for a tool that is still awaiting approval —
    // `hasDeferredToolExecution` treats `output !== undefined` as settled, so the pump would skip
    // the real execution.
    const part = findToolCallPart(this.channel.getMessages(), toolCallId);
    if (!part || !CLIENT_TOOL_NAMES.has(part.name) || part.output !== undefined) {
      this.managed.emitEvent("session:diagnostic", {
        area: "tool",
        level: "warn",
        message: part
          ? part.output !== undefined
            ? `Ignored a tool result for "${part.name}" (${toolCallId}): the call is already answered.`
            : `Ignored a tool result for "${part.name}" (${toolCallId}): only client tools accept host results.`
          : `Ignored a tool result for unknown tool call ${toolCallId}.`,
        details: { toolCallId, ...(part?.name ? { toolName: part.name } : {}) },
      });
      return false;
    }
    this.channel.addToolResult(toolCallId, output);
    // A client tool has no server-side `agent:tool-end`; this is the only place the answer exists.
    this.managed.emitEvent("agent:client-tool-result", {
      tool_call_id: toolCallId,
      tool_name: part.name,
      output,
    });
    // The client tool's result IS the end of the wait — but only when it was the LAST pending one
    // (a host could settle a different tool while an `ask_user` is still open). Clearing it here
    // rather than in each host is what lets the resumed pump leave `awaiting_user`; see
    // `prepareRunPhase`.
    if (!hasPendingAskUser(this.channel.getMessages())) this.managed.setClientToolWaiting(false);
    await this.enqueueRunOnce();
    return true;
  }

  /**
   * Drop an interaction that arrived during a session switch (unload → load).
   *
   * `pendingSwitches` covers the whole transaction, including a second switch queued behind the
   * first. Input offered there belongs to neither session: the leaving transcript is being
   * replaced, and the target has not been shown to the user. Returns `true` when the caller must
   * stop. Logged once per operation so a silently missing message is diagnosable.
   */
  private dropIfSwitching(operation: string): boolean {
    if (!this.managed.isSessionSwitching()) return false;
    this.managed.emitDiagnostic("session", "Dropped interaction during session switch", {
      level: "debug",
      data: { operation },
    });
    return true;
  }

  private shouldDeferQueue(): boolean {
    const status = this.managed.getStatus();
    // A manual `/compact` owns the agent with NO pump, and it must be honoured before the
    // stale-token shortcut below: `interruptCurrentRun` invalidates the token and zeroes
    // `pumpDepth` while the aborted pump is still unwinding, so a token check first would let a
    // message typed in that window open a turn BESIDE the summarizer — exactly the race
    // `shouldDeferMidRunQueue`'s `compacting` clause exists to prevent. Deferring here is released
    // by `resumeAfterCompaction` like any other message queued during compaction.
    if (status === "compacting") return true;
    // A stale (interrupted/superseded) pump still unwinding must not swallow new
    // input into the queues — new submissions execute immediately.
    if (this.currentToken && !this.currentToken.isCurrent) return false;
    // `runPending` closes the same-tick window `pumpDepth` misses: a pump is queued
    // but has not started, so `pumpDepth` is still 0 while the status is already
    // waiting. Deferring here queues the message for that pump instead of enqueueing
    // a second one that would find nothing to do.
    return this.runPending() || shouldDeferMidRunQueue({ pumpDepth: this.pumpDepth, status });
  }

  private notifyQueueListeners(): void {
    const snapshot = this.getQueuedMessages();
    // Single notification path: the session `queues` projection on the unified
    // bus (the domain Emitter was removed — see unified-agent-event-bus).
    this.eventBus?.emit("session:queues", snapshot);
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
    return this.pendingRunEpoch === this.lifecycleEpoch;
  }

  /**
   * Enqueue a pump unless one is already queued. The queued pump re-reads the
   * channel, so a change made after it was scheduled (an approval response, a tool
   * result) is handled by that run rather than needing a second one.
   */
  private enqueueRunOnce(options: { startsNewTurn?: boolean } = {}): Promise<void> {
    if (this.runPending()) return this.runChain;
    const epoch = this.lifecycleEpoch;
    const startsNewTurn = options.startsNewTurn === true;
    this.pendingRunEpoch = epoch;
    const run = () => {
      // Only the slot owner may clear it. A callback from an older epoch can run
      // after a clear + new enqueue; decrementing a shared counter here made that
      // stale callback consume the NEW pump's slot and let a third pump start.
      if (this.pendingRunEpoch === epoch) this.pendingRunEpoch = null;
      if (epoch !== this.lifecycleEpoch) return;
      return this.pumpToolPhases({ startsNewTurn });
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
    this.emitQueuedPromptRows(items);
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
    this.emitQueuedPromptRows(items);
    return true;
  }

  /**
   * Record each released queued message as a prompt.
   *
   * The drain appends to the transcript directly (no `send`), so the run lifecycle's
   * `prompt:submit` — which fires once per turn — never saw it. One row per message, because a
   * steer batch can carry several.
   */
  private emitQueuedPromptRows(items: QueuedMessageContent[]): void {
    for (const content of items) {
      const text = queuedContentText(content);
      if (!text) continue;
      this.managed.emitEvent("prompt:submit", {
        prompt: text,
        contextMessageCount: this.channel.getMessages().length,
        source: "queued",
      });
    }
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

  private async pumpToolPhases(options: { startsNewTurn?: boolean } = {}): Promise<void> {
    // Admission. A pump queued while another one was live can arrive AFTER that pump finished the
    // turn — an approval answered during `applyCommandSafetyPolicy` (an awaited CoreEnv call), or
    // an auto-mode batch landing late. Starting it anyway flips `completed` back to `running` and
    // spends a whole model call re-asking a transcript that already has its answer.
    //
    // Skip only a SETTLED transcript: one that ends in the model's reply. Everything that
    // legitimately continues passes — a new user message (the transcript ends with it), a settled
    // tool turn with no reply or a deferred/answered tool (`shouldKeepPumping`), any queued input
    // (`hasQueuedMessages`), and a wake (no prompt, so it passes by flag).
    const transcript = this.channel.getMessages();
    const settled = transcript.at(-1)?.role === "assistant";
    if (!options.startsNewTurn && settled && !this.shouldKeepPumping(transcript)) return;
    const epoch = this.lifecycleEpoch;
    const token = this.managed.run.beginRun();
    this.currentToken = token;
    const turnStart = Date.now();

    // Defaults, because the baselines below now live inside the guard: if one throws before it
    // assigns, the catch still finalizes with a zero baseline instead of skipping the turn.
    let usageAtStart: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    } = { inputTokens: 0, outputTokens: 0 };
    let costAtStart = 0;
    let toolCallsAtStart = 0;
    let hasError = false;
    let toolPhases = 0;
    let finalized = false;

    // Everything that can throw belongs INSIDE the guard — including the depth bookkeeping and the
    // `turn:summary` baselines, not just the phases. A throw from the setup below used to skip the
    // `finally` entirely — `pumpDepth` stuck above 0, the token still valid, every later message
    // queued with nothing to drain it — and surfaced as an unhandled rejection from
    // `enqueueRunOnce` (which callers fire with `void`). The catch then finalizes as `error`.
    try {
      this.pumpDepth += 1;
      // Baselines for `turn:summary`: the summary reports THIS pump's work, not the session totals.
      usageAtStart = this.managed.usage.snapshotTotal();
      costAtStart = this.managed.usage.getTotalCostUsd();
      toolCallsAtStart = countToolCalls(this.channel.getMessages());

      this.managed.resetTurnLifecycle();
      this.managed.clearPrepareAsContinuation();
      // A stale wake mark must not survive a pump that ends before its first model call.
      this.managed.clearPrepareAsNewTurn();
      this.managed.setError("");
      // Safe: skips approval-responded and valid input-complete (needed for `y` / tool-phase).
      this.applyCancelledIncompleteTools();
      this.managed.statusController.prepareRunPhase(this.channel.getMessages());

      for (let toolPhase = 0; toolPhase < MAX_TOOL_PHASES; toolPhase++) {
        if (hasError) break;
        if (!token.isCurrent || epoch !== this.lifecycleEpoch) return;

        let currentMessages = this.channel.getMessages();
        if (hasPendingInteraction(currentMessages)) break;

        if (toolPhase > 0) {
          const prepared = this.prepareContinuationPhase(currentMessages);
          if (!prepared.continue) break;
          currentMessages = prepared.messages;
        } else if (options.startsNewTurn) {
          // Set at the last moment: a pump that stops on a pending interaction never reaches its
          // first model call, and the mark must not leak into the resume pump.
          this.managed.markNextPrepareAsNewTurn();
        }

        await this.executeStream(currentMessages, token);
        toolPhases = toolPhase + 1;
        if (epoch !== this.lifecycleEpoch) return;
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
        if (hasPendingInteraction(after)) break;
        if (!this.shouldKeepPumping(after)) break;
      }

      if (token.isCurrent) {
        this.syncPlanModeFromMessages();
        let messages = this.channel.getMessages();
        let waitingForUser = hasPendingInteraction(messages);
        const keepPumping = !waitingForUser && this.shouldKeepPumping(messages);
        // Prefer status already set by executeStream (error/abort) over message-derived waits.
        const outcomeKind = this.managed.runFinalizer.deriveChatOutcome({ hasError, waitingForUser });

        // A terminal turn has no unanswered questions. `deriveChatOutcome` ranks error above
        // waiting, so a stream that asked for approval and THEN failed used to end as `error`
        // with the approval still pending: the next user turn was admitted, saw a pending
        // approval, and returned from prepareRunPhase without ever calling the model — the
        // session looked dead until the stale prompt was answered or Esc was pressed.
        if (outcomeKind === "error" || outcomeKind === "aborted") {
          this.approvalDecisions.denyPendingApprovals(TOOL_CANCELLED_MESSAGE);
          messages = this.channel.getMessages();
          waitingForUser = hasPendingInteraction(messages);
        }

        // Phase cap or early stream end while tools/model still need work — chain
        // another pump without finalizing the turn (avoids stale "running" + trapped queues).
        if (keepPumping && outcomeKind === "finished") {
          this.managed.statusController.reconcileWithPolicy(messages, "during-run");
          this.persistMessages("pump-complete");
          void this.enqueueRunOnce();
          return;
        }

        this.managed.runFinalizer.finalizeChat({
          kind: outcomeKind,
          messages,
          waitingForUser,
          phases: toolPhases,
          turnStartedAt: turnStart,
          usageBefore: usageAtStart,
          costBefore: costAtStart,
          toolCallsBefore: toolCallsAtStart,
          persist: () => this.persistMessages("pump-complete"),
        });
        finalized = true;
      }
    } catch (error) {
      // The loop's steps are not all pure bookkeeping: `applyCommandSafetyPolicy` awaits the
      // command analyzer over CoreEnv (a live HTTP call on a remote workspace), and
      // `syncPlanModeFromMessages` touches the plan controller. Letting a throw escape left
      // the turn unfinalized — status stuck at `running`, tool rows half-open, and an
      // unhandled rejection that the host's process guard turns into `exit(1)`. Finalize as
      // an error instead; a broken auxiliary step must not take the process with it.
      const normalized = toError(error);
      const message = normalized.message;
      if (!finalized && token.isCurrent) {
        try {
          this.managed.setError(message);
          // One row: `onRunError` already emits `agent:stream-error`. The separate emit above it
          // produced two identical "Stream error: …" entries for one failure.
          this.managed.statusController.onRunError(message, normalized.stack);
          // Same terminal rule as the normal path: an error is not a wait.
          this.approvalDecisions.denyPendingApprovals(TOOL_CANCELLED_MESSAGE);
          this.managed.runFinalizer.finalizeChat({
            kind: "error",
            messages: this.channel.getMessages(),
            waitingForUser: false,
            phases: toolPhases,
            turnStartedAt: turnStart,
            usageBefore: usageAtStart,
            costBefore: costAtStart,
            toolCallsBefore: toolCallsAtStart,
            persist: () => this.persistMessages("pump-complete"),
          });
        } catch {
          // Teardown is already failing; one more failure must not escape the pump.
        }
      }
    } finally {
      // A non-current (interrupted/superseded) pump must not decrement: the
      // interrupt owner already reset depth to 0, and the decrement would
      // otherwise steal depth from a newer pump. No Math.max guard needed.
      if (token.isCurrent) {
        this.pumpDepth -= 1;
        // The turn is over: no run is current any more. Without this the token stayed valid
        // after a normal completion, so `forceSubmit`'s `isCurrentRunValid()` fallback treated
        // an idle agent as running and aborted the settled turn's controller (cancelling the
        // finalize-time memory extraction it was still using).
        this.managed.run.invalidateCurrentRun();
        // A background job that finished between this pump's last `onConfig` and here had no model
        // call left to ride along with, and the registry's notification was refused ("a live pump
        // delivers it"). Re-check now that the pump is gone; the wake is refused again if the turn
        // ended parked on the user (`waiting` / `awaiting_user`), where delivery belongs to the
        // resume pump. No service yet ⇒ nothing running ⇒ the check is a no-op.
        void this.managed.wakeForBackgroundJobs();
      }
      // Forget the token this pump began. `shouldDeferQueue` reads a stale token as "a pump is
      // still unwinding" and short-circuits before the queued-pump / `compacting` / `waiting`
      // checks — correct only until this pump exits. Leaving the field set made that shortcut
      // permanent after the first turn, so a message typed during a later manual `/compact`
      // opened a turn beside the summarizer. Identity-checked: a newer pump may already own it.
      if (this.currentToken === token) this.currentToken = null;
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
        // Abort-shaped does NOT mean the user aborted: `isAbortedNow` already ruled out our
        // signal/status, so this turn failed and must finalize as `error` (no memory extraction).
        this.managed.statusController.onExternalError(message);
        this.applyCancelledIncompleteTools(true);
      },
      onEmpty: (message) => {
        if (!token.isCurrent || this.managed.getStatus() === "error") return;
        this.managed.statusController.onRunError(message);
      },
      onError: (message) => {
        if (!token.isCurrent || this.managed.getStatus() === "aborted") return;
        // Surface stream failures in status + `agent:stream-error` (not silent Completed). The event
        // is the single record: its log rule writes the error row, so logging here duplicated it.
        this.managed.statusController.onRunError(message);
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
    const cancelled = settleToolCalls(current, {
      reason: TOOL_CANCELLED_MESSAGE,
      includeInFlight,
    });
    const cleaned = stripEmptyAssistantShells(cancelled);
    this.channel.setMessages(cleaned);
  }

  private persistMessages(reason: "user-message" | "pump-complete"): void {
    const messages = this.channel.getMessages();
    if (messages.length > 0) {
      this.managed.maybeSaveSessionUIMessages(messages, reason);
    }
  }

  /** Extract ## Plan / [DONE:n] from the latest assistant text while plan mode is active. */
  private syncPlanModeFromMessages(): void {
    if (this.managed.planMode.getPhase() === "off") return;
    const text = extractAssistantText(this.channel.getMessages());
    if (text) this.managed.planMode.onAssistantText(text);
  }
}
