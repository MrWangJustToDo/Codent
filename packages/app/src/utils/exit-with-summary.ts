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
 * afterwards would capture a torn-down agent.
 *
 * The summary is PAINTED (`ExitSummary`, mounted by `App` above every screen), and the same lines
 * are handed to `adapter.exit` so a host whose frame cannot survive can put them on the terminal
 * itself. Painting is what gets the placement right: the host has no idea where the frame ends —
 * the cursor the renderer leaves behind is the input caret, mid-frame — so a report written there
 * overwrote the frame's own tail (the input border and the footer).
 *
 * Exactly one of the two may reach the user. A host that prints must therefore know its frame is
 * gone (the terminal hosts: they unmount, and an alternate screen discards what was painted into
 * it); the CLI host waits for this paint before it releases the renderer and prints only when the
 * painted frame did not survive — see `bootstrapCliHost`'s exit path.
 */
export function exitWithSummary(options: {
  adapter: AgentAdapter;
  session: AgentSession | null;
  destroySession: (sessionId: string) => void;
}): void {
  const { adapter, session, destroySession } = options;

  const lines = session ? buildLinesFromSession(session) : null;
  // Painted by the frame, and also carried to the host: the host prints only when that frame is
  // released without reaching the user (see the header). Both are handed the same lines, so the
  // two can never disagree about what the session did.
  useAgent.getActions().beginExit(lines);

  if (session) destroySession(session.id);
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
