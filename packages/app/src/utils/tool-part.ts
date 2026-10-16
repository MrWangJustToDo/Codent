/**
 * Thin re-exports of the core-owned tool-part helpers, plus the app's own presentation predicates.
 *
 * The implementation moved to `@codent/core` (`agent/tools/presentation/tool-state.ts`)
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
 * successful edit rendered `⚠ edit_file will refuse this` beside an empty diff (measured: 888
 * persisted `edit_file` calls sit in `approval-responded` with no output part, and their changes are
 * in the files).
 *
 * `approval-responded` is deliberately NOT pre-execution: the approval was answered, so the write
 * may already have happened. It is the exact state that refusal was rendered from.
 */
export function isPreExecutionToolState(state: UiToolState): boolean {
  return state === "input-streaming" || state === "input-available" || state === "approval-requested";
}
