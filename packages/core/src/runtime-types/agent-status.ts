// ============================================================================
// Agent Status
// ============================================================================

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

/** Compaction paths that move the status via `compaction:<kind>`. */
export type StatusCompactionKind = "auto" | "manual" | "reactive";

/**
 * Why a status changed.
 *
 * A closed union, not a free string: the log policy suppresses a set of triggers and records the
 * rest, so a typo used to land in neither set and silently produced a row (or, worse, a mechanical
 * transition that looked notable). The policy's `MECHANICAL_STATUS_TRIGGERS` is a subset of this.
 */
export type AgentStatusTrigger =
  | "run-prepare"
  | "run-start"
  | "run-finish"
  | "run-abort"
  | "run-error"
  | "recovery-retry"
  | "external-error"
  | "user-cancel"
  | "approvals-pending"
  | "approvals-cleared"
  | "before-tool-call"
  | "client-tool-wait"
  | "client-tool-resume"
  | "reconcile"
  | "reconcile-after-run"
  | "apply-outcome"
  | "detached-terminal"
  | "reset"
  | "compaction-end"
  | `compaction:${StatusCompactionKind}`
  | "chunk:text"
  | "chunk:tool"
  | "chunk:reasoning";

// ============================================================================
// Status predicates (shared — importable from agent/ domain modules)
// ============================================================================

/** Statuses that must not be overwritten when a stream finishes normally. */
export const TERMINAL_STATUSES = new Set<AgentStatus>(["aborted", "error", "waiting", "awaiting_user"]);

/** Statuses indicating an agent is actively doing work (used for cancellation ordering). */
export const ACTIVE_STATUSES = new Set<AgentStatus>([
  "running",
  "thinking",
  "responding",
  "waiting",
  "awaiting_user",
  "compacting",
]);

export function isTerminalStatus(status: AgentStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function isActiveStatus(status: AgentStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

/** Resolve the status to apply when an agent run finishes. */
export function resolveFinishStatus(current: AgentStatus, errorMessage: string): AgentStatus {
  if (isTerminalStatus(current)) return current;
  if (errorMessage) return "error";
  return "completed";
}
