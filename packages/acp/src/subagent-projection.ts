/**
 * Projection of core's `subagents` rows onto ACP's experimental subagent updates.
 *
 * Core already derives everything this needs (`AgentSessionSubagentSummary`): the child id, the
 * work status, the task phase, and — for a delegation — `parentTaskToolCallId`. The ACP protocol
 * surface (`subagent_update` + `StateUpdate`) is UNSTABLE, so the whole translation lives here and
 * the rest of the host consumes {@link SubagentProjection} rather than the SDK types.
 *
 * Two rules from the change spec are enforced here, not at the call sites:
 *
 * - only **user-visible** delegations are announced (`isUserVisibleTaskRow`): the `subagents` list
 *   also carries internal workers (compaction / memory summarizers), which are implementation
 *   details of the parent and must not leak as child sessions;
 * - `taskPhase` travels in `_meta`, never as `state`: `limit` is a task outcome while the child's
 *   own status is already `completed`, and `summary` is the parent-owned side-LLM writing a report.
 */

import { isUserVisibleTaskRow } from "@codent/core";

import type { StateUpdate, SubagentProjection } from "./types.js";
import type { SubagentUpdate } from "@agentclientprotocol/sdk";
import type { AgentSessionSubagentSummary } from "@codent/core";

/** The union member the projector publishes. */
type SubagentUpdateMessage = SubagentUpdate & { sessionUpdate: "subagent_update" };

type SubagentStatus = AgentSessionSubagentSummary["status"];

/**
 * `AgentStatus` → ACP work state.
 *
 * `waiting` / `awaiting_user` map to `requires_action` even though a subagent currently has neither
 * approvals nor `ask_user`: the mapping must be total, and a future client-visible interaction would
 * otherwise silently report "running".
 */
export function stateForStatus(status: SubagentStatus): StateUpdate {
  switch (status) {
    case "running":
    case "thinking":
    case "responding":
    case "compacting":
      return { state: "running" };
    case "waiting":
    case "awaiting_user":
      return { state: "requires_action" };
    case "completed":
      return { state: "idle", stopReason: "end_turn" };
    case "aborted":
      return { state: "idle", stopReason: "cancelled" };
    case "error":
      return { state: "idle", stopReason: "error" };
    case "idle":
    default:
      return { state: "idle" };
  }
}

/**
 * One row → one projection, or `undefined` for a row the client must not see.
 *
 * `taskPrompt` is only a title fallback for a delegation whose description/name are empty; the caller
 * resolves it from the parent's task tool call when it can.
 */
export function projectSubagent(row: AgentSessionSubagentSummary, taskPrompt?: string): SubagentProjection | undefined {
  if (!isUserVisibleTaskRow(row)) return undefined;

  const description = row.description?.trim() || undefined;
  const name = row.name?.trim() || undefined;
  const fallback = taskPrompt?.trim().replace(/\s+/g, " ").slice(0, 80) || "subagent";
  return {
    sessionId: row.id,
    title: description ?? name ?? fallback,
    ...(description ? { description } : {}),
    state: stateForStatus(row.status),
    ...(row.taskPhase ? { taskPhase: row.taskPhase } : {}),
  };
}

/** The `subagent_update` for a first sighting: the announcement. */
export function announcementOf(projection: SubagentProjection): SubagentUpdateMessage {
  return {
    sessionUpdate: "subagent_update",
    sessionId: projection.sessionId,
    title: projection.title,
    ...(projection.description ? { description: projection.description } : {}),
    state: projection.state,
    ...(projection.taskPhase ? { _meta: { taskPhase: projection.taskPhase } } : {}),
  };
}

/**
 * The `subagent_update` for a changed row. Only fields that moved are sent; omitted fields keep
 * their previous value per the protocol. `null` clears a value that disappeared.
 */
export function patchOf(previous: SubagentProjection, next: SubagentProjection): SubagentUpdateMessage | undefined {
  const update: SubagentUpdateMessage = {
    sessionUpdate: "subagent_update",
    sessionId: next.sessionId,
  };
  let changed = false;

  if (previous.title !== next.title) {
    update.title = next.title;
    changed = true;
  }
  if (previous.description !== next.description) {
    update.description = next.description ?? null;
    changed = true;
  }
  if (JSON.stringify(previous.state) !== JSON.stringify(next.state)) {
    update.state = next.state;
    changed = true;
  }
  if (previous.taskPhase !== next.taskPhase) {
    update._meta = { taskPhase: next.taskPhase ?? null };
    changed = true;
  }

  return changed ? update : undefined;
}

/** Announce/patch diff over one snapshot. The returned map is the next "already announced" state. */
export function diffSubagents(
  previous: ReadonlyMap<string, SubagentProjection>,
  rows: readonly AgentSessionSubagentSummary[],
  promptOf: (toolCallId: string | undefined) => string | undefined
): {
  announce: SubagentProjection[];
  patch: Array<{ previous: SubagentProjection; next: SubagentProjection }>;
  current: Map<string, SubagentProjection>;
} {
  const current = new Map<string, SubagentProjection>();
  const announce: SubagentProjection[] = [];
  const patch: Array<{ previous: SubagentProjection; next: SubagentProjection }> = [];

  for (const row of rows) {
    const projection = projectSubagent(row, promptOf(row.parentTaskToolCallId));
    if (!projection) continue;
    current.set(projection.sessionId, projection);
    const previousProjection = previous.get(projection.sessionId);
    if (!previousProjection) announce.push(projection);
    else if (JSON.stringify(previousProjection) !== JSON.stringify(projection)) {
      patch.push({ previous: previousProjection, next: projection });
    }
  }

  return { announce, patch, current };
}
