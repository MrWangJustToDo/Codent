/**
 * `<background_jobs>` turn-context section — the durable POINTER to this session's background
 * command jobs.
 *
 * A completion notification is one-shot: after a later compaction puts it in the compressed
 * prefix, the model can no longer see the job id or log path, even though the job record/log
 * are durable. This section is re-admitted by the turn-context middleware after every
 * compaction (it has its own content hash), so the model can always rediscover the id and read
 * the output. It stays metadata-only — no stdout/stderr — so it is cheap and changes only when a
 * job starts or reaches a terminal state.
 */

export interface BackgroundJobContextRow {
  jobId: string;
  command: string;
  status: string;
  exitCode: number | null;
  logPath: string | null;
  startedAt: number;
}

const MAX_JOBS = 5;
const MAX_COMMAND_CHARS = 120;

function oneLine(command: string): string {
  const flattened = command.replace(/\s+/g, " ").trim();
  return flattened.length <= MAX_COMMAND_CHARS ? flattened : `${flattened.slice(0, MAX_COMMAND_CHARS - 1)}…`;
}

/** Render the section, or `undefined` when the session has no jobs. */
export function formatBackgroundJobsSection(
  jobs: readonly BackgroundJobContextRow[],
  options: { generation?: number } = {}
): string | undefined {
  if (jobs.length === 0) return undefined;
  const ordered = [...jobs].sort((a, b) => {
    const aRunning = a.status === "running" ? 0 : 1;
    const bRunning = b.status === "running" ? 0 : 1;
    if (aRunning !== bRunning) return aRunning - bRunning;
    return b.startedAt - a.startedAt;
  });
  const shown = ordered.slice(0, MAX_JOBS);
  const lines = shown.map((job) => {
    const status =
      job.status === "running" ? "running" : `${job.status}${job.exitCode !== null ? ` (exit ${job.exitCode})` : ""}`;
    const log = job.logPath ? ` — log: ${job.logPath}` : "";
    return `- ${job.jobId} — ${status}: ${oneLine(job.command)}${log}`;
  });
  if (ordered.length > shown.length) {
    lines.push(`- … ${ordered.length - shown.length} more job(s); see .agents/cache/command-jobs/`);
  }
  // `generation` bumps on every compaction. The content otherwise changes only when a job starts
  // or ends, which is not enough to re-admit after a cut that removed the previous section: the
  // compaction path resets admission, but the restore-seeding would find the old row in the
  // channel and skip. A changed generation makes the hash differ, so the section is re-injected.
  const generation = options.generation ?? 0;
  return [
    `<background_jobs generation="${generation}">`,
    "Background command jobs in this session. This list is re-injected after compaction. " +
      "Read output with get_command_output(jobId) or read_file(logPath); output is not repeated here.",
    ...lines,
    "</background_jobs>",
  ].join("\n");
}
