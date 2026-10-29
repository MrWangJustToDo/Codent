/**
 * The compaction checkpoint markers.
 *
 * A leaf on purpose: `turn-context/turn-context-message.ts` has to recognise a summary (it must not
 * report one as the user's prompt), while `compaction-summary.ts` imports `isContextUIMessage` from
 * it — importing the detector from there would close a runtime-value cycle between the two modules.
 * Neither direction owns the string, so it lives below both.
 */

export const CONVERSATION_SUMMARY_START = "[CONVERSATION SUMMARY]";
export const CONVERSATION_SUMMARY_END = "[END SUMMARY]";

/** Whether a user message's text is a compaction checkpoint (the reserved start marker). */
export function isCompactionSummaryText(text: string | undefined | null): boolean {
  if (!text) return false;
  return text.trimStart().startsWith(CONVERSATION_SUMMARY_START);
}
