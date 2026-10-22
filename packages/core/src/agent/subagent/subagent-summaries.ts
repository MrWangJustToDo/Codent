/**
 * Child-agent rows for a status surface (task panel, `subagents` snapshot field, retained
 * `subagents` session channel).
 *
 * Lives with the rest of the subagent-domain derivations (`run-stats`, `progress-summary`,
 * `subagent-stop-reason`) because that is what it is: a projection of a child agent into
 * something displayable. It is the sibling of `task-run-state.ts`, which it calls.
 *
 * It reads `ManagedAgent` and its catalog, which are owned by `managers/**` — so it reaches them
 * through the `runtime-types/hosts.ts` ports module, exactly as `task-run-state.ts` does. That
 * module exists for this: `agent → managers` is not an allowed edge, but domain code may name the
 * manager's *type* through the sink. (Type-only is all this needs: `managed.id`, `child.usage` and
 * `child.getStatus()` are members of that type.)
 *
 * Not in `agent-session/**`, where the snapshot consumes it: that layer is the host boundary, and a
 * manager must not import it. The session snapshot and the retained channel both call this, so the
 * two can never disagree about what a row contains.
 */

import { readTaskRunPhase } from "./task-run-state.js";

import type { ManagedAgent } from "../../runtime-types/hosts.js";
import type { AgentSessionSubagentSummary, UsageChangeSnapshot } from "../../runtime-types/session-payloads.js";

interface SubagentCatalog {
  getSubagents(parentId: string): ManagedAgent[];
}

/**
 * `subagent-<description>` → `<description>`.
 *
 * A spawned subagent's name carries its spawn description, so the row shows the description rather
 * than the synthetic agent name.
 */
function subagentDescription(name: string | undefined): string | undefined {
  if (!name) return undefined;
  if (name.startsWith("subagent-")) {
    const rest = name.slice("subagent-".length).trim();
    return rest || undefined;
  }
  return name;
}

/**
 * Project every child of `managed` into a display row.
 *
 * Includes internal workers (compaction / memory summarizers): the task panel doubles as an
 * observability surface for hidden agents. Callers that need "is a user-visible task running?"
 * must filter with `isUserVisibleTaskRow` — a summarizer counts as active otherwise.
 */
export function buildSubagentSummaries(
  managed: ManagedAgent,
  manager: SubagentCatalog | null | undefined
): AgentSessionSubagentSummary[] {
  if (!manager) return [];
  return manager.getSubagents(managed.id).map((child) => {
    const description = subagentDescription(child.name);
    const usage: UsageChangeSnapshot = child.usage.getChangeSnapshot();
    return {
      id: child.id,
      status: child.getStatus(),
      name: child.name,
      taskPhase: readTaskRunPhase(managed, child.parentTaskId),
      profile: child.config?.profileId ?? (child.parentId ? "explore" : "root"),
      ...(description ? { description } : {}),
      ...(child.parentTaskId ? { parentTaskToolCallId: child.parentTaskId } : {}),
      usage,
    };
  });
}
