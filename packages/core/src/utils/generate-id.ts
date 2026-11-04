// ============================================================================
// ID Generation Utilities
// ============================================================================

/** Process-local set of ids issued by {@link generateId} (collision avoidance). */
const issuedIds = new Set<string>();

/**
 * Cap on remembered ids.
 *
 * The set exists to catch the theoretical same-millisecond collision, so it only needs the recent
 * window — not every id a long-lived server ever minted (message, job, compact and run ids all pass
 * through here). A Set preserves insertion order, so the oldest entries are evicted first.
 */
const MAX_ISSUED_IDS = 50_000;

const MAX_GENERATE_ID_ATTEMPTS = 32;

function rememberIssuedId(id: string): void {
  issuedIds.add(id);
  if (issuedIds.size <= MAX_ISSUED_IDS) return;
  let overflow = issuedIds.size - MAX_ISSUED_IDS;
  for (const oldest of issuedIds) {
    if (overflow-- <= 0) break;
    issuedIds.delete(oldest);
  }
}

export type GenerateIdOptions = {
  /**
   * Optional external uniqueness check (e.g. agent registry).
   * Combined with the process-local issued set.
   */
  exists?: (id: string) => boolean;
};

function isIdTaken(id: string, exists?: (id: string) => boolean): boolean {
  if (issuedIds.has(id)) return true;
  return exists?.(id) === true;
}

function buildId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}_${timestamp}_${random}`;
}

/**
 * Generate a unique ID with a prefix.
 *
 * Format: `{prefix}_{timestamp}_{random}`
 *
 * Retries when the candidate collides with a previously issued id or
 * {@link GenerateIdOptions.exists}.
 *
 * @example
 * ```typescript
 * generateId("ctx");   // "ctx_m1abc123_x4y5z6"
 * generateId("log");   // "log_m1abc123_a1b2c3"
 * generateId("todo");  // "todo_m1abc123_d4e5f6"
 * generateId("subagent", { exists: (id) => manager.getAgent(id) != null });
 * ```
 */
export const generateId = (prefix: string, options?: GenerateIdOptions): string => {
  const exists = options?.exists;

  for (let attempt = 0; attempt < MAX_GENERATE_ID_ATTEMPTS; attempt++) {
    const id = buildId(prefix);
    if (isIdTaken(id, exists)) continue;
    rememberIssuedId(id);
    return id;
  }

  // Extremely unlikely: add extra entropy and accept.
  const fallback = `${buildId(prefix)}_${Math.random().toString(36).slice(2, 10)}`;
  rememberIssuedId(fallback);
  return fallback;
};

/** Test hook — clear the process-local issued-id set. */
export function resetGeneratedIdsForTesting(): void {
  issuedIds.clear();
}

/**
 * Generate a short random ID (no prefix, no timestamp).
 *
 * Useful for items within a collection where uniqueness is local.
 *
 * @example
 * ```typescript
 * generateShortId();  // "x4y5z6"
 * ```
 */
export const generateShortId = (): string => {
  return Math.random().toString(36).substring(2, 8);
};

/**
 * Create a counter-based ID generator for sequential IDs.
 *
 * Useful when ordering matters (e.g., log entries within same millisecond).
 *
 * Format: `{prefix}_{timestamp}_{counter}`
 *
 * @example
 * ```typescript
 * const generateLogId = createSequentialIdGenerator("log");
 * generateLogId();  // "log_m1abc123_0000"
 * generateLogId();  // "log_m1abc123_0001"
 * ```
 */
export const createSequentialIdGenerator = (prefix: string): (() => string) => {
  let counter = 0;
  return () => {
    const timestamp = Date.now().toString(36);
    const seq = (counter++).toString(36).padStart(4, "0");
    return `${prefix}_${timestamp}_${seq}`;
  };
};
