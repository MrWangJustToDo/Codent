/**
 * Typed end-of-run / mid-run status policies for {@link AgentStatusController}.
 */

import type { AgentState } from "../../runtime-types/agent-state.js";
import type { AgentRunOutcomeKind } from "../../runtime-types/agent-status.js";
import type { WhenClearStatus } from "../../runtime-types/session-payloads.js";
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
  errorMessage?: string;
}

/** Named mid-run / load-time reconcile policies (replaces raw whenClear literals at call sites). */
export type StatusReconcilePolicy = "during-run" | "after-chat-run" | "idle-clear";

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

/**
 * The verdict for a turn the user cancelled.
 *
 * It reads the AXIS, never the projection: `wait=question` outranks `outcome=error`, so a failed run
 * parked on `ask_user` PROJECTS as `awaiting_user` and `getStatus() === "error"` is false. Deriving
 * from the projection recorded that run as `aborted`, contradicting the `agent:stream-error` it had
 * just emitted. Shared by the canceller and its validator so the rule has one definition.
 */
export function deriveCancelVerdict(state: Pick<AgentState, "outcome">): "error" | "aborted" {
  return state.outcome === "error" ? "error" : "aborted";
}
