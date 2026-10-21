/**
 * Durable per-job records for background command jobs.
 *
 * The registry is in-memory: a process restart loses every running job and every completion
 * that has not reached the model yet. The log keeps the OUTPUT, but not the status/metadata —
 * and a completion notification is only generated on the next LLM call. This store makes the
 * job's identity, terminal status and notification state survive a restart, so a resumed
 * session can deliver what happened while it was away.
 *
 * Records live beside the logs (`.agents/cache/command-jobs/<jobId>.json`) and are scoped to the
 * owning disk session: a fork/`/clear` creates a new session id and must not inherit another
 * conversation's jobs. Logs keep the existing 24h sweep; records are smaller and keep 7 days —
 * a record whose log was swept still carries the status and the output tail.
 */

import { COMMAND_JOB_LOG_DIR } from "./command-output-log.js";
import { createStaleFileSweeper } from "./stale-file-sweep.js";

import type { CommandJobStatus } from "./command-job-registry.js";
import type { ResolvedCoreEnv } from "../../../env";

/** Bump when the record shape changes; unknown versions are ignored. */
export const COMMAND_JOB_RECORD_VERSION = 1;

/** Records are tiny; keep them longer than the (large) logs so a resume can still notify. */
export const MAX_JOB_RECORD_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface PersistedCommandJob {
  version: typeof COMMAND_JOB_RECORD_VERSION;
  jobId: string;
  command: string;
  status: CommandJobStatus;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  /** The disk session that owns this job (restore is scoped to it). */
  ownerSessionId: string;
  /** OS/runtime pid when the host exposed one; informational for recovery. */
  pid?: number;
  logPath: string | null;
  /** Head-lossy previews for the completion notification (full output stays in the log). */
  stdoutTail: string;
  stderrTail: string;
  /** Whether the completion notification has already been delivered. */
  notified: boolean;
}

/** Workspace-relative path of a job's record file. */
export function jobRecordPath(jobId: string): string {
  return `${COMMAND_JOB_LOG_DIR}/${jobId}.json`;
}

/** Keep the last `max` characters (head-lossy is fine — the log holds the full output). */
export function tailText(value: string, max = 4000): string {
  return value.length <= max ? value : value.slice(-max);
}

/** Read the records belonging to one session. Malformed/unknown records are ignored. */
export async function readCommandJobRecords(
  env: ResolvedCoreEnv,
  ownerSessionId: string
): Promise<PersistedCommandJob[]> {
  try {
    const fs = env.fs;
    if (!(await fs.exists(COMMAND_JOB_LOG_DIR))) return [];
    const entries = await fs.readdir(COMMAND_JOB_LOG_DIR);
    const records: PersistedCommandJob[] = [];
    for (const entry of entries) {
      if (!entry.name.endsWith(".json")) continue;
      try {
        const text = await fs.readFile(`${COMMAND_JOB_LOG_DIR}/${entry.name}`);
        const parsed = JSON.parse(text) as Partial<PersistedCommandJob>;
        if (
          parsed.version !== COMMAND_JOB_RECORD_VERSION ||
          typeof parsed.jobId !== "string" ||
          typeof parsed.command !== "string" ||
          typeof parsed.status !== "string" ||
          parsed.ownerSessionId !== ownerSessionId
        ) {
          continue;
        }
        records.push({
          version: COMMAND_JOB_RECORD_VERSION,
          jobId: parsed.jobId,
          command: parsed.command,
          status: parsed.status as CommandJobStatus,
          exitCode: typeof parsed.exitCode === "number" ? parsed.exitCode : null,
          startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
          endedAt: typeof parsed.endedAt === "number" ? parsed.endedAt : null,
          ownerSessionId: parsed.ownerSessionId,
          ...(typeof parsed.pid === "number" ? { pid: parsed.pid } : {}),
          logPath: typeof parsed.logPath === "string" ? parsed.logPath : null,
          stdoutTail: typeof parsed.stdoutTail === "string" ? parsed.stdoutTail : "",
          stderrTail: typeof parsed.stderrTail === "string" ? parsed.stderrTail : "",
          notified: parsed.notified === true,
        });
      } catch {
        // A torn write / unrelated file: ignore it.
      }
    }
    return records;
  } catch {
    return [];
  }
}

/** Write one record atomically when the host can rename (write a sibling, then move it in). */
export async function writeCommandJobRecord(env: ResolvedCoreEnv, record: PersistedCommandJob): Promise<void> {
  const fs = env.fs;
  const path = jobRecordPath(record.jobId);
  const json = JSON.stringify(record);
  await fs.mkdir(COMMAND_JOB_LOG_DIR);
  if (fs.rename) {
    const temp = `${path}.tmp`;
    await fs.writeFile(temp, json);
    await fs.rename(temp, path);
  } else {
    await fs.writeFile(path, json);
  }
}

/** Remove a record (job eviction / teardown). Best-effort. */
export async function removeCommandJobRecord(env: ResolvedCoreEnv, jobId: string): Promise<void> {
  try {
    const path = jobRecordPath(jobId);
    if (await env.fs.exists(path)) await env.fs.remove(path);
  } catch {
    // Nothing to clean up.
  }
}

const recordSweeper = createStaleFileSweeper({
  dir: COMMAND_JOB_LOG_DIR,
  suffix: ".json",
  maxAgeMs: MAX_JOB_RECORD_AGE_MS,
});

/** Sweep records past {@link MAX_JOB_RECORD_AGE_MS} (once per process unless forced). */
export function sweepStaleJobRecords(
  env: ResolvedCoreEnv,
  options?: { force?: boolean; now?: number }
): Promise<number> {
  return recordSweeper.sweep(env, options);
}
