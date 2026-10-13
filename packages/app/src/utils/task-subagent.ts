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
