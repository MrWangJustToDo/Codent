import { isBusyStatus } from "@codent/core";

import type { AgentStatus } from "@codent/core";

/**
 * Whether the agent is actively working rather than idle, paused or waiting on the user.
 *
 * Delegates to core's derived `isBusyStatus` (not `isActiveStatus`: `waiting` / `awaiting_user`
 * keep the session active but are waits, not work). It used to be a fourth hand-written copy of the
 * same four-value subset, shared by the footer's status row and the workspace panel title.
 */
export function isAgentBusyStatus(status: AgentStatus): boolean {
  return isBusyStatus(status);
}

/** The compact label a busy state is shown as in the workspace title. */
export function agentBusyLabel(status: AgentStatus): string {
  switch (status) {
    case "running":
      return "running";
    case "thinking":
      return "thinking";
    case "responding":
      return "responding";
    case "compacting":
      return "compacting";
    default:
      return "working";
  }
}
