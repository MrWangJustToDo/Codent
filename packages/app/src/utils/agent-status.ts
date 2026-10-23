import type { AgentStatus } from "@codent/core";

/**
 * Whether the agent is actively working rather than idle, paused or waiting on the user.
 *
 * Deliberately NOT `isActiveStatus`: `waiting` (approval / soft pause) and `awaiting_user`
 * (`ask_user`) keep the session active but are waits, not work. One definition, shared by the
 * footer's status row and the workspace panel title so the two surfaces cannot drift.
 */
export function isAgentBusyStatus(status: AgentStatus): boolean {
  return status === "running" || status === "thinking" || status === "responding" || status === "compacting";
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
