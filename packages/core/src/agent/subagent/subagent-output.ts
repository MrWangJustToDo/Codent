/**
 * Subagent output truncation.
 *
 * The terminal notices (stop / failure) live with the reason vocabulary in
 * `subagent-stop-reason.ts`; this module is only about the summary's length.
 */

import { SUBAGENT_DEFAULT_MAX_OUTPUT_LENGTH } from "./types.js";

/** Sentinel output for a run with no assistant summary. */
export const EMPTY_SUMMARY = "(no summary)";

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
