/**
 * Single source of truth for agent status transitions.
 *
 * Stream lifecycle, compaction, approvals, client-tool pauses, and post-run
 * reconciliation all flow through this controller. {@link createStatusMiddleware}
 * is the only runtime hook surface; app code calls the reconcile helpers on
 * {@link ManagedAgent}.
 */

import { deriveAgentState, projectAgentStatus, transition } from "../../runtime-types/agent-state.js";
import { isActiveStatus, isBusyStatus, isTerminalStatus } from "../../runtime-types/agent-status.js";
import {
  countPendingToolApprovals,
  firstPendingInteraction,
  needsAgentResponseAfterTools,
  needsToolPhaseContinue,
} from "../stream/tool-phase-utils.js";

import { whenClearForReconcilePolicy, type AgentRunOutcome, type StatusReconcilePolicy } from "./agent-run-outcome.js";

import type { EmitAgentTelemetryFn } from "../../runtime-types/agent-events.js";
import type { AgentState, AgentStateEventType, AgentTransitionEvent } from "../../runtime-types/agent-state.js";
import type { AgentStatus } from "../../runtime-types/agent-status.js";
import type { WhenClearStatus } from "../../runtime-types/session-payloads.js";
import type { StreamChunk, ToolPhaseCompleteInfo, UIMessage } from "@tanstack/ai";

export type { AgentRunOutcome, AgentRunOutcomeKind, AgentRunPath, StatusReconcilePolicy } from "./agent-run-outcome.js";

// ============================================================================
// Types
// ============================================================================

export interface AgentStatusControllerDeps {
  getStatus: () => AgentStatus;
  /** Axes behind `getStatus`; lets a wait transition preserve a failed/aborted outcome. */
  getAgentState?: () => AgentState;
  /** The one writer. Present in production; legacy fixtures may provide only `setStatus`. */
  transition?: (event: AgentTransitionEvent) => AgentStatus;
  setStatus?: (status: AgentStatus, event?: AgentStateEventType) => void;
  getError: () => string;
  setError: (error: string) => void;
  setPendingApprovalCount: (count: number) => void;
  /**
   * The live transcript.
   *
   * The pending-approval count is a DERIVED value (`countPendingToolApprovals`), and a writer that
   * computes it from anything else (a batch list, or a hardcoded 0) can disagree with the retained
   * `interactions` projection built from the same messages. Callers pass a reader so every
   * recompute uses the one scan.
   */
  getMessages?: () => UIMessage[];

  /** Record the run's model finish reason (null when a new run starts). */
  setFinishReason?: (reason: string | null) => void;
  /**
   * Whether the pending approvals will be answered without a human (auto mode / plan execution).
   *
   * The request event carries the answer: with it the log policy can drop the request/resolve pair
   * for approvals nobody was asked about, while the `agent:tool-*` rows still record the call.
   */
  shouldAutoApprove?: () => boolean;
  emitEvent?: EmitAgentTelemetryFn;
}

export interface ReconcileFromUIMessagesOptions {
  whenClear?: WhenClearStatus;
}

// ============================================================================
// Stream chunk → status
// ============================================================================

function applyChunkStatus(
  getStatus: () => AgentStatus,
  getState: (() => AgentState) | undefined,
  dispatch: (event: AgentTransitionEvent) => AgentStatus,
  chunk: StreamChunk
): void {
  const type = chunk.type;
  const current = getStatus();

  // Keep interactive pauses and user cancel sticky — leftover chunks must not resurrect "running".
  // `completed` too: the projection checks `run: "streaming"` BEFORE `outcome: "completed"`, so one
  // trailing chunk after `settle` flipped a finished turn back to thinking/running with no pump
  // left to settle it (Esc then did nothing). Error/aborted are protected by projection order.
  // A compaction lease owns the run phase: a late chunk must not promote `run` to streaming/tooling,
  // or the lease's restore guard (`status === "compacting"`) stops matching and the phase is
  // abandoned by `finish()` without ever being restored.
  if (
    current === "waiting" ||
    current === "awaiting_user" ||
    current === "aborted" ||
    current === "completed" ||
    current === "compacting"
  ) {
    return;
  }

  // Each branch names the status its chunk implies and moves only when the agent
  // is not already there. A run streams hundreds of reasoning/text chunks in a
  // row, so re-setting the status it already has is not a transition: `setStatus`
  // logs only real transitions but still re-emits the state/mode/interaction
  // projections on every call, and recomputes the interaction snapshot (two full
  // passes over the message list) with them.
  if (type === "TOOL_CALL_START") {
    // Enter the tooling phase even when the projection already reads `running` (prepare does):
    // otherwise the axes stay at `preparing` for a turn that starts with a tool call. Guard on
    // the axes, not the projection, so repeated tool chunks do not re-emit state.
    const axes = getState?.();
    if (axes ? axes.run !== "tooling" : current !== "running") {
      dispatch({ type: "stream-chunk", stream: "tooling" });
    }
    return;
  }

  if (type === "REASONING_MESSAGE_CONTENT" || type === "REASONING_MESSAGE_START") {
    if (current !== "thinking") dispatch({ type: "stream-chunk", stream: "thinking" });
    return;
  }

  if (type === "TEXT_MESSAGE_CONTENT") {
    if (current === "running" || current === "thinking") {
      dispatch({ type: "stream-chunk", stream: "responding" });
    }
  }
}

// ============================================================================
// AgentStatusController
// ============================================================================

export class AgentStatusController {
  private readonly deps: AgentStatusControllerDeps;

  constructor(deps: AgentStatusControllerDeps) {
    this.deps = deps;
  }

  /**
   * Apply one state event. Production passes the agent's single transition writer; a legacy
   * fixture without one gets the same projection applied through `setStatus`.
   */
  private dispatch(event: AgentTransitionEvent): AgentStatus {
    if (this.deps.transition) return this.deps.transition(event);
    if (!this.deps.setStatus) return this.deps.getStatus();
    const next = transition(deriveAgentState(this.deps.getStatus(), this.deps.getError?.() ?? ""), event, {
      strict: false,
    });
    const status = projectAgentStatus(next);
    this.deps.setStatus(status, event.type);
    return status;
  }

  /** Bridge the gap before TanStack `onStart` during {@link AgentChatController} pump. */
  prepareRunPhase(messages: UIMessage[]): void {
    // Parked on the user: whichever interaction was asked FIRST is still unanswered, so starting a
    // pump would only re-ask it. (The old count-only gate missed an unanswered `ask_user` that was
    // not first, and the `awaiting_user` special case only covered one spelling of the same state.)
    if (firstPendingInteraction(messages)) return;

    const status = this.deps.getStatus();
    if (
      status === "waiting" ||
      status === "awaiting_user" ||
      status === "idle" ||
      status === "completed" ||
      status === "error" ||
      status === "aborted"
    ) {
      this.dispatch({ type: "prepare" });
    }
  }

  onRunStart(): void {
    this.deps.setFinishReason?.(null);
    const status = this.deps.getStatus();
    if (status === "aborted" || status === "compacting") return;
    if (status !== "waiting" && status !== "awaiting_user") {
      this.dispatch({ type: "prepare" });
    }
    this.deps.setError("");
  }

  onStreamChunk(chunk: StreamChunk): StreamChunk {
    applyChunkStatus(this.deps.getStatus, this.deps.getAgentState, (event) => this.dispatch(event), chunk);
    return chunk;
  }

  onRunFinish(finishReason?: string | null): void {
    // Record it BEFORE the status flip: the status change is what emits the state payload that
    // carries it, and a host reading the final state must see the reason.
    this.deps.setFinishReason?.(finishReason ?? null);
    const current = this.deps.getStatus();
    // A parked/terminal turn, or a compaction that owns the run phase, is not a stream finish.
    if (isTerminalStatus(current) || current === "waiting" || current === "awaiting_user" || current === "compacting") {
      return;
    }
    // A tool_calls finish is a tool phase, not the turn: the pump continues. Settling here made
    // every phase publish `completed` and reset the stream duration between phases.
    if (finishReason === "tool_calls") return;
    this.dispatch({ type: "settle", result: this.deps.getError() ? "error" : "completed" });
  }

  onRunAbort(): void {
    this.dispatch({ type: "interrupt" });
  }

  onRunError(message: string, stack?: string): void {
    this.deps.setError(message);
    this.dispatch({ type: "fail", error: message });
    this.deps.emitEvent?.("agent:stream-error", {
      error: message,
      ...(stack ? { stack } : {}),
    });
  }

  /**
   * Clear error status while waiting to retry a recoverable stream failure.
   * Keeps the panel on `running` during backoff instead of lingering on `error`.
   */
  onRecoveryRetry(): void {
    this.deps.setError("");
    if (this.deps.getStatus() === "error") {
      this.dispatch({ type: "prepare" });
    }
  }

  /**
   * A failure that reached the run from OUTSIDE the stream — a transport/SDK abort-shaped error
   * whose signal is NOT this run's, an external fault.
   *
   * Always terminal: this is not the user's abort (`onRunAbort` owns that), so the turn failed. It
   * used to take an `isAbort` flag that recorded the message WITHOUT the status, which made the
   * pump derive `finished` (its only failure signal is `status === "error"`), run post-run memory
   * extraction, emit `agent:stop{finished}` / `turn:summary{finished}`, and then have
   * `reconcileAfterRun` flip the status to `error` from the leftover text — two conclusions for
   * one run.
   */
  onExternalError(message: string): void {
    this.deps.setError(message);
    this.dispatch({ type: "fail", error: message });
  }

  onUserCancel(): void {
    // `isActiveStatus`, not a hand-written subset: `waiting` / `awaiting_user` are active waits
    // (a run parked on an approval or `ask_user`), and an abort that reached here used to leave
    // them un-marked while the other abort writer (`abortManagedAgentRun`) did mark them.
    if (isActiveStatus(this.deps.getStatus())) {
      this.dispatch({ type: "interrupt" });
    }
  }

  syncApprovals(needsApproval: ToolPhaseCompleteInfo["needsApproval"]): void {
    const count = needsApproval.length;
    this.deps.setPendingApprovalCount(count);

    if (count === 0) {
      if (this.deps.getStatus() === "waiting") {
        this.dispatch({ type: "resume" });
      }
      return;
    }

    // Conversation order decides which wait the status names. The batch is authoritative for "an
    // approval was just requested", but a question asked EARLIER keeps its status until answered —
    // otherwise the status flips every time either side re-asserts itself.
    const messages = this.deps.getMessages?.();
    const first = messages ? firstPendingInteraction(messages) : undefined;
    if (first === undefined || first.kind === "approval") {
      if (this.deps.getStatus() !== "waiting") {
        this.dispatch({ type: "pause", wait: "approval" });
      }
    }

    const auto = this.deps.shouldAutoApprove?.() ?? false;
    for (const approval of needsApproval) {
      this.deps.emitEvent?.("agent:tool-approval-request", {
        tool_call_id: approval.toolCallId,
        tool_name: approval.toolName,
        approval_id: approval.approvalId,
        tool_input: approval.input,
        ...(auto ? { auto: true } : {}),
      });
    }
  }

  onBeforeToolCall(): void {
    if (this.deps.getStatus() !== "waiting") return;
    // Recompute from the transcript instead of zeroing. A parallel batch can hold one answered
    // call and one still-unanswered sibling; zeroing here reported `pendingApprovalCount: 0`
    // beside `interactions.approvals: [1]` (the badge flickered to "no approval" until the next
    // phase), and the run is genuinely still parked on the user for the second call.
    const messages = this.deps.getMessages?.();
    const remaining = messages ? countPendingToolApprovals(messages) : 0;
    this.deps.setPendingApprovalCount(remaining);
    if (remaining === 0) this.dispatch({ type: "resume" });
  }

  setClientToolWaiting(active: boolean): void {
    // Derive from the transcript first: a batch can hold both an approval and a question, and the
    // host answers them in the order they were asked, so the status names whichever is FIRST.
    const messages = this.deps.getMessages?.();
    const first = messages ? firstPendingInteraction(messages) : undefined;
    if (first) {
      // Re-asserting the same status every time the host re-dispatches is cheap: `setStatus` emits
      // `agent:status` only on a real transition, and `emitStateChange` dedupes its frame by
      // signature, so this cannot feed an app↔core emit loop.
      this.dispatch({ type: "pause", wait: first.kind === "approval" ? "approval" : "question" });
      return;
    }
    if (active) {
      // The caller asserts a question the transcript does not (yet) show — honour the only signal
      // we have rather than dropping the wait.
      if (this.deps.getStatus() !== "awaiting_user") {
        this.dispatch({ type: "pause", wait: "question" });
      }
      return;
    }
    if (this.deps.getStatus() === "awaiting_user") {
      const axes = this.deps.getAgentState?.();
      if (axes && (axes.outcome === "error" || axes.outcome === "aborted")) {
        // Answering a question after the turn failed/aborted clears the wait, not the outcome.
        this.dispatch({ type: "resume" });
      } else {
        this.dispatch({ type: "settle", result: "completed", clearWait: true });
      }
    }
  }

  resetToIdle(): void {
    this.deps.setError("");
    this.dispatch({ type: "reset" });
  }

  /**
   * Clear a `waiting` / `awaiting_user` that no transcript interaction backs.
   *
   * `setClientToolWaiting(true)` may assert a question before its part is visible (and a host can
   * assert one that never arrives, e.g. a stale UI after a session switch). Nothing else clears
   * that wait: input queues forever, `stop()` finds no pending interaction, and `interrupt` keeps a
   * question by design. Resolving it on the next input / Esc is the escape hatch.
   */
  clearUnbackedWait(kind: "question" | "any" = "any"): void {
    const status = this.deps.getStatus();
    const matches =
      kind === "question" ? status === "awaiting_user" : status === "waiting" || status === "awaiting_user";
    if (!matches) return;
    const messages = this.deps.getMessages?.() ?? [];
    if (firstPendingInteraction(messages)) return;
    const outcome = this.deps.getAgentState?.()?.outcome;
    this.dispatch({
      type: "settle",
      result: outcome === "error" ? "error" : outcome === "aborted" ? "aborted" : "completed",
      clearWait: true,
    });
  }

  reconcileFromUIMessages(messages: UIMessage[], options?: ReconcileFromUIMessagesOptions): void {
    const whenClear = options?.whenClear ?? "idle";
    // The badge counts every pending approval, independent of which wait the status names.
    this.deps.setPendingApprovalCount(countPendingToolApprovals(messages));

    // Conversation order: the status describes the interaction the host is asking FIRST.
    const first = firstPendingInteraction(messages);
    if (first?.kind === "approval") {
      this.dispatch({ type: "pause", wait: "approval" });
      return;
    }
    if (first?.kind === "clientTool") {
      this.dispatch({ type: "pause", wait: "question" });
      return;
    }
    if (this.deps.getStatus() === "waiting" || this.deps.getStatus() === "awaiting_user") {
      if (whenClear === "running") this.dispatch({ type: "resume" });
      else if (whenClear === "completed") this.dispatch({ type: "settle", result: "completed", clearWait: true });
      else this.dispatch({ type: "reset" });
    }
  }

  /** Mid-run / resume reconcile using a named policy instead of raw `whenClear` literals. */
  reconcileWithPolicy(messages: UIMessage[], policy: StatusReconcilePolicy): void {
    this.reconcileFromUIMessages(messages, { whenClear: whenClearForReconcilePolicy(policy) });
  }

  /**
   * Reconcile status after a chat pump finishes.
   *
   * TanStack `chat()` may end the AG-UI stream while `toolPhase === "wait"` —
   * lifecycle `onFinish` never runs and status can remain `running`.
   */
  reconcileAfterRun(messages: UIMessage[]): void {
    this.reconcileFromUIMessages(messages, { whenClear: "completed" });

    const status = this.deps.getStatus();
    if (status === "waiting" || status === "awaiting_user") return;
    if (needsToolPhaseContinue(messages)) return;
    if (needsAgentResponseAfterTools(messages)) return;
    if (isTerminalStatus(status)) return;

    if (isBusyStatus(status)) {
      const result = this.deps.getError() ? "error" : "completed";
      if (status === "compacting") this.dispatch({ type: "stream-end", result });
      else this.dispatch({ type: "settle", result });
    }
  }

  /**
   * A terminal run that still owns an unanswered `ask_user` is parked on the USER, not finished.
   *
   * `ask_user` is a client tool: the server run cannot answer it, and it is deliberately NOT
   * cancelled on error/abort (cancelling it would make the question unanswerable and throw away the
   * user's input). Leaving the status at `error` / `aborted` while that interaction is still pending
   * is a contradiction the input queue reads literally: `sendMessage` is admitted instead of
   * deferred, the next pump breaks immediately on the pending interaction, and `deriveChatOutcome`
   * re-derives the old terminal status from the field it never left — so every later user message was
   * appended to the transcript and never sent, with no visible change. Naming the wait keeps input
   * queued (released when the question is answered) and matches the interaction snapshot.
   */
  syncPendingQuestionWait(messages: UIMessage[]): void {
    if (firstPendingInteraction(messages)?.kind !== "clientTool") return;
    if (this.deps.getStatus() === "awaiting_user") return;
    this.dispatch({ type: "pause", wait: "question" });
  }

  /**
   * Single entry for end-of-run status finalization (chat pump and detached/subagent).
   *
   * Prefer this over calling {@link reconcileAfterRun} / legacy detached helpers directly.
   */
  applyRunOutcome(outcome: AgentRunOutcome): void {
    const path = outcome.path ?? "chat";
    const { kind, messages } = outcome;

    // Keep approval badge in sync even when we take a terminal shortcut (error/abort).
    this.deps.setPendingApprovalCount(countPendingToolApprovals(messages));

    if (kind === "aborted") {
      this.onRunAbort();
      // Chat only: a detached worker must not stay in an active wait (see `syncPendingQuestionWait`).
      if (path !== "detached") this.syncPendingQuestionWait(messages);
      return;
    }

    if (kind === "error") {
      // Dedupe on the AXES, not the projected status: a pending `ask_user` keeps projecting
      // `awaiting_user` while `outcome` is already `error`, so the old test re-emitted the same
      // failure (once from the stream hook, once from the pump finalizer).
      const axes = this.deps.getAgentState?.();
      const alreadyError = axes ? axes.outcome === "error" : this.deps.getStatus() === "error";
      if (!alreadyError) {
        if (outcome.errorMessage) {
          this.onRunError(outcome.errorMessage);
        } else {
          this.dispatch({ type: "fail", error: outcome.errorMessage ?? "Run failed" });
        }
      } else if (outcome.errorMessage && !this.deps.getError()) {
        this.deps.setError(outcome.errorMessage);
      }
      // Chat only: `finalizeDetached` right after this must end on a terminal status, and a
      // detached worker has no UI that could answer a `clientTool` anyway.
      if (path !== "detached") this.syncPendingQuestionWait(messages);
      return;
    }

    if (kind === "waiting") {
      // Pending approval / ask_user: reconcile sets waiting|awaiting_user from messages.
      // whenClear only matters if messages no longer require a wait (should not happen for this kind).
      this.reconcileWithPolicy(messages, path === "detached" ? "after-chat-run" : "during-run");
      if (path === "detached") {
        this.forceDetachedTerminal();
      }
      return;
    }

    // finished
    this.reconcileAfterRun(messages);
    if (path === "detached") {
      this.forceDetachedTerminal();
    }
  }

  private forceDetachedTerminal(): void {
    const status = this.deps.getStatus();
    if (status === "waiting" || status === "awaiting_user") {
      // Subagent run is over — do not linger as "active" for the task panel.
      this.dispatch({ type: "settle", result: this.deps.getError() ? "error" : "completed", clearWait: true });
      return;
    }
    if (isTerminalStatus(status) || status === "completed" || status === "idle") return;

    if (isBusyStatus(status)) {
      const result = this.deps.getError() ? "error" : "completed";
      if (status === "compacting") this.dispatch({ type: "stream-end", result });
      else this.dispatch({ type: "settle", result, clearWait: true });
    }
  }
}

export function createAgentStatusController(deps: AgentStatusControllerDeps): AgentStatusController {
  return new AgentStatusController(deps);
}
