/**
 * Which subagent row a `task` tool call should render.
 *
 * Read-side defence-in-depth for orphans — a pre-fork that was aborted while a SECOND subagent was
 * spawned for the same call id. Resolving a call id to "the first row with this binding" is a trap
 * that outlives any single cause of it: `snapshot.subagents` is built from `childIds`, which is spawn
 * order, so an orphan always precedes the run that replaced it, and the first match is exactly the
 * wrong one when both exist.
 *
 * It has outlived two generations of that cause, which is the argument for keeping it. First,
 * discarding on `RUN_STARTED` — a per-iteration event, so a healthy pre-fork died at the next
 * iteration's boundary. Then, discarding on an `onFinish` that merely ended a *pausing* invocation
 * (an approval / client-tool wait ends the `chat()` invocation while the run continues). Both are
 * fixed in core, and a third is not implausible.
 *
 * What it does NOT cover is the surface the orphan is most visible on: the task panel renders
 * `snapshot.subagents` directly, so a stranded row lists there even while this resolution correctly
 * picks the live one for the transcript row.
 *
 * Two properties make the resolution robust rather than merely reordered:
 *
 * 1. **A live row beats a stopped one.** Whatever the orphan's final status, the run that is
 *    still working is the one whose state and progress the caller asked for.
 * 2. **On a tie, the LATEST row wins.** Among equally-live (or equally-stopped) candidates
 *    the later spawn is the current run; the earlier one is the discarded attempt. Picking
 *    the first would hand back the dead attempt even when the live one exists.
 *
 * @example
 * const row = resolveTaskSubagent(snapshot.subagents, toolCallId);
 * if (row) renderTaskRow(row);
 */

import { isActiveStatus } from "@codent/core";

import type { AgentSessionSubagentSummary } from "@codent/core";

/**
 * Whether a `task` row is still working, i.e. must render as in-progress rather than as a result.
 *
 * Three signals, because a task can be live while none of the others says so:
 *
 * 1. **`isExecuting`** — a blocking call, still awaited by the framework. The ordinary case.
 * 2. **A background start handle** (`status: "running"` on the frozen output) — a
 *   `run_in_background` call settles the moment it starts, so `isExecuting` is already `false` while
 *   the child is still (or still queued) working. The settle handler overwrites the same tool part
 *   with `status: "completed"`, and that write — not a timer — is the transition out of this state.
 * 3. **A resolved child that is still active** — the part can be rewritten a moment before the
 *   child's final event lands, and a live child is the strongest evidence of all.
 *
 * Signal 2 is why `agent` alone is not enough: a queued background task has no child row yet (spawn
 * order admits it only when a concurrency slot frees up), so "no agent" must not read as "finished".
 *
 * Keeping this a pure function lets the row render itself from the same answer the transcript uses
 * for the elapsed clock and the summary stream — three call sites that would otherwise each
 * re-derive "is it running?" from a different field and disagree.
 */
export function isTaskRowLive(input: {
  isExecuting: boolean;
  /** The frozen output's `status`; `"running"` is the background start handle. */
  outputStatus?: string | null;
  /** The child row this call resolves to, when it exists yet. */
  agent?: Pick<AgentSessionSubagentSummary, "status"> | null;
}): boolean {
  if (input.isExecuting) return true;
  if (input.outputStatus === "running") return true;
  return input.agent != null && isActiveStatus(input.agent.status);
}

/** Live rows outrank stopped ones; ties break toward the later (newer) row. */
function rank(row: AgentSessionSubagentSummary): number {
  return isActiveStatus(row.status) ? 1 : 0;
}

export function resolveTaskSubagent(
  rows: readonly AgentSessionSubagentSummary[],
  taskId: string
): AgentSessionSubagentSummary | undefined {
  if (!taskId) return undefined;
  let picked: AgentSessionSubagentSummary | undefined;
  for (const row of rows) {
    if (row.parentTaskToolCallId !== taskId) continue;
    // `>=` on the rank is deliberate: an equal rank replaces, which is what makes the later
    // row win. A strictly-greater test would keep the first of two equally-ranked candidates
    // — the orphan, in the exact shape this exists to survive.
    if (!picked || rank(row) >= rank(picked)) {
      picked = row;
    }
  }
  return picked;
}
