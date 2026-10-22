/**
 * Parent-side mirror of a subagent's lifecycle.
 *
 * Subagent telemetry already exists (`subagent:created` / `started` / `completed` /
 * `error`), but the log bridge scopes every entry by `event.agentId` — so a `task`
 * call's children land only in their **own** `subagent_<id>.log`, never in the parent's.
 * Reconstructing "which subagent belongs to which call" therefore meant opening each
 * child file and matching timestamps, which is not something a reader can do at all when
 * the parent log is 6,436 lines (the session this came from).
 *
 * This writes the mirror into the parent's own file: one line per phase, carrying the
 * `task` tool call id and the subagent id. The pairing becomes greppable from either
 * side instead of being inferred.
 *
 * It is a **direct write, not a second bus event**. The event already exists and already
 * has exactly one destination; "log this in my file" is not a fact other consumers
 * should react to, and a second event would re-introduce the double-delivery the
 * `agentId` scoping deliberately prevents. A subagent also has no extension runner, so
 * the mirror has to be driven from the run side regardless.
 *
 * Levels follow the same rule as the status policy: the pump's bookkeeping is `debug`,
 * the outcome a reader scans for is `info`. So a spawned child is `debug` (the child's
 * own file carries the detail) while a *stopped* child — the one an operator actually
 * looks for, and whose reason is the whole point — is `info`.
 */

import type { AgentLog } from "../agent-log";
import type { LogLevel } from "../agent-log/types.js";
import type { SubagentStopReason } from "../subagent/subagent-stop-reason.js";

/** What the parent needs to attribute a subagent lifecycle line to its call. */
export interface SubagentLogDetails {
  subagentId: string;
  /** The parent `task` tool call, when the subagent serves one (absent for internal workers). */
  parentTaskToolCallId?: string;
  description?: string;
  iterations?: number;
  maxIterations?: number;
  durationMs?: number;
  /** Set for the `stopped` phase — why an aborted run stopped. */
  stopReason?: SubagentStopReason;
  /** The child's own full timeline file, so the parent index is navigable. */
  childLogPath?: string;
  /** Set for the `phase` entry (summary / limit). */
  taskPhase?: "summary" | "limit";
  /** Terminal fault, so a parent index can distinguish a failure from a cancel. */
  error?: string;
  /** Completion usage, so the parent index carries the same statistics the child result reports. */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    billedInputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

export type SubagentLifecyclePhase = "created" | "started" | "phase" | "completed" | "stopped";

/** `subagent <id> [task <callId>]` — the attribution every line carries. */
function attribute(details: SubagentLogDetails): string {
  return details.parentTaskToolCallId
    ? `subagent ${details.subagentId} [task ${details.parentTaskToolCallId}]`
    : `subagent ${details.subagentId}`;
}

/** Build the mirror line. Exported so its wording is assertable without a sink. */
export function subagentLifecycleLogLine(
  phase: SubagentLifecyclePhase,
  details: SubagentLogDetails
): { level: LogLevel; message: string } {
  switch (phase) {
    case "created":
      return { level: "debug", message: `Subagent created: ${attribute(details)}` };
    case "started":
      return {
        level: "debug",
        message: `Subagent started: ${details.description ?? details.subagentId} — ${attribute(details)}`,
      };
    case "phase":
      return {
        level: "debug",
        message: `Subagent phase ${details.taskPhase ?? "unknown"}: ${attribute(details)}`,
      };
    case "completed":
      return {
        level: "info",
        message: `Subagent completed: ${attribute(details)} (${details.iterations ?? 0}/${details.maxIterations ?? 0} iterations, ${details.durationMs ?? 0}ms)`,
      };
    case "stopped":
      // The reason is the point, so the message names it rather than saying "cancelled":
      // a discarded run's orphan is not a user cancel, and this line is where that shows.
      return {
        level: details.error ? "error" : "info",
        message: `Subagent ${details.stopReason ?? "stopped"}: ${attribute(details)}`,
      };
  }
}

/** Write the mirror into the parent agent's log. No-op when the parent has no log. */
export function logSubagentLifecycle(
  log: AgentLog | null | undefined,
  phase: SubagentLifecyclePhase,
  details: SubagentLogDetails
): void {
  if (!log) return;
  const { level, message } = subagentLifecycleLogLine(phase, details);
  // Parent side is an INDEX: the child's own file is the full timeline. Mark the copy so a
  // reader (and the validator) can tell an index record from a duplicated child entry.
  const data: Record<string, unknown> = {
    indexOnly: true,
    subagentId: details.subagentId,
    phase,
    ...(details.parentTaskToolCallId ? { parentTaskToolCallId: details.parentTaskToolCallId } : {}),
    ...(details.description ? { description: details.description } : {}),
    ...(details.iterations !== undefined ? { iterations: details.iterations } : {}),
    ...(details.maxIterations !== undefined ? { maxIterations: details.maxIterations } : {}),
    ...(details.durationMs !== undefined ? { durationMs: details.durationMs } : {}),
    ...(details.stopReason ? { stopReason: details.stopReason } : {}),
    ...(details.childLogPath ? { childLogPath: details.childLogPath } : {}),
    ...(details.taskPhase ? { taskPhase: details.taskPhase } : {}),
    ...(details.error ? { error: details.error } : {}),
    ...(details.usage ? { usage: details.usage } : {}),
  };
  switch (level) {
    case "debug":
      log.debug("system", message, data);
      return;
    case "warn":
      log.warn("system", message, data);
      return;
    case "error":
      log.error("system", message, undefined, data);
      return;
    default:
      log.info("system", message, data);
  }
}
