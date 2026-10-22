import { useDiffFileCache } from "../hooks/use-diff-file-cache.js";

import { clearFlatMessageCache } from "./message-flat-cache.js";

/**
 * Drop caches whose entries belong to the conversation being left.
 *
 * `clearFlatMessageCache` owns the flat-row/static-snapshot caches (message identity keeps those
 * safe, but retaining them across a switch is pure memory), and the diff cache holds full file
 * contents from edits in the old transcript. A new session or a `session.resume` switches the
 * conversation under the same agent, so both must be dropped even though the session handle does
 * not change.
 */
export function clearSessionScopedCaches(): void {
  useDiffFileCache.getActions().clear();
  clearFlatMessageCache();
}
