/**
 * Age-based retention for the persisted agent timeline (`.agents/logs`).
 *
 * The sink already bounds ONE file (rotation: `5 MiB × 5`). The timeline is now a single workspace
 * file (`agent.log` plus `agent.log.N` segments) rather than a directory per session, so the
 * sweeper is flat and the retention rule is the same one the caches use.
 *
 * Age, not reference, because the reference set (session transcripts) is permanent — a log has no
 * "still referenced" predicate. An actively-written file is never a candidate: its mtime moves on
 * every flush, so only an idle window is collected.
 */

// The sink builds its directory from this same constant (`persistence/types.ts`). A second literal
// here would make the sweeper guard a path the writer never used, silently disabling retention.
import { AGENT_LOG_DIR } from "../persistence/types.js";
import { createStaleFileSweeper } from "../tools/shared/cache/stale-sweep.js";

import type { ResolvedCoreEnv } from "../../env";
import type { StaleSweepOptions } from "../tools/shared/cache/stale-sweep.js";

/** Workspace log root (`agent.log*`) — re-exported so `dev` keeps one import site. */
export { AGENT_LOG_DIR };

/**
 * How long an idle workspace timeline is kept.
 *
 * Fourteen days is long enough to investigate "what happened last week" and short enough that the
 * directory stops being the workspace's largest ignored artifact. The persisted session itself is
 * NOT touched — only the derived timeline.
 */
export const LOG_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Which entries are timeline files.
 *
 * The active file ends with `.log`; rotated segments end with `.log.N`, so the sweeper's default
 * suffix test would leave every segment behind.
 */
function isAgentLogFile(name: string): boolean {
  return name.endsWith(".log") || /\.log\.\d+$/.test(name);
}

const LOG_SWEEPER = createStaleFileSweeper({
  dir: AGENT_LOG_DIR,
  suffix: ".log",
  match: isAgentLogFile,
  maxAgeMs: LOG_MAX_AGE_MS,
  // Flat for the current model (`agent.log*`), nested so upgrades from the old per-session layout
  // (`.agents/logs/<sessionId>/agent.log*`) do not leave those directories behind forever.
  nested: true,
});

/**
 * Remove timeline files older than {@link LOG_MAX_AGE_MS}. Runs at most once per workspace root per
 * process (the sink calls it on creation), best-effort, never throwing.
 *
 * @param keepDir Optional subdirectory to leave alone (legacy nested layouts). The flat root is
 *   never skipped; an actively-written file is protected by its mtime.
 */
export function sweepAgentLogs(env: ResolvedCoreEnv, options?: StaleSweepOptions): Promise<number> {
  return LOG_SWEEPER.sweep(env, options);
}

/** Test-only escape hatch for the once-per-process guard. */
export function resetAgentLogSweep(): void {
  LOG_SWEEPER.reset();
}
