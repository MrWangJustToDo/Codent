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

/** What an activity mark says: work in progress, or a pause that is asking the user for something. */
export type AgentActivityKind = "busy" | "approval" | "question";

/** A marker a view outside the chat can render for the current status. */
export interface AgentActivity {
  kind: AgentActivityKind;
  /** Lower-case label, e.g. `running` / `awaiting approval`. */
  label: string;
}

/**
 * Activity to advertise outside the chat view, or `null` when there is nothing to say.
 *
 * The workspace panel is an alternate screen, so it covers the footer — the only other place
 * agent status is rendered. That makes the WAITS part of this contract, not a footnote: `waiting`
 * is a tool call parked on approve/deny and `awaiting_user` is an `ask_user` question. Both mean
 * the agent needs the user, which is precisely when a user browsing files must not have to guess.
 * (The label used to cover the busy set only, so an agent blocked on an approval read as idle for
 * as long as the run stayed parked.)
 *
 * Terminal statuses (`completed` / `error` / `aborted`) stay silent on purpose: this bar answers
 * "is anything happening right now?", and the outcome of the last turn belongs to the footer and
 * the transcript. The switch is exhaustive with no `default`, so a new `AgentStatus` member fails
 * to compile here instead of silently rendering nothing.
 */
export function agentActivity(status: AgentStatus): AgentActivity | null {
  switch (status) {
    case "running":
      return { kind: "busy", label: "running" };
    case "thinking":
      return { kind: "busy", label: "thinking" };
    case "responding":
      return { kind: "busy", label: "responding" };
    case "compacting":
      return { kind: "busy", label: "compacting" };
    case "waiting":
      return { kind: "approval", label: "awaiting approval" };
    case "awaiting_user":
      return { kind: "question", label: "awaiting answer" };
    case "idle":
    case "completed":
    case "error":
    case "aborted":
      return null;
  }
}
