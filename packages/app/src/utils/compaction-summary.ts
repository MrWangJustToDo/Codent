/**
 * Compaction summary markers and predicates — the ONE definition, re-exported from `@codent/core`.
 *
 * The markers are written by core's compaction, so the predicates that read them live there too; this
 * module exists only to keep the app's own surface stable (`@codent/app` exports these names, and the
 * transcript's views import them from `./utils/compaction-summary.js`). It used to hold a full copy —
 * both markers, three predicates and the END finder — under a "must stay in sync with @codent/core"
 * comment, which is a pair that drifts silently; the sync is now structural.
 */

export {
  CONVERSATION_SUMMARY_END,
  CONVERSATION_SUMMARY_START,
  extractCompactionSummaryBody,
  formatCompactionSummaryContent,
  hasOuterEndMarker,
  isCompactionSummaryText,
  isCompactionSummaryUIMessage,
} from "@codent/core";
