/**
 * End-of-run finalization: one place for outcome derivation, status application, pre-fork cleanup,
 * session persistence, turn finalization and the `turn:summary` payload.
 *
 * The sequence used to be copied across the chat pump, the subagent runner and the run
 * skeleton's optional outcome path. The ordering is the asset:
 * `applyRunOutcome` before persistence, persistence before `finalizeRun`, and `turn:summary` last
 * (it must land while the run's **log scope** is still set; `finalizeRun` defers only
 * `log.setRun(null)` to a microtask). This class owns it so a new caller cannot reorder it by
 * accident.
 */

import { isSettledToolCallPart, isToolCallPart } from "../agent/stream/message-parts.js";

import type { AgentRunOutcome, AgentRunOutcomeKind } from "./agent-run-outcome.js";
import type { AgentStatus, RunFinalizeReason } from "./agent-types.js";
import type { AgentStatusController } from "./controllers/agent-status-controller.js";
import type { EmitAgentTelemetryFn } from "./telemetry/emit-agent-telemetry.js";
import type { UsageTracker } from "./telemetry/usage-tracker.js";
import type { PreforkDiscardCause } from "../agent/subagent/task-prefork.js";
import type { UIMessage } from "@tanstack/ai";

export interface RunFinalizerDeps {
  status: AgentStatusController;
  getStatus: () => AgentStatus;
  getError: () => string;
  /** Turn-level finalization (agent:stop / persistence / memory extraction); idempotent. */
  finalizeRun: (reason: RunFinalizeReason) => void;
  discardPreforkRuns: (cause: PreforkDiscardCause) => void;
  emitEvent: EmitAgentTelemetryFn;
  usage: UsageTracker;
}

export interface ChatRunFinalizeInput {
  kind: AgentRunOutcomeKind;
  messages: UIMessage[];
  waitingForUser: boolean;
  phases: number;
  turnStartedAt: number;
  /**
   * Usage and tool-call count when THIS pump started.
   *
   * The summary describes the pump, so it reports deltas against these. Reporting the session
   * totals made the numbers unreadable and unbounded ("Turn complete … 58982→802 tokens" was
   * 5.9k for the first turn and 5.4M twenty turns later) and made a turn split by approvals look
   * like one long turn with an impossible tool count.
   */
  usageBefore: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
  costBefore: number;
  toolCallsBefore: number;
  /** Chat controller-owned persistence (channel → session store). */
  persist: () => void;
}

/**
 * Tool calls that reached an outcome in a channel snapshot.
 *
 * A pump reports `countToolCalls(end) - countToolCalls(start)` in `turn:summary`, so this has to be
 * "settled", not "created": an approval-split turn requests its tools in one pump (they stay
 * pending) and runs them in the next, and counting created parts reported `0 tools` for the pump
 * that actually executed them.
 */
export function countToolCalls(messages: readonly UIMessage[]): number {
  let count = 0;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) if (isToolCallPart(part) && isSettledToolCallPart(part)) count += 1;
  }
  return count;
}

export class RunFinalizer {
  constructor(private readonly deps: RunFinalizerDeps) {}

  /**
   * Prefer an already-set terminal status over message-derived waits, matching the pump's old
   * inline expression: aborted > error > waiting > finished.
   */
  deriveChatOutcome(input: { hasError: boolean; waitingForUser: boolean }): AgentRunOutcomeKind {
    const status = this.deps.getStatus();
    if (status === "aborted") return "aborted";
    if (input.hasError || status === "error") return "error";
    if (input.waitingForUser) return "waiting";
    return "finished";
  }

  /**
   * Chat pump terminal path. The caller keeps the `keepPumping` early return (a continuation is not
   * a turn end); everything after the loop's decision lives here.
   */
  finalizeChat(input: ChatRunFinalizeInput): AgentRunOutcomeKind {
    // A wait is not a turn end: the pump that answers it is what joins an eager `task`.
    if (!input.waitingForUser) {
      this.deps.discardPreforkRuns("run-finish");
    }

    // Only supply a message when status is not already error (avoids duplicate stream-error).
    const errorMessage =
      input.kind === "error" && this.deps.getStatus() !== "error"
        ? this.deps.getError() || "Stream execution failed"
        : undefined;

    this.deps.status.applyRunOutcome({
      kind: input.kind,
      messages: input.messages,
      path: "chat",
      ...(errorMessage ? { errorMessage } : {}),
    });
    input.persist();

    // Waiting (approval / ask_user) keeps turn context for the resume pump.
    if (input.kind !== "waiting") {
      this.deps.finalizeRun(input.kind);
    }

    const totalUsage = this.deps.usage.getTotal();
    const delta = (now: number, before: number) => Math.max(0, now - before);
    this.deps.emitEvent("turn:summary", {
      ...(input.kind !== "waiting" ? { outcome: input.kind } : {}),
      phases: input.phases,
      toolCalls: delta(countToolCalls(input.messages), input.toolCallsBefore),
      inputTokens: delta(totalUsage.inputTokens, input.usageBefore.inputTokens),
      outputTokens: delta(totalUsage.outputTokens, input.usageBefore.outputTokens),
      cacheReadTokens: delta(totalUsage.cacheReadTokens ?? 0, input.usageBefore.cacheReadTokens ?? 0),
      cacheWriteTokens: delta(totalUsage.cacheWriteTokens ?? 0, input.usageBefore.cacheWriteTokens ?? 0),
      costUsd: Math.max(0, this.deps.usage.getTotalCostUsd() - input.costBefore),
      durationMs: Date.now() - input.turnStartedAt,
    });

    return input.kind;
  }

  /** Detached/subagent terminal path: no chat turn summary; status then turn finalize. */
  finalizeDetached(input: { kind: RunFinalizeReason; messages: UIMessage[]; errorMessage?: string }): void {
    this.deps.status.applyRunOutcome({
      kind: input.kind,
      messages: input.messages,
      path: "detached",
      ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
    });
    this.deps.finalizeRun(input.kind);
  }

  /** Optional-outcome path in `runAgentOnce` (and any caller that only needs status). */
  applyOutcome(outcome: AgentRunOutcome): void {
    this.deps.status.applyRunOutcome(outcome);
  }

  /** Status-only snapshot reconcile (no chat turn summary; the run finalizer owns it). */
  finalizeSnapshot(messages: UIMessage[]): void {
    this.deps.status.applyRunOutcome({ kind: "finished", messages, path: "chat" });
  }
}
