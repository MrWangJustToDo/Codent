import { useAgent } from "../hooks/use-agent.js";

import { buildExitSummaryLines } from "./exit-summary.js";

import type { AgentAdapter } from "../adapter/types.js";
import type { AgentSession } from "@codent/core";

/**
 * The one place a host leaves: capture the exit summary, tear the session down, then exit.
 *
 * All three exit entry points (`/quit`, Ctrl+C, the command context's `exit()`) used to call
 * `host.destroy(session.id)` and `adapter.exit()` themselves, which meant the summary would have
 * needed the same three-line dance in each — and a fourth entry point added later would silently
 * miss it. They now share this.
 *
 * Order matters: the lines are built **before** `destroy`. The exit summary is a reading of the
 * live session (`snap.usage`, `snap.activeSessionId`), and the destroy is what removes it; building it
 * afterwards would capture a torn-down agent. The lines are then handed to the store, where the
 * already-mounted `ExitSummary` picks them up while the host's deferred `process.exit` gives Ink
 * a frame to paint.
 */
export function exitWithSummary(options: {
  adapter: AgentAdapter;
  session: AgentSession | null;
  destroySession: (sessionId: string) => void;
}): void {
  const { adapter, session, destroySession } = options;

  const lines = session ? buildLinesFromSession(session) : null;
  useAgent.getActions().beginExit(lines);

  if (session) destroySession(session.id);
  // The host decides how the report reaches the user: normal-screen hosts paint it through the
  // store (the `ExitSummary` row), alternate-screen hosts print it after leaving the alt buffer.
  adapter.exit(lines ?? undefined);
}

/** Snapshot → summary lines, or `null` when the session has nothing to report. */
function buildLinesFromSession(session: AgentSession): string[] | null {
  const snap = session.getSnapshot();
  return buildExitSummaryLines({
    name: snap.name,
    agentId: snap.agentId,
    sessionId: snap.activeSessionId,
    model: snap.model,
    usage: snap.usage,
    todos: snap.todos,
  });
}
