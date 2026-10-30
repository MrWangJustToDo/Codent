/**
 * Age-based retention for the persisted agent timeline (`.agents/logs`).
 *
 * The log sink already bounds ONE file (rotation: `5 MiB × 5`). Nothing bounded the *directory*:
 * every session keeps `agent.log*`, and every subagent gets its own file in the same directory with
 * a fresh quota, so a long-lived workspace grew without limit — the only agent artifact with no
 * retention rule (sessions and media are user data; the caches have a table).
 *
 * Same walker as the caches (`createStaleFileSweeper`), with one difference: the session directory
 * is the unit. Files live one level down, and a directory left empty is removed with them.
 *
 * Age, not reference, because the reference set (session transcripts) is permanent — a log has no
 * "still referenced" predicate. An actively-written file is never a candidate: its mtime moves on
 * every flush, so only conversations that have been idle for the whole window are collected.
 */

// The sink builds its directory from this same constant (`persistence/types.ts`). A second literal
// here would make the sweeper guard a path the writer never used, silently disabling retention.
import { AGENT_LOG_DIR } from "../persistence/types.js";
import { createStaleFileSweeper } from "../tools/shared/cache/stale-sweep.js";

import type { ResolvedCoreEnv } from "../../env";
import type { StaleSweepOptions } from "../tools/shared/cache/stale-sweep.js";

/** Session log root (`<sessionId>/agent.log*`) — re-exported so `dev` keeps one import site. */
export { AGENT_LOG_DIR };

/**
 * How long an idle session's timeline is kept.
 *
 * Fourteen days is long enough to investigate "what happened last week" and short enough that the
 * directory stops being the workspace's largest ignored artifact. The persisted session itself is
 * NOT touched — only the derived timeline.
 */
export const LOG_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

const LOG_SWEEPER = createStaleFileSweeper({
  dir: AGENT_LOG_DIR,
  suffix: ".log",
  maxAgeMs: LOG_MAX_AGE_MS,
  nested: true,
});

/**
 * Remove timelines older than {@link LOG_MAX_AGE_MS}. Runs at most once per workspace root per
 * process (the sink calls it on creation), best-effort, never throwing.
 *
 * @param keepDir The session directory a live sink is appending to — never reaped.
 */
export function sweepAgentLogs(env: ResolvedCoreEnv, options?: StaleSweepOptions): Promise<number> {
  return LOG_SWEEPER.sweep(env, options);
}

/** Test-only escape hatch for the once-per-process guard. */
export function resetAgentLogSweep(): void {
  LOG_SWEEPER.reset();
}
