import type { ModelToolContent } from "../../tools/runtime/contract.js";

// ============================================================================
// In-memory cache for LLM-facing compact tool output
// ============================================================================

/**
 * Bound on retained projections.
 *
 * A miss only costs one re-projection, so over-evicting is cheap; unbounded retention is not.
 * `source` is a reference to content the channel already holds (strings and arrays are shared,
 * not copied), so an entry's real cost is the projection itself, which can include base64 media.
 */
const DEFAULT_MAX_ENTRIES = 1024;

/**
 * Cheap fingerprint of a raw tool result.
 *
 * A full hash would cost as much as the parse this cache exists to avoid. The fingerprint only
 * has to make a *collision* rare; the entry's `source` is compared exactly before a hit is
 * trusted, so a near-miss costs one comparison instead of a wrong projection.
 */
function contentSignature(content: unknown): string {
  if (typeof content === "string") {
    const middle = Math.max(0, Math.floor(content.length / 2) - 16);
    return `${content.length}:${content.slice(0, 32)}:${content.slice(middle, middle + 32)}:${content.slice(-32)}`;
  }
  if (Array.isArray(content)) {
    return `a${content.length}`;
  }
  return typeof content;
}

/**
 * Key for one projection.
 *
 * The bare `toolCallId` is not unique in a session: provider ids are scoped to a REQUEST
 * (`call_0` is the common shape), so a later request can reuse one. Keying by the id alone
 * served that call the earlier call's result — the model silently read the previous turn's
 * file content. Position catches ordinary reuse; the content signature catches index reuse
 * after a compaction cut, and makes an edited result (an extension transformer) a miss
 * instead of a hit that reverts the edit.
 */
export function toolCompactCacheKey(toolCallId: string, messageIndex: number, content: unknown): string {
  return `${toolCallId}\u0000${messageIndex}\u0000${contentSignature(content)}`;
}

/** A cached projection plus the raw content it was computed from. */
export interface ToolCompactCacheEntry {
  /**
   * The raw message content the projection was built from. Compared exactly on lookup: the
   * fingerprint in the key is only a candidate filter, and serving a stale projection is a
   * silent wrong answer to the model, so a near-miss must miss.
   */
  readonly source: unknown;
  /** The model-facing content. */
  readonly projected: ModelToolContent;
}

export class ToolCompactCache {
  private readonly entries = new Map<string, ToolCompactCacheEntry>();
  private readonly maxEntries: number;

  constructor(maxEntries: number = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  get(key: string): ToolCompactCacheEntry | undefined {
    return this.entries.get(key);
  }

  set(key: string, entry: ToolCompactCacheEntry): void {
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      // Insertion order: evict the oldest projection. A cache miss re-projects, it never fails.
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, entry);
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }
}
