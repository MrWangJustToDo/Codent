import { isActiveStatus, isBusyStatus } from "@codent/core";

import { COLORS } from "../theme/colors.js";

import type { AgentSessionSubagentSummary, AgentStatus } from "@codent/core";

/**
 * Icon per status. `satisfies Record<AgentStatus, string>` makes a NEW core status a compile error
 * here — a missing key would otherwise make `isAgentStatus` lie (the status renders as unknown and
 * the activity predicates are never even called), which is exactly the drift this map is the guard
 * for. The `as const` keeps the wide `string` index `getStatusIcon` needs.
 */
const STATUS_ICON = {
  running: ">",
  thinking: ">",
  responding: ">",
  compacting: ">",
  waiting: "⌛",
  awaiting_user: "⌛",
  completed: "✓",
  error: "✗",
  aborted: "⊘",
  idle: "○",
} as const satisfies Record<AgentStatus, string>;

/** Runtime guard for a status that crossed a serialized boundary (a remote/restored snapshot). */
function isAgentStatus(value: string): value is AgentStatus {
  return Object.hasOwn(STATUS_ICON, value);
}

export function getStatusIcon(status: string): string {
  return (STATUS_ICON as Record<string, string>)[status] ?? "?";
}

export function getStatusColor(status: string): string {
  if (status === "completed") return COLORS.success;
  if (status === "error") return COLORS.danger;
  if (status === "aborted") return COLORS.muted;
  // Core owns the busy set: a hand-written copy here went stale the moment a status was added.
  if (isAgentStatus(status) && isBusyStatus(status)) return COLORS.warning;
  return COLORS.muted;
}

/**
 * Display-level activity check for subagent panel rows.
 *
 * Delegates to core's `isActiveStatus` so a new status (or a new wait kind) cannot make a running
 * row render as inactive without a compile error in core.
 */
export function isSubagentActiveStatus(status: string): boolean {
  return isAgentStatus(status) && isActiveStatus(status);
}

export function getTaskLabel(task: AgentSessionSubagentSummary): string {
  if (task.description) return task.description;
  const name = task.name ?? task.id;
  return name.startsWith("subagent-") ? name.slice("subagent-".length) : name;
}

/**
 * A task-panel row's display status: label, icon, colour.
 *
 * `taskPhase` is keyed by TASK CALL, and one call can own more than one subagent — a pre-fork
 * discarded at a run boundary (or by a stream restart) is respawned under the same call id, and both
 * keep their catalog entry, deliberately: Ctrl+T is how a discard is observable. So the phase may only
 * describe a row whose own status is the ambiguous one the phase exists to disambiguate — a budget
 * cutoff leaves the run `completed`, and `limit` is what says it was a cutoff rather than a clean
 * finish. Every other status is this subagent's own and strictly more specific.
 *
 * The regression this encodes: a discarded generation read "limit reached" because the generation
 * that replaced it exhausted the step budget. The run that was aborted never hit a limit, and the
 * detail view (which reads this subagent's own snapshot) said so.
 */
export function resolveSubagentRowDisplay(
  status: string,
  taskPhase?: string
): { label: string; icon: string; color: string; stoppedByLimit: boolean } {
  const stoppedByLimit = taskPhase === "limit" && status === "completed";
  return {
    stoppedByLimit,
    label: stoppedByLimit ? "limit reached" : status,
    icon: stoppedByLimit ? "⚠" : getStatusIcon(status),
    color: stoppedByLimit ? COLORS.warning : getStatusColor(status),
  };
}
