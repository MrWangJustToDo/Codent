/**
 * `<background_jobs>` turn-context section — the durable POINTER to this session's background
 * command jobs.
 *
 * A completion notification is one-shot: after a later compaction puts it in the compressed
 * prefix, the model can no longer see the job id or log path, even though the job record/log
 * are durable. This section is re-admitted by the turn-context middleware after every
 * compaction (it has its own content hash), so the model can rediscover the id and read the
 * output — but ONLY for jobs whose `run_command` tool call is still in the model-visible wire.
 * Once the call is compacted away, re-listing the job is noise. It stays metadata-only — no
 * stdout/stderr — so it is cheap and changes only when a job starts or reaches a terminal state.
 */

import { truncateText } from "../../utils/text-truncation.js";

export interface BackgroundJobContextRow {
  jobId: string;
  /** The `run_command` tool call that started it, so the caller can filter to the model's wire. */
  toolCallId?: string;
  command: string;
  status: string;
  exitCode: number | null;
  logPath: string | null;
  startedAt: number;
}

/** Structural view of a wire assistant tool call (TanStack `ToolCall` is assignable). */
export interface WireToolCall {
  id: string;
  function: { name: string; arguments?: string };
}
export interface WireMessage {
  role: string;
  toolCalls?: readonly WireToolCall[];
}

/**
 * The `run_command` tool-call ids still present in the model-visible wire.
 *
 * The `<background_jobs>` section is a POINTER for jobs the model can still act on. Once compaction
 * has dropped a job's `run_command` call from the wire, re-listing it is noise: the model has no
 * task that refers to it. (The one-shot completion notification is a different surface: it stays
 * self-contained and durable so session search can still find it.)
 */
export function collectRunCommandToolCallIds(messages: readonly WireMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      if (call.function?.name === "run_command") ids.add(call.id);
    }
  }
  return ids;
}

const MAX_JOBS = 5;
const MAX_COMMAND_CHARS = 120;

function oneLine(command: string): string {
  const flattened = command.replace(/\s+/g, " ").trim();
  return truncateText(flattened, MAX_COMMAND_CHARS, { marker: "…" });
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
