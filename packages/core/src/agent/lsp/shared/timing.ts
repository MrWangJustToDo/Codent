/** LSP extension timing constants. */

/** How long to wait after a write/edit for the LSP to publish updated diagnostics. */
export const DIAGNOSTIC_SETTLE_DELAY_MS = 1500;

/**
 * How long the explicit `lsp_diagnostics` tool waits for a lazily-started
 * server to become ready before giving up. Write/edit auto-injection never
 * waits on a cold start — it pre-warms the server in the background instead.
 */
export const AUTO_DIAG_SERVER_WAIT_MS = 15000;

/**
 * How long a write/edit waits for a cold server before deferring the sync.
 * A lazy start can take minutes (Java indexing), which must not stall the tool
 * result — files that miss this window are synced as soon as the server reports
 * ready (see `FileSync.flushPendingSync`).
 */
export const FIRST_SYNC_WAIT_MS = 3000;

/**
 * Upper bound for how long auto-diagnostics polls after a write/edit for the
 * server to publish diagnostics. Polling exits as soon as a publish arrives,
 * which also covers clean files (servers publish an empty list), so this bound
 * is only reached by slow or unresponsive servers.
 */
export const AUTO_DIAG_SETTLE_TIMEOUT_MS = 8000;

/** Poll interval when waiting for diagnostics to appear after a write/edit. */
export const AUTO_DIAG_SETTLE_POLL_MS = 300;

/** Server restart: initial backoff, max backoff, max attempts per session. */
export const RESTART_INITIAL_BACKOFF_MS = 1000;
export const RESTART_MAX_BACKOFF_MS = 30000;
export const RESTART_MAX_ATTEMPTS = 3;

/** Delay after synthetic didChange before requesting member completions. */
export const SYNTHETIC_DOT_SETTLE_DELAY_MS = 100;
