/**
 * Typed end-of-run / mid-run status policies for {@link AgentStatusController}.
 */

import type { AgentState } from "../../runtime-types/agent-state.js";
import type { AgentRunOutcomeKind } from "../../runtime-types/agent-status.js";
import type { UIMessage } from "@tanstack/ai";

/**
 * How a run ended (or paused) for status finalization.
 *
 * The union lives in `runtime-types/agent-status.ts` next to {@link RunFinalizeReason}, which it
 * extends with `waiting`: the pause that is not a turn end. Declaring it beside the finalize
 * reasons is what makes the relationship structural instead of two hand-maintained literals that
 * merely looked alike.
 */
export type { AgentRunOutcomeKind };

/**
 * Chat vs detached completion differ for leftover wait states:
 * - `chat` — preserve waiting / awaiting_user (approval / ask_user)
 * - `detached` — force terminal completed so task panel does not keep ghosts
 */
export type AgentRunPath = "chat" | "detached";

export interface AgentRunOutcome {
  kind: AgentRunOutcomeKind;
  messages: UIMessage[];
  path?: AgentRunPath;
  finishReason?: string | null;
  errorMessage?: string;
}

/** Named mid-run / load-time reconcile policies (replaces raw whenClear literals at call sites). */
export type StatusReconcilePolicy = "during-run" | "after-chat-run" | "idle-clear";

export type WhenClearStatus = "idle" | "running" | "completed";

/**
 * The pump's outcome, read from the state axes rather than from status strings.
 *
 * `hasError` is the stream processor's signal that this pump failed (the run may not have reached
 * `fail` yet); `waitingForUser` is the transcript's pending interaction. Everything else is the
 * state machine's own verdict.
 */
export function deriveRunOutcomeKind(
  state: AgentState,
  input: { hasError: boolean; waitingForUser: boolean }
): AgentRunOutcomeKind {
  if (state.outcome === "aborted") return "aborted";
  if (input.hasError || state.outcome === "error") return "error";
  if (input.waitingForUser || state.wait !== "none") return "waiting";
  return "finished";
}

export function whenClearForReconcilePolicy(policy: StatusReconcilePolicy): WhenClearStatus {
  switch (policy) {
    case "during-run":
      return "running";
    case "after-chat-run":
      return "completed";
    case "idle-clear":
      return "idle";
  }
}
