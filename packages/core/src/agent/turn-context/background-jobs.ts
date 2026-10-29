/**
 * `<background_jobs>` turn-context section — the durable POINTER to this session's background
 * command jobs.
 *
 * A completion notification is one-shot: after a later compaction puts it in the compressed
 * prefix, the model can no longer see the job id or log path, even though the job record/log
 * are durable. This section is the **safety net** for exactly that: it lists the jobs the wire
 * does not already announce, so the model can rediscover the id and read the output. It stays
 * metadata-only — no stdout/stderr — and only covers jobs whose `run_command` tool call is still
 * in the model-visible wire (once the call is gone, re-listing the job is noise).
 */

import { extractTextFromContent } from "../../utils/message-content.js";
import { truncateText } from "../../utils/text-truncation.js";
import { COMMAND_JOB_LOG_DIR } from "../tools/builtin/shell/jobs/output-log.js";
import { BUILTIN_TOOL_NAMES } from "../tools/catalog/tool-names.js";

import {
  TURN_CONTEXT_KINDS,
  extractContextSection,
  formatSectionTag,
  isContextModelMessage,
} from "./turn-context-message.js";

import type { ModelMessage } from "@tanstack/ai";

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
      if (call.function?.name === BUILTIN_TOOL_NAMES.runCommand) ids.add(call.id);
    }
  }
  return ids;
}

/**
 * Job ids this wire already announces through a `background_notification` block.
 *
 * This is what makes the pointer a safety net instead of a duplicate: a job whose result is
 * still visible (the notification carries the output tail) does not need to be listed, and a
 * job whose notification was summarized away is listed again. The ids ride in a shell attr
 * (`jobs="a,b"`), not in prose, so recovery never parses the notification text.
 */
export function collectAnnouncedJobIds(messages: readonly ModelMessage[]): Set<string> {
  const announced = new Set<string>();
  for (const message of messages) {
    if (!message || !isContextModelMessage(message)) continue;
    const section = extractContextSection(extractTextFromContent(message.content));
    if (!section || section.key !== TURN_CONTEXT_KINDS.backgroundNotification) continue;
    for (const id of (section.attrs?.jobs ?? "").split(/[,\s]+/)) {
      if (id) announced.add(id);
    }
  }
  return announced;
}

const MAX_JOBS = 5;
const MAX_COMMAND_CHARS = 120;

function oneLine(command: string): string {
  const flattened = command.replace(/\s+/g, " ").trim();
  return truncateText(flattened, MAX_COMMAND_CHARS, { marker: "…" });
}

/** Render the section, or `undefined` when the session has no jobs. */
export function formatBackgroundJobsSection(jobs: readonly BackgroundJobContextRow[]): string | undefined {
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
    lines.push(`- … ${ordered.length - shown.length} more job(s); see ${COMMAND_JOB_LOG_DIR}/`);
  }
  // No generation/epoch attribute: the section is admitted by content like every other kind,
  // against the post-compaction wire, so a cut that removed it re-admits it and a surviving copy
  // suppresses it. An in-memory counter would make the content differ after every restart.
  return formatSectionTag(TURN_CONTEXT_KINDS.backgroundJobs, [
    "Background command jobs in this session. This list is re-injected after compaction. " +
      "Read output with get_command_output(jobId) or read_file(logPath); output is not repeated here.",
    ...lines,
  ]);
}
