/**
 * Thin re-exports of the core-owned tool-part helpers, plus the app's own presentation predicates.
 *
 * The implementation moved to `@codent/core` (`agent/tools/presentation/state.ts`)
 * so hosts that render off-process share exactly one implementation; this module keeps
 * the app's public surface stable.
 */

import type { UiToolState } from "@codent/core";

export {
  getUiToolState,
  isCancelledToolCall,
  isImagePart,
  isPendingToolApproval,
  isToolCallPart,
  isToolExecuting,
  parseToolInput,
  type UiToolState,
} from "@codent/core";

/**
 * Whether a tool call has NOT executed yet, so its effect may still be predicted.
 *
 * The distinction is load-bearing for `edit_file`: `previewEdit` resolves the edit against the
 * file as it is NOW, so predicting after the write has landed does not produce a stale diff — it
 * produces a refusal, because the `oldString` is already gone and the matcher fails. That is how a
 * successful edit rendered `⚠ edit_file will refuse this` beside an empty diff.
 *
 * The window that made it reachable is "after the write, before the part has its output": a part sits
 * in `approval-responded` with no output until the result lands, and it can stay that way — the
 * session log records exactly that progression (`approval-responded → complete` normally, `→ error`
 * when the run ends before the result arrives). The write is on disk either way, so predicting then
 * reports a refusal for work that is already done.
 *
 * Hence `approval-responded` is NOT pre-execution: the approval was answered, so the write may
 * already have happened.
 */
export function isPreExecutionToolState(state: UiToolState): boolean {
  return state === "input-streaming" || state === "input-available" || state === "approval-requested";
}
