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

/**
 * Exhaustive record, then array.
 *
 * `satisfies Record<AgentStatus, true>` makes a new `AgentStatus` member a COMPILE error here; a
 * hand-maintained array would silently omit it, and `deriveAgentState`'s switch cannot catch the
 * omission because it only ever receives a member that is already in the array. The three derived
 * sets (terminal / active / busy) all read this list.
 */
const STATUS_BY_KIND = {
  idle: true,
  running: true,
  completed: true,
  error: true,
  aborted: true,
  waiting: true,
  awaiting_user: true,
  compacting: true,
  thinking: true,
  responding: true,
} as const satisfies Record<AgentStatus, true>;

const ALL_STATUSES: readonly AgentStatus[] = Object.keys(STATUS_BY_KIND) as AgentStatus[];

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
 * Busy = a run is doing work right now (running / thinking / responding / compacting).
 *
 * Deliberately NOT `isActiveStatus`: an ACTIVE wait (`waiting` / `awaiting_user`) keeps the session
 * occupied but is not work, and a settled outcome is not work either. One derived set, so the status
 * controller and the app footer cannot drift into private copies.
 */
export const BUSY_STATUSES: ReadonlySet<AgentStatus> = new Set(
  ALL_STATUSES.filter((status) => {
    const state = deriveAgentState(status);
    return state.wait === "none" && state.run !== "idle" && state.outcome === "none";
  })
);

export function isBusyStatus(status: AgentStatus): boolean {
  return BUSY_STATUSES.has(status);
}

/**
 * Sticky = a status a late stream chunk may not move.
 *
 * Derived from the axes rather than listed: a status is sticky because it is PARKED on a human, has
 * already reached a verdict, or a compaction lease owns the run phase. A hand-written list here had
 * to be kept in step with three separate concerns, and the next wait kind (an approval spelled
 * differently, a new terminal reason) would have compiled clean while a trailing chunk resurrected
 * `running` — with no pump left to settle it.
 */
export const STICKY_STATUSES: ReadonlySet<AgentStatus> = new Set(
  ALL_STATUSES.filter((status) => {
    const state = deriveAgentState(status);
    return state.wait !== "none" || state.outcome !== "none" || state.run === "compacting";
  })
);

export function isStickyStatus(status: AgentStatus): boolean {
  return STICKY_STATUSES.has(status);
}

/**
 * Parked = the session is waiting on the user (a tool approval or an `ask_user` question).
 *
 * The one predicate for "input is owed, not work": the status that must not be overwritten by a
 * chunk, the status that defers mid-run queueing, and the status a pump must not blindly prepare
 * over. Keyed on the axis so a new wait kind needs no new spelling here.
 */
export function isParkedStatus(status: AgentStatus): boolean {
  return deriveAgentState(status).wait !== "none";
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
