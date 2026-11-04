// ============================================================================
// Agent Status
// ============================================================================

// ============================================================================
// Status predicates (shared — importable from agent/ domain modules)
// ============================================================================

import { deriveAgentState, isActiveState, isTerminalState } from "./agent-state.js";

export type AgentStatus =
  | "idle"
  | "running"
  | "completed"
  | "error"
  | "aborted"
  | "waiting"
  | "awaiting_user"
  | "compacting"
  | "thinking"
  | "responding";

/**
 * Why a run's **turn** ended: the reasons that finalize it.
 *
 * Deliberately the primary vocabulary: `waiting` cannot appear here, because a pause for an
 * approval or a client tool is not a turn end — `RunFinalizer.finalizeChat` skips turn
 * finalization for it and keeps turn context for the resume pump.
 */
export type RunFinalizeReason = "finished" | "aborted" | "error";

/**
 * How a run ended **or paused**, for status finalization.
 *
 * One vocabulary, not two: this is `RunFinalizeReason` plus the single pause that must never reach
 * `ManagedAgent.finalizeRun`. Deriving it here is what keeps the two from drifting — a fourth
 * terminal reason is admitted to both sides at once, while a new pause flavour has exactly one
 * place to be declared and stays out of the finalize path by construction.
 */
export type AgentRunOutcomeKind = RunFinalizeReason | "waiting";

const ALL_STATUSES: readonly AgentStatus[] = [
  "idle",
  "running",
  "completed",
  "error",
  "aborted",
  "waiting",
  "awaiting_user",
  "compacting",
  "thinking",
  "responding",
];

/**
 * Derived, not a hand-maintained overlapping set: `waiting`/`awaiting_user` are ACTIVE waits, not
 * terminal. Kept as sets for the consumers (registry cancellation ordering) that ask by value.
 */
export const TERMINAL_STATUSES: ReadonlySet<AgentStatus> = new Set(
  ALL_STATUSES.filter((status) => isTerminalState(deriveAgentState(status)))
);

export const ACTIVE_STATUSES: ReadonlySet<AgentStatus> = new Set(
  ALL_STATUSES.filter((status) => isActiveState(deriveAgentState(status)))
);

export function isTerminalStatus(status: AgentStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function isActiveStatus(status: AgentStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

/**
 * Resolve the status to apply when an agent run finishes.
 *
 * Terminal/parked/compacting states are kept; otherwise the result is the run's error or success.
 * The axes decide the first three, so a new wait/terminal state does not need a fourth special case.
 */
export function resolveFinishStatus(current: AgentStatus, errorMessage: string): AgentStatus {
  const state = deriveAgentState(current, errorMessage);
  if (isTerminalState(state) || state.wait !== "none" || state.run === "compacting") return current;
  return errorMessage ? "error" : "completed";
}
