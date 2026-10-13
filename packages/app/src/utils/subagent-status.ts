import { COLORS } from "../theme/colors.js";

import type { AgentSessionSubagentSummary } from "@codent/core";

const STATUS_ICON: Record<string, string> = {
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
};

export function getStatusIcon(status: string): string {
  return STATUS_ICON[status] ?? "?";
}

export function getStatusColor(status: string): string {
  if (status === "completed") return COLORS.success;
  if (status === "error") return COLORS.danger;
  if (status === "aborted") return COLORS.muted;
  if (["running", "thinking", "responding", "compacting"].includes(status)) return COLORS.warning;
  return COLORS.muted;
}

/** Display-level activity check for subagent panel rows (distinct from core's AgentStatus predicate). */
export function isSubagentActiveStatus(status: string): boolean {
  return ["running", "thinking", "responding", "compacting", "waiting", "awaiting_user"].includes(status);
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
