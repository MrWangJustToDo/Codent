/**
 * Single source of truth for agent status transitions.
 *
 * Stream lifecycle, compaction, approvals, client-tool pauses, and post-run
 * reconciliation all flow through this controller. {@link createStatusMiddleware}
 * is the only runtime hook surface; app code calls the reconcile helpers on
 * {@link ManagedAgent}.
 */

import {
  countPendingToolApprovals,
  hasPendingAskUser,
  needsAgentResponseAfterTools,
  needsToolPhaseContinue,
} from "../../agent/stream/tool-phase-utils.js";
import { isTerminalStatus, resolveFinishStatus } from "../../runtime-types/agent-status.js";
import {
  whenClearForReconcilePolicy,
  type AgentRunOutcome,
  type StatusReconcilePolicy,
  type WhenClearStatus,
} from "../agent-run-outcome.js";

import type { AgentStatus } from "../agent-types.js";
import type { EmitAgentTelemetryFn } from "../telemetry/emit-agent-telemetry.js";
import type { StreamChunk, ToolPhaseCompleteInfo, UIMessage } from "@tanstack/ai";

export type {
  AgentRunOutcome,
  AgentRunOutcomeKind,
  AgentRunPath,
  StatusReconcilePolicy,
} from "../agent-run-outcome.js";

// ============================================================================
// Types
// ============================================================================

export interface AgentStatusControllerDeps {
  getStatus: () => AgentStatus;
  setStatus: (status: AgentStatus, trigger?: string) => void;
  getError: () => string;
  setError: (error: string) => void;
  setPendingApprovalCount: (count: number) => void;
  /** Record the run's model finish reason (null when a new run starts). */
  setFinishReason?: (reason: string | null) => void;
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
  setStatus: (s: AgentStatus, trigger?: string) => void,
  chunk: StreamChunk
): void {
  const type = chunk.type;
  const current = getStatus();

  // Keep interactive pauses and user cancel sticky — leftover chunks must not resurrect "running".
  if (current === "waiting" || current === "awaiting_user" || current === "aborted") return;

  // Each branch names the status its chunk implies and moves only when the agent
  // is not already there. A run streams hundreds of reasoning/text chunks in a
  // row, so re-setting the status it already has is not a transition: `setStatus`
  // logs only real transitions but still re-emits the state/mode/interaction
  // projections on every call, and recomputes the interaction snapshot (two full
  // passes over the message list) with them.
  if (type === "TOOL_CALL_START") {
    if (current !== "running") setStatus("running", "chunk:tool");
    return;
  }

  if (type === "REASONING_MESSAGE_CONTENT" || type === "REASONING_MESSAGE_START") {
    if (current !== "thinking") setStatus("thinking", "chunk:reasoning");
    return;
  }

  if (type === "TEXT_MESSAGE_CONTENT") {
    if (current === "running" || current === "thinking") {
      setStatus("responding", "chunk:text");
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

  /** Bridge the gap before TanStack `onStart` during {@link AgentChatController} pump. */
  prepareRunPhase(messages: UIMessage[]): void {
    if (countPendingToolApprovals(messages) > 0) return;

    const status = this.deps.getStatus();
    // `awaiting_user` is a wait on a CLIENT tool. Once its result is in the transcript the wait is
    // over: returning here unconditionally left the resume pump under `awaiting_user`, so
    // `applyChunkStatus` ignored every status beat, `isAgentLoading` stayed false, and new input
    // was queued as if the session were still paused. Only an unanswered question keeps the wait.
    if (status === "awaiting_user" && hasPendingAskUser(messages)) return;
    if (
      status === "waiting" ||
      // Reachable only when the question above was ANSWERED (the pending case returned early).
      status === "awaiting_user" ||
      status === "idle" ||
      status === "completed" ||
      status === "error" ||
      status === "aborted"
    ) {
      this.deps.setStatus("running", "run-prepare");
    }
  }

  onRunStart(): void {
    this.deps.setFinishReason?.(null);
    const status = this.deps.getStatus();
    if (status === "aborted") return;
    if (status !== "waiting" && status !== "awaiting_user") {
      this.deps.setStatus("running", "run-start");
    }
    this.deps.setError("");
  }

  onStreamChunk(chunk: StreamChunk): StreamChunk {
    applyChunkStatus(this.deps.getStatus, this.deps.setStatus, chunk);
    return chunk;
  }

  onRunFinish(finishReason?: string | null): void {
    // Record it BEFORE the status flip: the status change is what emits the state payload that
    // carries it, and a host reading the final state must see the reason.
    this.deps.setFinishReason?.(finishReason ?? null);
    this.deps.setStatus(resolveFinishStatus(this.deps.getStatus(), this.deps.getError()), "run-finish");
  }

  onRunAbort(): void {
    this.deps.setStatus("aborted", "run-abort");
  }

  onRunError(message: string): void {
    this.deps.setError(message);
    this.deps.setStatus("error", "run-error");
    this.deps.emitEvent?.("agent:stream-error", { error: message });
  }

  /**
   * Clear error status while waiting to retry a recoverable stream failure.
   * Keeps the panel on `running` during backoff instead of lingering on `error`.
   */
  onRecoveryRetry(): void {
    this.deps.setError("");
    if (this.deps.getStatus() === "error") {
      this.deps.setStatus("running", "recovery-retry");
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
    this.deps.setStatus("error", "external-error");
  }

  onUserCancel(): void {
    const status = this.deps.getStatus();
    if (status === "running" || status === "thinking" || status === "responding" || status === "compacting") {
      this.deps.setStatus("aborted", "user-cancel");
    }
  }

  beginCompaction(
    kind: "auto" | "reactive" = "auto",
    data?: { retry?: number; maxRetries?: number; tokensBefore?: number }
  ): void {
    this.deps.setStatus("compacting", `compaction:${kind}`);
    if (kind === "reactive") {
      this.deps.emitEvent?.("compaction:reactive-start", data);
    } else {
      this.deps.emitEvent?.("compaction:auto-start", data);
    }
  }

  endCompaction(): void {
    const status = this.deps.getStatus();
    if (status === "compacting") {
      this.deps.setStatus("running", "compaction-end");
    }
  }

  syncApprovals(needsApproval: ToolPhaseCompleteInfo["needsApproval"]): void {
    const count = needsApproval.length;
    this.deps.setPendingApprovalCount(count);

    if (count === 0) {
      if (this.deps.getStatus() === "waiting") {
        this.deps.setStatus("running", "approvals-cleared");
      }
      return;
    }

    if (this.deps.getStatus() !== "waiting") {
      this.deps.setStatus("waiting", "approvals-pending");
    }

    for (const approval of needsApproval) {
      this.deps.emitEvent?.("agent:tool-approval-request", {
        tool_call_id: approval.toolCallId,
        tool_name: approval.toolName,
        approval_id: approval.approvalId,
        tool_input: approval.input,
      });
    }
  }

  onBeforeToolCall(): void {
    if (this.deps.getStatus() === "waiting") {
      this.deps.setPendingApprovalCount(0);
      this.deps.setStatus("running", "before-tool-call");
    }
  }

  setClientToolWaiting(active: boolean): void {
    if (active) {
      // Idempotent guard: the app re-dispatches while an ask_user stays pending
      // (fresh interaction snapshots change the pending object reference), so a
      // same-value setStatus here would re-emit state + interactions and feed an
      // infinite app↔core loop. Only transition when not already awaiting_user.
      if (this.deps.getStatus() !== "awaiting_user") {
        this.deps.setStatus("awaiting_user", "client-tool-wait");
      }
      return;
    }
    if (this.deps.getStatus() === "awaiting_user") {
      this.deps.setStatus("completed", "client-tool-resume");
    }
  }

  resetToIdle(): void {
    this.deps.setError("");
    this.deps.setStatus("idle", "reset");
  }

  reconcileFromUIMessages(messages: UIMessage[], options?: ReconcileFromUIMessagesOptions): void {
    const whenClear = options?.whenClear ?? "idle";
    const pendingCount = countPendingToolApprovals(messages);
    this.deps.setPendingApprovalCount(pendingCount);

    if (pendingCount > 0) {
      this.deps.setStatus("waiting", "reconcile");
      return;
    }
    if (hasPendingAskUser(messages)) {
      this.deps.setStatus("awaiting_user", "reconcile");
      return;
    }
    if (this.deps.getStatus() === "waiting" || this.deps.getStatus() === "awaiting_user") {
      this.deps.setStatus(whenClear, "reconcile");
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

    if (status === "running" || status === "thinking" || status === "responding" || status === "compacting") {
      this.deps.setStatus(this.deps.getError() ? "error" : "completed", "reconcile-after-run");
    }
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
      return;
    }

    if (kind === "error") {
      // executeStream may already have called onRunError — do not re-emit agent:stream-error.
      if (this.deps.getStatus() !== "error") {
        if (outcome.errorMessage) {
          this.onRunError(outcome.errorMessage);
        } else {
          this.deps.setStatus("error", "apply-outcome");
        }
      } else if (outcome.errorMessage && !this.deps.getError()) {
        this.deps.setError(outcome.errorMessage);
      }
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
      this.deps.setStatus(this.deps.getError() ? "error" : "completed", "detached-terminal");
      return;
    }
    if (isTerminalStatus(status) || status === "completed" || status === "idle") return;

    if (status === "running" || status === "thinking" || status === "responding" || status === "compacting") {
      this.deps.setStatus(this.deps.getError() ? "error" : "completed", "detached-terminal");
    }
  }
}

export function createAgentStatusController(deps: AgentStatusControllerDeps): AgentStatusController {
  return new AgentStatusController(deps);
}
