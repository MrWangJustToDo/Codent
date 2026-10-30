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
 * WHO SHOWS IT is the host's call, and it is declared rather than guessed (`printsExitReport`): a
 * host that prints the report itself after releasing the renderer gets the lines through
 * `adapter.exit` and nothing in the frame; every other host gets the `ExitSummary` row painted while
 * its teardown runs. Painting AND printing is not a harmless redundancy — the last frame survives the
 * unmount, so the user would read the same block twice.
 */
export function exitWithSummary(options: {
  adapter: AgentAdapter;
  session: AgentSession | null;
  destroySession: (sessionId: string) => void;
}): void {
  const { adapter, session, destroySession } = options;

  const lines = session ? buildLinesFromSession(session) : null;
  // One owner per report: a host that prints it after tearing the UI down must not also get it
  // painted into the last frame, or the block appears twice (the frame outlives the unmount).
  useAgent.getActions().beginExit(adapter.printsExitReport ? null : lines);

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
