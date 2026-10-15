/**
 * Child-agent rows for a status surface (task panel, `subagents` snapshot field, retained
 * `subagents` session channel).
 *
 * Lives in `managers/**` rather than in the `agent-session/**` snapshot module because the thing it
 * projects — `ManagedAgent` + its catalog — is owned here, and `agent-session` is a host layer a
 * manager must not import (`validate-layer-boundaries` captures that edge as a runtime value
 * import). The session snapshot and the retained channel both call it, so the two can never
 * disagree about what a row contains.
 */

import { readTaskRunPhase } from "./task-run-state.js";

import type { ManagedAgent } from "../../managers/managed-agent.js";
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
      ...(description ? { description } : {}),
      ...(child.parentTaskId ? { parentTaskToolCallId: child.parentTaskId } : {}),
      usage,
    };
  });
}
