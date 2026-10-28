/**
 * Per-task run-phase state machine — one {@link TaskRunState} instance per
 * `task` tool call, owned by the parent agent.
 *
 * Phases are one-way and authoritative (no message inference):
 * - `running`  — the underlying subagent is exploring (its running/thinking/
 *                responding statuses fold into this single task-level phase)
 * - `summary`  — the subagent called `begin_summary` and is writing its own report
 * - `limit`    — the subagent was force-stopped by the step budget and the
 *                progress-summary fallback is generating the report for it
 *
 * `limit` is deliberately NOT folded into `summary`. Both stream a report, but
 * only one of them means the task finished on its own terms — and the parent's
 * `task` tool result (`reachedLimit` / `incomplete`) already distinguishes them,
 * so collapsing them here made the UI report a budget cutoff as a normal end.
 * The fallback can also be disabled by the spawner; the parent still gets
 * `reachedLimit` from the message-derived stats, so `limit` is absent in that
 * case rather than wrong.
 *
 * The registry that holds these instances (and the pre-fork seats for the same calls) lives in
 * `subagent-runs.ts`: one per-parent owner, so a session switch clears both halves in one call.
 */

export type TaskRunPhase = "running" | "summary" | "limit";

/** Phases after `running`; both are terminal. */
export type TaskRunTerminalPhase = Exclude<TaskRunPhase, "running">;

export class TaskRunState {
  /** Current phase — one-way running → summary | limit. */
  phase: TaskRunPhase = "running";

  constructor(readonly toolCallId: string) {}

  /** Enter a terminal phase; returns true when this call performed the transition. */
  enterPhase(next: TaskRunTerminalPhase): boolean {
    if (this.phase === "running") {
      this.phase = next;
      return true;
    }
    // Already terminal: only the limit stop may upgrade a natural-summary phase,
    // because it is the more specific description of how the run ended (the
    // subagent called `begin_summary`, then exhausted the budget before the run
    // closed). Everything else is a no-op.
    if (this.phase === "summary" && next === "limit") {
      this.phase = "limit";
      return true;
    }
    return false;
  }
}
