/** LSP extension shared constants — limits for indexing / output. */

export { MAX_FILE_SIZE, MAX_INDEX_FILES, SKIP_DIRS } from "../../tree-sitter/constants.js";

/** Max tracked documents kept open in the LSP server (LRU). */
export const MAX_TRACKED_DOCUMENTS = 100;

/** Max lines of auto-injected diagnostics in write/edit results. */
export const MAX_AUTO_DIAGNOSTIC_LINES = 10;
