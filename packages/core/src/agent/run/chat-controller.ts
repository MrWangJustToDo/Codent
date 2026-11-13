/* eslint-disable max-lines -- Chat run orchestration. One loop owns admission, the mid-run queue
   (steer / follow-up / force-submit), the switch refusal contract, approval answering and
   stream-outcome finalization; those are separate protocols but their ORDER is the invariant, so
   moving one out would separate a decision from the loop that enforces it. The refusal gate and
   the queue drain helpers are the next extracted unit; the `SendMessageOutcome` contract added here
   is what pushed the file over the ceiling. */
import { isParkedStatus, isTerminalStatus } from "../../runtime-types/agent-status.js";
import { toError } from "../../utils/errors.js";
import { ApprovalDecisionCoordinator } from "../approval/approval-decision-coordinator.js";
import { assertNotCompactionSummaryInput } from "../compaction";
import { shouldDeferMidRunQueue } from "../queue/defer-mid-run-queue.js";
import { PendingMessageQueue, type QueueMode } from "../queue/pending-message-queue.js";
import { deriveCancelVerdict } from "../state/agent-run-outcome.js";
import { stripEmptyAssistantShells } from "../stream/empty-assistant-shell.js";
import { extractAssistantText } from "../stream/extract-assistant-text.js";
import {
  TOOL_CANCELLED_MESSAGE,
  settleToolCalls,
  hasCancellableIncompleteToolCalls,
  hasInFlightToolCalls,
  hasValidToolArguments,
} from "../stream/incomplete-tool-calls.js";
import { isSettledToolCallPart, isToolCallPart } from "../stream/message-parts.js";
import { findToolCallPart } from "../stream/suppress-replayed-tool-chunks.js";
import {
  countPendingToolApprovals,
  hasPendingAskUser,
  hasPendingInteraction,
  needsAgentResponseAfterTools,
  needsToolPhaseContinue,
  shouldContinueAgentPump,
} from "../stream/tool-phase-utils.js";
import { peekTaskPreforkCoordinator } from "../subagent/subagent-runs.js";
import { reconcileSettledTaskParts } from "../subagent/task-background.js";
import { CLIENT_TOOL_NAMES } from "../tools/catalog/tool-names.js";
import { AgentUIChannel } from "../ui/ui-channel.js";

import { runManagedSpan } from "./run-span.js";
import { countToolCalls } from "./tool-call-count.js";

import type { AgentEventBus } from "../agent-event-bus";
import type { RunToken } from "./run-coordinator.js";
import type { ToolCallRef } from "../../runtime-types/agent-event-payloads.js";
import type { AgentStatus } from "../../runtime-types/agent-status.js";
import type { AgentChatHost } from "../../runtime-types/chat-host.js";
import type { AgentManager } from "../../runtime-types/hosts.js";
import type { QueuedMessageContent, QueuedMessagesSnapshot } from "../../runtime-types/session-payloads.js";
import type { BackgroundWakeCause } from "../jobs/background-work.js";
import type { ContentPart, UIMessage } from "@tanstack/ai";

const MAX_TOOL_PHASES = 40;

/** Boundary that ran a settle pass (mirrors the `tool:settle` payload). */
type ToolSettleCause = "pump-start" | "pre-send" | "turn-end" | "abort" | "stream-error" | "engine";

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
   * Baselines for the live pump's `turn:summary`, retained outside `pumpToolPhases`.
   *
   * The Esc path finalizes in `interruptCurrentRun` (the pump's own outcome path is skipped once
   * its token is invalidated), so without this the most common turn ending — a user abort — was
   * the only one with no `turn:summary` at all. Null when no pump is live.
   */
  private pumpBaselines: {
    startedAt: number;
    usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
    cost: number;
    toolCalls: number;
    phases: number;
  } | null = null;
  /** Signature of the last `tool:phase` decision set, so a text-only follow-up phase adds no row. */
  private lastToolPhaseSignature: string | null = null;
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
    // Same-bus rebind is a no-op: `initChat` wires the channel once through `setUIChannel` and again
    // through the controller, and each call would otherwise replace the retained provider.
    if (this.eventBus === bus) return;
    this.eventBus = bus;
    this.channel.setEventBus(bus);
    bus.retain("session:queues", () => this.getQueuedMessages());
  }

  constructor(
    private readonly managed: AgentChatHost,
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
      // The table is the decision store; the channel part is its projection.
      projectApproval: (input) =>
        this.channel.addToolApprovalResponse(
          input.approvalId,
          input.approved,
          input.reason,
          input.decidedAt,
          input.overwrite ? { overwrite: input.overwrite } : undefined
        ),
      getPolicyFacts: () => this.managed.getPolicyFacts(),
      getApprovalRequirement: (toolName) => this.managed.getApprovalRequirement(toolName),
      runToolBeforeHook: (toolCallId, toolName, args) => this.managed.runToolBeforeHook(toolCallId, toolName, args),
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
    // "Clearing the transcript must invalidate the projection" belongs in the same place as the
    // clear, not only in the store's revision counter: a fingerprint that does not move would
    // serve the previous conversation's wire to the next model call.
    this.managed.invalidateWireProjection?.();
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
    // Foreground only: a background task must survive Esc, so its detached seat is not a reason to
    // interrupt anything.
    const registeredPrefork = peekTaskPreforkCoordinator(this.managed)?.foregroundSize ?? 0;
    // A wait whose interaction is gone is not a run to interrupt and not a reason to ignore Esc.
    // `setClientToolWaiting(true)` can outlive the part it asserted (stale host UI, a switch that
    // dropped the question); clearing it here is the only recovery short of `/new`. Only when no
    // pump/pre-fork is live: with a live run the stale wait is a symptom, and Esc must still abort.
    const messages = this.channel.getMessages();
    const pending = hasPendingInteraction(messages);
    if (!pending && !this.isPumpLive() && registeredPrefork === 0) {
      const status = this.managed.getStatus();
      if (isParkedStatus(status)) {
        // Esc also drops queued input, matching the normal abort path.
        this.clearQueuedMessages();
        this.managed.statusController.clearUnbackedWait();
        return;
      }
    }
    if (!this.isPumpLive() && registeredPrefork === 0 && !pending) return;
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
   * Resolve once the queued pump chain has finished.
   *
   * Teardown must not close persistence while a pump is still writing its final tool state; the
   * chain already serializes every pump, so awaiting it is the barrier (a parked approval has no
   * live pump and resolves).
   */
  settleRun(): Promise<void> {
    return this.runChain.then(
      () => undefined,
      () => undefined
    );
  }

  /**
   * Current pump/session-switch generation.
   *
   * Exposed as an `Epoch` source (see `runtime-types/epoch.ts`): the controller owns this counter,
   * and composing it with the session generation and run token is what makes one predicate replace
   * the per-call-site staleness checks.
   */
  getLifecycleEpoch(): number {
    return this.lifecycleEpoch;
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
    // Foreground only: a detached background seat is not part of this run, so it must not turn a
    // plain `/new` or `/resume` into a fabricated abort + finalize. The session-switch transaction
    // ends background work separately (`resetBackgroundWork` → `abortDetached`).
    const registeredPrefork = peekTaskPreforkCoordinator(this.managed)?.foregroundSize ?? 0;
    if (!this.isPumpLive() && registeredPrefork === 0) return;
    // A switch is a teardown, not a user cancel: it restores the compaction phase it replaced
    // instead of relying on `interrupt` (which may keep an existing terminal verdict).
    this.interruptCurrentRun(reason, { userCancel: false });
  }

  /**
   * Deny every pending approval and refresh the derived count.
   *
   * The turn that asked is gone (Esc, teardown, a stream failure), so the question must not outlive
   * it: a `pending` row keeps the prompt in `interactions.approvals`, and the next input parks on a
   * question nobody is asking any more. One method, because the transcript write and the retained
   * count have to agree — the count is a recomputation from the transcript, like every other writer.
   */
  denyPendingApprovals(reason: string): void {
    this.approvalDecisions.denyPendingApprovals(reason);
    this.managed.setPendingApprovalCount(countPendingToolApprovals(this.channel.getMessages()));
  }

  /**
   * Abort the in-flight pump, cancel incomplete tools, and finalize the aborted turn.
   * Invalidates the run token so the old pump exits without double-finalizing.
   */
  private interruptCurrentRun(reason: string, options: { keepQueue?: boolean; userCancel?: boolean } = {}): void {
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
    this.managed.abort(reason, { userCancel: options.userCancel ?? true });
    this.managed.statusController.onUserCancel();
    // Single owner of token invalidation + depth reset. The stale pump's finally
    // skips decrement when its token is not current (it holds a captured token),
    // so a subsequent sendMessage/forceSubmit is neither deferred by the stale
    // pump's queue logic nor desynchronized by its unwinding decrement.
    this.managed.run.invalidateCurrentRun();
    this.pumpDepth = 0;
    // Immediately clear loading tool rows; stream teardown may still finalize later. A pending
    // `ask_user` is preserved: it is a question addressed to the user, not work this abort owns,
    // and cancelling it here would make the park below a no-op (and discard the question).
    this.applyCancelledIncompleteTools(true, { cause: "abort" });
    // An approval prompt is a question the interrupted turn no longer has. Leaving it pending
    // kept the part in `interactions.approvals` while the run was over: the next input was
    // admitted against a status that said `aborted`, then parked on the old question forever.
    // Deny here (channel write + table + derived count) so the turn ends with no unanswered
    // interaction.
    this.denyPendingApprovals(TOOL_CANCELLED_MESSAGE);
    // Turn finalize here: the invalidated token makes the in-flight pump skip its outcome path.
    // When this run actually had a pump, go through the SAME finalizer the pump uses — the abort
    // is then a first-class turn outcome (status + `finalizeRun` + one `turn:summary`), not a
    // separate hand-rolled sequence. A parked turn has no baselines (its pump ended as `waiting`),
    // so it keeps the status-only finalize.
    //
    // A run that ALREADY failed (the pump is between phases, e.g. awaiting the command-safety
    // check) keeps `error`: `onUserCancel` was a no-op there, and reporting `aborted` would hide
    // the stream failure and contradict `agent:stream-error`. `deriveCancelVerdict` reads the AXIS:
    // a failed run parked on `ask_user` PROJECTS as `awaiting_user`, so the old
    // `getStatus() === "error"` test called it a cancel.
    const kind = deriveCancelVerdict(this.managed.getAgentState());
    const baselines = this.pumpBaselines;
    if (baselines) {
      this.pumpBaselines = null;
      this.managed.runFinalizer.finalizeChat({
        kind,
        messages: this.channel.getMessages(),
        waitingForUser: false,
        phases: baselines.phases,
        turnStartedAt: baselines.startedAt,
        usageBefore: baselines.usage,
        costBefore: baselines.cost,
        toolCallsBefore: baselines.toolCalls,
        // `finalizeChat` owns the persist (one snapshot, not two).
        persist: () => this.persistMessages("pump-complete"),
      });
    } else {
      // No pump: persist the cancelled tools before the status-only finalize.
      this.persistMessages("pump-complete");
      this.managed.finalizeRun(kind);
    }
    // A pending `ask_user` is re-asserted by `finalizeManagedAgentRun` after the status finalize.
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
   * Restore a queue snapshot taken before a failed session switch.
   *
   * The unload half clears the queue; a load that never commits leaves the user on the same
   * conversation, so dropping its queued input would lose work for a switch that did not happen.
   * Restored items go before anything admitted during the recovery.
   */
  restoreQueuedMessages(snapshot: QueuedMessagesSnapshot): void {
    if (snapshot.steer.length === 0 && snapshot.followUp.length === 0) return;
    this.steeringQueue.restore(snapshot.steer);
    this.followUpQueue.restore(snapshot.followUp);
    this.notifyQueueListeners();
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
    // A late finally can also land after the whole switch transaction settled: `dropIfSwitching`
    // is false again, the compaction lease is gone, and the only remaining evidence is that the
    // target already has a pump or is parked on an interaction. Draining then injects the new
    // conversation's queued input ahead of a gated tool result and starts a second pump.
    if (this.isPumpLive() || hasPendingInteraction(this.channel.getMessages())) return;
    if (!this.hasQueuedMessages()) return;
    const drained = this.drainSteerIntoChannel() || this.drainFollowUpIntoChannel();
    if (drained) {
      // The drain already recorded the queued `prompt:submit` row; the pump it starts must not
      // record the same message a second time as a "user" prompt.
      this.managed.markNextPreparePromptRowsEmitted();
      void this.enqueueRunOnce();
    }
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
    // Same integrity rule as follow-up / force-submit: a forged checkpoint marker would make the
    // next compaction treat a user message as the summary of the window.
    assertNotCompactionSummaryInput(content);
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

  /**
   * @param options.awaitTurn - When `false`, resolve as soon as the pump is ENQUEUED. Protocol
   *   dispatch uses this: a command's receipt means "accepted", not "the run ended". Defaults to
   *   `true`, which the internal pump-driving callers and the validators rely on.
   */
  async sendMessage(
    content: string | ContentPart[],
    options: { awaitTurn?: boolean } = {}
  ): Promise<SendMessageOutcome> {
    // User-authored text must not forge compaction checkpoint markers (see
    // assertNotCompactionSummaryInput in agent/compaction).
    assertNotCompactionSummaryInput(content);
    if (this.managed.isDestroyed()) return "dropped";
    // A stale QUESTION with no transcript backing must not swallow the input into a queue nothing
    // will drain. Scoped to `question`: an approval wait is set from the engine batch and the part
    // may not be in the transcript yet, so clearing that here would race the approval request.
    this.managed.statusController.clearUnbackedWait("question");
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
    // Settle them BEFORE releasing queued user text, or the message lands ahead of the tool result
    // it was written after.
    this.applyCancelledIncompleteTools(false, { cause: "pre-send" });
    // A turn can end with input still queued: a stream error skips the continuation drain, and the
    // next `send` used to append its own message first. Deliver the older queue before this new
    // message so the model sees the user's messages in the order they were written (and so nothing
    // stays stranded behind a turn that already ended).
    while (this.hasQueuedMessages()) {
      if (!this.drainSteerIntoChannel() && !this.drainFollowUpIntoChannel()) break;
    }
    this.channel.addUserMessage(content);
    this.persistMessages("user-message");
    if (options.awaitTurn === false) this.startRun();
    else await this.enqueueRunOnce();
    return "sent";
  }

  async respondToToolApproval(
    approvalId: string,
    approved: boolean,
    reason?: string
  ): Promise<"recorded" | "not-pending" | "switching"> {
    // The pending question belongs to the turn being unloaded. Answering it now would settle a
    // tool row in the leaving transcript (and could start a pump after the target is adopted).
    if (this.dropIfSwitching("respond-approval")) return "switching";
    return (await this.approvalDecisions.respondToToolApproval(approvalId, approved, reason))
      ? "recorded"
      : "not-pending";
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
  wakeForBackgroundCompletion(cause: BackgroundWakeCause = "job"): boolean {
    // A destroyed agent has no session to wake: `destroyAgent` marks it before the (slow)
    // extension teardown, and a background unit finishing inside that window used to start a real
    // paid turn on a dead transcript.
    if (this.managed.isDestroyed()) return false;
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
    const planPhase = this.managed.getModeState().snapshot().planPhase;
    if (planPhase === "ready" || planPhase === "planning") return false;
    // A wake is a new turn with no prompt: `startsNewTurn` gives it a run id and turn boundaries
    // even though the channel's last message is an assistant message. The cause is recorded here,
    // where the turn is actually decided, so a refused wake cannot mislabel the next one.
    this.managed.setPendingWakeCause(cause);
    void this.enqueueRunOnce({ startsNewTurn: true });
    return true;
  }

  /**
   * Authorize every pending tool approval (auto / plan execution / command policy), then resume.
   *
   * A pending approval is a QUESTION, and turning on auto mode (or entering plan execution, which
   * auto-approves) has usually answered it. Leaving it pending is not neutral: the pump is parked on
   * it, so the session looks like it is running auto mode while nothing runs. The TUI used to answer
   * these from its `/mode` command — a host-side workaround that the protocol hosts (ACP, remote
   * sessions) never had, which is why switching to auto mid-approval did nothing there.
   *
   * The decision still goes through `authorizeToolCall`: a hard-policy ask is NOT auto-approved,
   * so it stays pending (fail closed) and the enqueue only happens when something was recorded.
   * One channel write per decision with the approval table kept in step, then ONE pump enqueue:
   * `enqueueRunOnce` joins, so N decisions do not schedule N pumps.
   */
  async authorizeAndResume(): Promise<void> {
    // Same policy as a single answer: the pending set belongs to the turn being unloaded.
    if (this.dropIfSwitching("authorize-approvals")) return;
    await this.approvalDecisions.authorizeAndResume();
  }

  async addToolResult(
    toolCallId: string,
    output: Record<string, unknown>,
    options: { awaitTurn?: boolean } = {}
  ): Promise<"accepted" | "switching" | "rejected"> {
    // A client-tool answer (`ask_user`) belongs to the question the leaving turn asked.
    if (this.dropIfSwitching("add-tool-result")) return "switching";
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
      return "rejected";
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
    // The answer is durable state, not just a channel write: without this the process could die
    // between the answer and the resumed pump's persist, leaving an unanswered `ask_user` on disk
    // while the host already reported the answer sent.
    this.persistMessages("user-message");
    if (options.awaitTurn === false) this.startRun();
    else await this.enqueueRunOnce();
    return "accepted";
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
    if (this.managed.isDestroyed()) return Promise.resolve();
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
    // A rejection here must never escape as an unhandled rejection: the host process guard turns
    // one into `exit(1)`, so an admission fault (a legacy message the transcript scan cannot read)
    // would take the whole CLI/ACP process down instead of failing one turn. `void enqueueRunOnce()`
    // callers are the common case, and `void` does not mean "no handler".
    //
    // Reported as a real failed turn, not a diagnostic row: `session:diagnostic` has no session
    // channel, so ACP/remote hosts would see a user message hang unanswered with no signal at all.
    // Epoch-checked so a rejection that lands after a session switch is not filed under the target.
    //
    // Never over a live interaction or an existing failure verdict: the pump's `finally` can reject
    // AFTER the turn parked on `ask_user`, and setting `error` there would contradict the pending
    // question — input is then admitted against `error` and the next pump breaks on the interaction.
    // A rejection after a COMPLETED turn is still reported (it is indistinguishable from an
    // admission failure for the next turn), but it cannot reopen a turn boundary.
    this.runChain = this.runChain.catch((error) => {
      if (this.lifecycleEpoch !== epoch || this.managed.isDestroyed()) return;
      if (hasPendingInteraction(this.channel.getMessages())) return;
      const status = this.managed.getStatus();
      if (isParkedStatus(status) || isTerminalStatus(status)) return;
      const normalized = toError(error);
      this.managed.setError(normalized.message);
      this.managed.statusController.onRunError(normalized.message, normalized.stack);
    });
    return this.runChain;
  }

  /**
   * Fire the queued pump without waiting for the turn to finish.
   *
   * A command's receipt means "accepted", not "the run ended". Awaiting the pump made `send` and
   * `addToolResult` hang for the whole agent loop — a `--remote-session` client behind the ~300s
   * HTTP header timeout then reported a failure for a message the agent was already answering, and
   * a host that retries on failure duplicated it. The pump owns its own failure path
   * (`agent:stream-error` + terminal finalize), so its rejection is not the command's to report;
   * the catch only prevents an unhandled rejection.
   */
  private startRun(): void {
    void this.enqueueRunOnce().catch(() => undefined);
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
    // Owned by the guard: admission is failable too, and it used to sit OUTSIDE the try — a throw
    // there reached only `enqueueRunOnce`'s catch, which sets an error and finalizes nothing. The
    // user message was already persisted, so the transcript kept half a run with no `agent:stop` and
    // no `turn:summary`. `null` means "no run began", which the catch still finalizes.
    let token: RunToken | null = null;

    // Everything that can throw belongs INSIDE the guard — including admission, the depth
    // bookkeeping and the `turn:summary` baselines, not just the phases. A throw from the setup below
    // used to skip the `finally` entirely — `pumpDepth` stuck above 0, the token still valid, every
    // later message queued with nothing to drain it — and surfaced as an unhandled rejection from
    // `enqueueRunOnce` (which callers fire with `void`). The catch then finalizes as `error`.
    try {
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
      // Local const for the body: keeps TS narrowing across the awaits, while the outer `token`
      // stays nullable for the catch/finally.
      const runToken = this.managed.run.beginRun();
      token = runToken;
      this.currentToken = runToken;
      this.pumpDepth += 1;
      // Baselines for `turn:summary`: the summary reports THIS pump's work, not the session totals.
      usageAtStart = this.managed.usage.snapshotTotal();
      costAtStart = this.managed.usage.getTotalCostUsd();
      toolCallsAtStart = countToolCalls(this.channel.getMessages());
      this.pumpBaselines = {
        startedAt: turnStart,
        usage: usageAtStart,
        cost: costAtStart,
        toolCalls: toolCallsAtStart,
        phases: 0,
      };

      this.managed.resetTurnLifecycle();
      this.managed.clearPrepareAsContinuation();
      // A stale wake mark must not survive a pump that ends before its first model call.
      this.managed.clearPrepareAsNewTurn();
      this.managed.setError("");
      // Safe: skips approval-responded and valid input-complete (needed for `y` / tool-phase).
      this.applyCancelledIncompleteTools(false, { cause: "pump-start" });
      this.managed.statusController.prepareRunPhase(this.channel.getMessages());

      for (let toolPhase = 0; toolPhase < MAX_TOOL_PHASES; toolPhase++) {
        if (hasError) break;
        if (!runToken.isCurrent || epoch !== this.lifecycleEpoch) return;

        // Repair a settled background task whose part the previous phase's batched tool result
        // overwrote. This is the one boundary that is always after that write and always before the
        // next wire projection, so the model never sees the `running` handle for a finished run.
        reconcileSettledTaskParts(this.managed);

        let currentMessages = this.channel.getMessages();
        if (hasPendingInteraction(currentMessages)) break;

        if (toolPhase > 0) {
          const prepared = this.prepareContinuationPhase(currentMessages);
          if (!prepared.continue) break;
          currentMessages = prepared.messages;
        } else if (
          this.hasQueuedMessages() &&
          // Re-read, not the admission snapshot: the transcript may have settled differently while
          // the pending interaction above was resolved.
          currentMessages.at(-1)?.role === "assistant" &&
          // A settled TOOL turn is not a stopping point: its tools still have to run, and injecting
          // user text now would put it before the tool result. `prepareContinuationPhase` owns that
          // ordering from phase 1 on.
          !needsToolPhaseContinue(currentMessages)
        ) {
          // A chain pump admitted only because input was queued must deliver it BEFORE the first
          // model call. Previously phase 0 re-sent the settled transcript, the model answered a
          // question nobody asked, and only phase 1 drained the queue — one wasted call per chain.
          // Mirror `prepareContinuationPhase`'s policy (steer wins; follow-up only when no steer)
          // without marking a continuation: the turn now has a real prompt.
          const steered = this.drainSteerIntoChannel();
          if (!steered) this.drainFollowUpIntoChannel();
          this.managed.clearPrepareAsNewTurn();
          // The drain wrote one `prompt:submit` row per released message; `prepareForRun` must not
          // write a second "user" row for the same text (it would count one prompt twice).
          this.managed.markNextPreparePromptRowsEmitted();
          currentMessages = this.channel.getMessages();
        } else if (options.startsNewTurn) {
          // Set at the last moment: a pump that stops on a pending interaction never reaches its
          // first model call, and the mark must not leak into the resume pump.
          this.managed.markNextPrepareAsNewTurn();
        }

        await this.executeStream(currentMessages, runToken);
        toolPhases = toolPhase + 1;
        if (this.pumpBaselines) this.pumpBaselines.phases = toolPhases;
        if (epoch !== this.lifecycleEpoch) return;
        this.emitToolPhase(toolPhase + 1);
        if (this.managed.getStatus() === "error") {
          hasError = true;
        }
        if (!runToken.isCurrent) {
          // Stream may have finalized truncated tool args after Esc — cancel again, but keep a
          // pending `ask_user` answerable (same rule as `interruptCurrentRun`).
          this.applyCancelledIncompleteTools(true, { cause: "abort" });
          this.persistMessages("pump-complete");
          return;
        }

        this.syncPlanModeFromMessages();

        // One authorization pass: auto/plan auto-approval, declarative requirements and
        // command-safety analysis are stages of the same decision.
        await this.approvalDecisions.authorizePendingApprovals();

        const after = this.channel.getMessages();
        if (hasPendingInteraction(after)) break;
        if (!this.shouldKeepPumping(after)) break;
      }

      if (runToken.isCurrent) {
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

        // A settled turn cannot still be waiting on a tool the engine never ran. TanStack parks a
        // whole batch on its approval-gated call and holds every plain call beside it; when the
        // approval is answered (or the run ends before it) a held call can be left `input-complete`
        // with no result — no error, no output, so its row spins forever and the wire carries an
        // unanswered call. `waitingForUser === false` proves no later phase can produce that
        // result, so settle it: the model sees a cancelled result and can retry, and the UI stops
        // loading. A parked turn keeps its calls (the resume still owes them).
        //
        // This is not only a `finished` rule: an `error`/`aborted` turn has no later phase either,
        // and leaving a valid `input-complete` call behind meant the NEXT user turn continued that
        // tool phase — executing the failed turn's arguments (possibly a write).
        if (outcomeKind !== "waiting" && !waitingForUser) {
          this.applyCancelledIncompleteTools(true, { cause: "turn-end" });
          messages = this.channel.getMessages();
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

        // A queued follow-up written during a FAILED run must not wait for the user to type again.
        // The error ended the pump, and nothing else drains the queue: `wakeForBackgroundCompletion`
        // deliberately leaves an errored run alone, and `interruptCurrentRun` (the abort path) clears
        // its queue instead. Deliver each message once; if the next run fails too the queue is already
        // empty, so this cannot loop.
        if (outcomeKind === "error" && !hasPendingInteraction(this.channel.getMessages())) {
          if (this.drainSteerIntoChannel() || this.drainFollowUpIntoChannel()) {
            // The drain wrote the queued `prompt:submit` row(s); the resumed pump must not write a
            // second "user" row for the same message. (The drain persists the user message itself.)
            this.managed.markNextPreparePromptRowsEmitted();
            void this.enqueueRunOnce();
          }
        }
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
      // `token === null` = admission threw before any run began. There is no turn to close: a
      // `finalizeChat` here would report the session-lifetime baselines (usage/cost/toolCalls are
      // still zero) as this turn's summary, and emit a turn boundary that never opened. Surface the
      // failure as a status/error row only; the user message is already persisted.
      if (!finalized && (token === null || token.isCurrent)) {
        try {
          this.managed.setError(message);
          // One row: `onRunError` already emits `agent:stream-error`. The separate emit above it
          // produced two identical "Stream error: …" entries for one failure.
          this.managed.statusController.onRunError(message, normalized.stack);
          if (token !== null) {
            // Same terminal rule as the normal path: an error is not a wait.
            this.approvalDecisions.denyPendingApprovals(TOOL_CANCELLED_MESSAGE);
            // …and it owes no tool result either. Without this the catch path finalized with a held
            // `input-complete` call still on the wire, so the next turn executed it. A pending
            // `ask_user` is the exception, exactly as on the normal path: the failure did not answer
            // the user's question, and cancelling it would make the session unanswerable.
            const stillWaiting = hasPendingInteraction(this.channel.getMessages());
            if (!stillWaiting) this.applyCancelledIncompleteTools(true, { cause: "stream-error" });
            this.managed.runFinalizer.finalizeChat({
              kind: "error",
              messages: this.channel.getMessages(),
              waitingForUser: stillWaiting,
              phases: toolPhases,
              turnStartedAt: turnStart,
              usageBefore: usageAtStart,
              costBefore: costAtStart,
              toolCallsBefore: toolCallsAtStart,
              persist: () => this.persistMessages("pump-complete"),
            });
          }
        } catch {
          // Teardown is already failing; one more failure must not escape the pump.
        }
      }
    } finally {
      // A non-current (interrupted/superseded) pump must not decrement: the
      // interrupt owner already reset depth to 0, and the decrement would
      // otherwise steal depth from a newer pump. No Math.max guard needed.
      if (token !== null && token.isCurrent) {
        // Only the CURRENT pump may release the baselines: an interrupted pump already handed them
        // to `finalizeChat` (or cleared them), and a superseded one must not clear a newer pump's.
        this.pumpBaselines = null;
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
        // resume pump. No facade yet ⇒ nothing running ⇒ the check is a no-op.
        void this.managed.wakeForBackgroundWork();
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
    // A run can outlive the session it belongs to: a session switch `stop()`s the pump, but a tool
    // that ignores the abort signal (extension/MCP) resolves later, after the target transcript has
    // been adopted into this same channel. `token.isCurrent` alone cannot cover that window — the
    // abandoned stream's own `onAbort` fires before this method checks anything — so capture the
    // generation BEFORE the span and re-check it on every terminal write.
    //
    // Generation only, deliberately NOT `isSessionSwitching`: a switch is "admitted" before it
    // stops the run (`resumeInner` drains persists first), and in that window this run is still the
    // live one. Treating the admission as staleness swallowed a real stream error (no `error`
    // status, no `agent:stream-error`, turn persisted as `finished`). The generation moves at the
    // COMMIT, which is exactly when writing here would hit the target transcript.
    const epoch = this.managed.captureEpoch();
    const isStaleSession = (): boolean => !epoch.isCurrent();
    const applyAbortFallback = (): void => {
      if (isStaleSession()) return;
      // `applyCancelledIncompleteTools` preserves a pending `ask_user` by default — the single
      // rule. This fallback used to pass no option and consequently undid the park the Esc path had
      // just established (status `awaiting_user` with no pending interaction, so every later
      // message was deferred to a pump that never started and Esc became a no-op).
      this.applyCancelledIncompleteTools(true, { cause: "abort" });
    };
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
      // Stop writing the moment this run stops being the current one. Without it an abort that
      // landed while a tool was still resolving let the stream keep appending to the channel AFTER
      // `finalizeChat` persisted the turn — rows the session file never received.
      isStale: () => !token.isCurrent,
      onAbort: applyAbortFallback,
      onAbortError: (message) => {
        if (isStaleSession() || !token.isCurrent || this.managed.getStatus() === "aborted") return;
        // Abort-shaped does NOT mean the user aborted: `isAbortedNow` already ruled out our
        // signal/status, so this turn failed and must finalize as `error` (no memory extraction).
        this.managed.statusController.onExternalError(message);
        applyAbortFallback();
      },
      onEmpty: (message) => {
        if (isStaleSession() || !token.isCurrent || this.managed.getStatus() === "error") return;
        this.managed.statusController.onRunError(message);
      },
      onError: (message) => {
        // `error` is the middleware's own verdict: `status-middleware.onError` runs first inside the
        // engine and already called `onRunError` (status + `agent:stream-error`). Without this guard
        // the rethrow path emitted a second identical "Stream error" row for one failure — the same
        // dedupe `onEmpty` and `applyRunOutcome` already do.
        if (
          isStaleSession() ||
          !token.isCurrent ||
          this.managed.getStatus() === "aborted" ||
          this.managed.getStatus() === "error"
        ) {
          return;
        }
        // Surface stream failures in status + `agent:stream-error` (not silent Completed). The event
        // is the single record: its log rule writes the error row, so logging here duplicated it.
        this.managed.statusController.onRunError(message);
      },
    });

    // The switch committed while this stream was unwinding: the transcript on the channel now
    // belongs to the target session, so neither the cancel marker nor status work here applies.
    if (isStaleSession()) return;
    if (!token.isCurrent || this.managed.getStatus() === "aborted") {
      applyAbortFallback();
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
  private applyCancelledIncompleteTools(
    includeInFlight = false,
    // ONE rule, defaulting on: a pending `ask_user` is a question addressed to the user, not work
    // this cleanup owns. The option existed because the abort fallback and `interruptCurrentRun`
    // disagreed, and the fallback silently undid the park the Esc path had just established. A
    // caller that genuinely wants to withdraw the question must say so explicitly.
    options: { preservePendingAskUser?: boolean; cause?: ToolSettleCause } = {}
  ): void {
    const current = this.channel.getMessages();
    const hasCancellable =
      hasCancellableIncompleteToolCalls(current) || (includeInFlight && hasInFlightToolCalls(current));
    if (!hasCancellable) {
      // An abort before the first content/tool chunk can leave an empty assistant shell even though
      // there is nothing to settle. The caller persists right after this, so strip it here (only on
      // an actual change) instead of leaving a spinning row on disk. Later at pump-start there is no
      // materialized assistant message yet, so this cannot remove a live row.
      const cleaned = stripEmptyAssistantShells(current);
      if (cleaned.length !== current.length) this.channel.setMessages(cleaned);
      return;
    }
    // The settle itself reports which calls it changed: a second predicate copy here would decide
    // against the pre-mutation snapshot and drift from `settleToolCalls` (it already had — the
    // abort path settled truncated calls the collector filtered out). These calls never produce
    // `agent:tool-end`/`agent:tool-error`, so this is the only timeline row that can explain a row
    // that stopped loading as "cancelled" with no tool event.
    const settled: ToolCallRef[] = [];
    const cancelled = settleToolCalls(current, {
      reason: TOOL_CANCELLED_MESSAGE,
      includeInFlight,
      ...((options.preservePendingAskUser ?? true) ? { preservePendingAskUser: true } : {}),
      onSettled: (part) => settled.push(part.name ? { id: part.id, name: part.name } : { id: part.id }),
    });
    const cleaned = stripEmptyAssistantShells(cancelled);
    this.channel.setMessages(cleaned);
    if (settled.length > 0) {
      this.managed.emitEvent("tool:settle", {
        cause: options.cause ?? "engine",
        includeInFlight,
        calls: settled,
        count: settled.length,
      });
    }
  }

  /**
   * Record one model tool phase's decision set.
   *
   * The log used to prove a call did NOT run (no `agent:tool-start`) but never say why. `held` is
   * TanStack's parked-sibling set (the plain calls beside an approval gate), `needsApproval` the
   * gate itself, `needsClient` a host-executed tool. Emitted only for phases that actually carried
   * calls, so a text-only turn adds no row.
   */
  private emitToolPhase(phase: number): void {
    // The LAST tool-bearing assistant, not simply the last assistant: a `chat()` that executes
    // pending tools and then asks the model for the reply ends with a text-only assistant message,
    // so "last assistant" would describe the wrong (empty) phase. Walk backward without copying the
    // transcript (`[...].reverse()` is O(n) on every phase).
    const messages = this.channel.getMessages();
    let assistant: UIMessage | undefined;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!;
      if (message.role === "assistant" && message.parts.some(isToolCallPart)) {
        assistant = message;
        break;
      }
    }
    if (!assistant) return;
    const pending: ToolCallRef[] = [];
    const executed: ToolCallRef[] = [];
    const held: ToolCallRef[] = [];
    const approved: ToolCallRef[] = [];
    const needsApproval: ToolCallRef[] = [];
    const needsClient: ToolCallRef[] = [];
    for (const part of assistant.parts) {
      if (!isToolCallPart(part)) continue;
      const ref: ToolCallRef = part.name ? { id: part.id, name: part.name } : { id: part.id };
      if (part.output !== undefined || isSettledToolCallPart(part)) {
        executed.push(ref);
        continue;
      }
      pending.push(ref);
      if (part.approval?.needsApproval === true) {
        if (part.approval.approved === undefined) needsApproval.push(ref);
        else if (part.approval.approved === true) approved.push(ref);
        // A denied gate stays in `pending` only; the approval-resolved row carries the refusal.
        continue;
      }
      if (CLIENT_TOOL_NAMES.has(part.name) && part.state === "input-complete" && hasValidToolArguments(part)) {
        needsClient.push(ref);
        continue;
      }
      // A plain server call with complete args and no result is what the engine parks in its
      // `held` list while a sibling waits for approval. (A `task` here may already be running via
      // the eager pre-fork; it is still "no result yet", which is what this bucket names.)
      if (part.state === "input-complete" && hasValidToolArguments(part)) held.push(ref);
    }
    if (pending.length + executed.length === 0) return;
    // Assistant identity prefixes the signature: provider tool-call ids are request-scoped and
    // reused (`call_0`), so ids alone would suppress a LATER turn's identical-looking phase.
    const signature = [assistant.id, pending, executed, held, approved, needsApproval, needsClient]
      .map((value) => (typeof value === "string" ? value : value.map((ref) => ref.id).join(",")))
      .join("|");
    // A phase that executed pending tools and then produced the final text reports the SAME
    // assistant/call set; emitting again would print a duplicate row, not a second decision.
    if (signature === this.lastToolPhaseSignature) return;
    this.lastToolPhaseSignature = signature;
    this.managed.emitEvent("tool:phase", {
      phase,
      pending,
      pendingCount: pending.length,
      executed,
      executedCount: executed.length,
      held,
      heldCount: held.length,
      approved,
      approvedCount: approved.length,
      needsApproval,
      needsApprovalCount: needsApproval.length,
      needsClient,
      needsClientCount: needsClient.length,
    });
  }

  private persistMessages(reason: "user-message" | "pump-complete"): void {
    const messages = this.channel.getMessages();
    if (messages.length > 0) {
      this.managed.maybeSaveSessionUIMessages(messages, reason);
    }
  }

  /** Extract ## Plan / [DONE:n] from the latest assistant text while plan mode is active. */
  private syncPlanModeFromMessages(): void {
    if (this.managed.getModeState().snapshot().planPhase === "off") return;
    const text = extractAssistantText(this.channel.getMessages());
    if (text) this.managed.planMode.onAssistantText(text);
  }
}
