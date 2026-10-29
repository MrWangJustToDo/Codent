/**
 * One retention table for the workspace caches under `.agents/cache/`.
 *
 * Three artifacts, one rule shape — a directory, a suffix and an age, swept by the same walker
 * (`createStaleFileSweeper`): best-effort, at most once per workspace root per process, never
 * throwing. What differs is the number, because what outlives what differs:
 *
 * | artifact            | age    | why                                                                 |
 * |---------------------|--------|---------------------------------------------------------------------|
 * | `tool-output/*.txt` | 7 days | the transcript keeps naming `cachedOutputPath`, so a spill has to stay readable for as long as the session log does |
 * | `command-jobs/*.log`| 24 h   | full stdout is a debugging aid; the record below keeps status + tail, which is all a later notification needs |
 * | `command-jobs/*.json`| 7 days | identity/status/notification flag must survive a restart, so an un-notified completion is delivered exactly once |
 *
 * `sweepWorkspaceCaches(env)` runs all three, so any cache activity bounds every cache: a workspace
 * that only runs background jobs still collects old spills, and a session that only spills tool
 * output still expires job records. Before this, each trigger had to remember which of the two
 * sweepers applied (the job registry called `sweepStaleJobLogs` and `sweepStaleJobRecords`
 * separately) — a rule that lived at every call site instead of in one table.
 *
 * The reference-based collector for spilled tool output (`cleanupOrphanedToolCache`) is NOT part of
 * this table: it needs a message wire, not just a directory. Its age floor is
 * {@link TOOL_OUTPUT_ORPHAN_GRACE_MS}, which lives here because it is a retention number.
 */

import { AGENT_CACHE_DIR } from "../../../../utils/workspace-paths.js";

import { createStaleFileSweeper } from "./stale-sweep.js";

import type { StaleSweepOptions } from "./stale-sweep.js";
import type { ResolvedCoreEnv } from "../../../../env";

// ============================================================================
// Directories
// ============================================================================

/** Spilled tool results (`.txt`, one file per oversized result). */
export const TOOL_OUTPUT_CACHE_DIR = `${AGENT_CACHE_DIR}/tool-output`;

/**
 * Background command jobs: durable `.log` files and `.json` records share one directory.
 *
 * The suffix is the isolation guard, not the directory: a `.log` sweep can never eat a record and
 * vice versa, and merging the two artifact kinds later cannot turn one sweep into the other's
 * deleter.
 */
export const COMMAND_JOB_CACHE_DIR = `${AGENT_CACHE_DIR}/command-jobs`;

// ============================================================================
// Retention
// ============================================================================

/** Spilled tool output: one week (the transcript is what keeps it alive). */
export const TOOL_OUTPUT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Minimum age before the compaction reference pass may collect a spill candidate.
 *
 * Compaction shadows a message from the *wire*, not from the transcript, so the file can still be
 * read by a live turn (or through `session_search` + `read_file`). One session lost a subagent
 * report 11 minutes after it was written because the auto-compact that cut the message also
 * collected its spill. This floor keeps any live session, and any resume within a working day,
 * intact; {@link TOOL_OUTPUT_MAX_AGE_MS} remains the real reclamation path.
 */
export const TOOL_OUTPUT_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

/** Background job logs: one day (the record keeps the status/tail afterwards). */
export const MAX_JOB_LOG_AGE_MS = 24 * 60 * 60 * 1000;

/** Background job records: one week (an un-notified completion survives a restart). */
export const MAX_JOB_RECORD_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// ============================================================================
// Sweepers
// ============================================================================

export type WorkspaceCacheKind = "toolOutput" | "jobLog" | "jobRecord";

interface WorkspaceCacheSpec {
  dir: string;
  suffix: string;
  maxAgeMs: number;
}

/** The one place a cache's directory/suffix/age is decided. Exhaustive by construction. */
export const WORKSPACE_CACHE_RETENTION = {
  toolOutput: { dir: TOOL_OUTPUT_CACHE_DIR, suffix: ".txt", maxAgeMs: TOOL_OUTPUT_MAX_AGE_MS },
  jobLog: { dir: COMMAND_JOB_CACHE_DIR, suffix: ".log", maxAgeMs: MAX_JOB_LOG_AGE_MS },
  jobRecord: { dir: COMMAND_JOB_CACHE_DIR, suffix: ".json", maxAgeMs: MAX_JOB_RECORD_AGE_MS },
} as const satisfies Record<WorkspaceCacheKind, WorkspaceCacheSpec>;

const SWEEPERS = {
  toolOutput: createStaleFileSweeper(WORKSPACE_CACHE_RETENTION.toolOutput),
  jobLog: createStaleFileSweeper(WORKSPACE_CACHE_RETENTION.jobLog),
  jobRecord: createStaleFileSweeper(WORKSPACE_CACHE_RETENTION.jobRecord),
} as const satisfies Record<WorkspaceCacheKind, ReturnType<typeof createStaleFileSweeper>>;

/**
 * Sweep one cache kind. Runs at most once per workspace root per process unless `force`.
 *
 * Callers that own a specific artifact (the spill writer, the job registry) should prefer
 * {@link sweepWorkspaceCaches}: the guards make the extra kinds free, and a trigger that only knows
 * about its own cache is how the two rules drift apart again.
 */
export function sweepWorkspaceCache(
  env: ResolvedCoreEnv,
  kind: WorkspaceCacheKind,
  options?: StaleSweepOptions
): Promise<number> {
  return SWEEPERS[kind].sweep(env, options);
}

/**
 * Sweep every workspace cache. Best-effort and idempotent; returns the number of files removed.
 *
 * One `readdir`/`stat` walk per kind, once per root per process, so the cost is paid by the first
 * cache activity in the workspace rather than by a timer.
 */
export async function sweepWorkspaceCaches(
  env: ResolvedCoreEnv,
  options?: StaleSweepOptions
): Promise<{ removed: number; byKind: Record<WorkspaceCacheKind, number> }> {
  const kinds: WorkspaceCacheKind[] = ["toolOutput", "jobLog", "jobRecord"];
  const counts = await Promise.all(kinds.map((kind) => sweepWorkspaceCache(env, kind, options)));
  const byKind = Object.fromEntries(kinds.map((kind, i) => [kind, counts[i]])) as Record<WorkspaceCacheKind, number>;
  return { removed: counts.reduce((sum, n) => sum + n, 0), byKind };
}

/** Test-only escape hatch for the once-per-process guard. Omit `kind` to reset every sweeper. */
export function resetWorkspaceCacheSweeps(kind?: WorkspaceCacheKind): void {
  if (kind) {
    SWEEPERS[kind].reset();
    return;
  }
  for (const sweeper of Object.values(SWEEPERS)) sweeper.reset();
}
