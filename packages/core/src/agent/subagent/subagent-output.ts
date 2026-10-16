/**
 * Subagent output truncation / stop-notice utilities.
 */

import { subagentStopNotice, SUBAGENT_STOP_NOTICES, type SubagentStopReason } from "./subagent-stop-reason.js";
import { SUBAGENT_DEFAULT_MAX_OUTPUT_LENGTH } from "./types.js";

const EMPTY_SUMMARY = "(no summary)";

/**
 * Truncates summary to max length with notice.
 */
export const truncateSummary = (
  summary: string,
  maxLength: number = SUBAGENT_DEFAULT_MAX_OUTPUT_LENGTH
): { summary: string; truncated: boolean } => {
  if (summary.length <= maxLength) {
    return { summary, truncated: false };
  }

  const truncated = summary.slice(0, maxLength);
  const notice = `\n\n[Summary truncated at ${maxLength} characters]`;

  return {
    summary: truncated + notice,
    truncated: true,
  };
};

/**
 * Prefix for a failed run's summary — the sibling of `SUBAGENT_STOP_NOTICES`.
 *
 * Exported so a consumer can recognize the class without re-spelling it, exactly like the
 * stop notices.
 */
export const SUBAGENT_FAILURE_NOTICE_PREFIX = "⚠️ Task failed:";

/**
 * Prefix a FAILED run's summary with the fault, keeping whatever partial work exists.
 *
 * The sibling of {@link applySubagentStopNotice} for the other terminal case: a stop names
 * *who* ended the run, a failure names *why* it died. Both exist for the same reason — the
 * text reaches the parent model's context, so it must not be mistakable for a finished
 * result. That matters most when the partial work is ordinary narration ("let me check…"):
 * without the prefix it reads as a conclusion.
 */
export function applySubagentFailureNotice(summary: string, errorMessage?: string): string {
  const notice = `${SUBAGENT_FAILURE_NOTICE_PREFIX} ${errorMessage ?? "unknown error"}`;
  const trimmed = summary.trim();
  if (!trimmed || trimmed === EMPTY_SUMMARY) return notice;
  return `${notice}\n\n${trimmed}`;
}

/**
 * Ensure a stopped run surfaces a clear notice in the summary text returned to
 * the parent (UI + `toModelOutput`), not only an `aborted` flag.
 *
 * The notice names the *reason* (user cancel, parent run moved on, parent agent
 * stopped) instead of assuming the user did it — see `subagent-stop-reason.ts`.
 */
export function applySubagentStopNotice(summary: string, reason: SubagentStopReason): string {
  const noticed = subagentStopNotice(reason);
  const trimmed = summary.trim();
  if (!trimmed || trimmed === EMPTY_SUMMARY) {
    return noticed;
  }
  // Any stop notice already in the text is the same class of message; do not stack them.
  if (SUBAGENT_STOP_NOTICES.some((notice) => trimmed.includes(notice))) return summary;
  return `${trimmed}\n\n${noticed}`;
}
