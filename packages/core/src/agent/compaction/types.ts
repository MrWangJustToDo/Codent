/**
 * Compaction Types - Type definitions for the context compaction system.
 *
 * - Layer 1 (tool_compact): `toModelOutput` transforms (cached per toolCallId)
 * - Layer 2 (auto_compact): LLM-based summarization when threshold exceeded
 * Manual compaction: CLI `/compact` (same engine as auto_compact)
 */

import { z } from "zod";

// ============================================================================
// Defaults (single source of truth)
// ============================================================================

/**
 * Canonical defaults for the compaction configuration — the single source of
 * truth. Referenced by the schema `.default()` values and by
 * {@link DEFAULT_COMPACTION_CONFIG}; change them here and both stay in sync.
 */
export const COMPACTION_CONFIG_DEFAULTS = {
  tokenThreshold: 100000,
  compactAtPercent: 80,
} as const;

// ============================================================================
// Zod Schemas
// ============================================================================

/**
 * Schema for compaction configuration.
 */
export const compactionConfigSchema = z.object({
  /** Token threshold (context window size) for auto-compaction (default: 100000) */
  tokenThreshold: z.number().int().positive().default(COMPACTION_CONFIG_DEFAULTS.tokenThreshold),
  /** Percentage of tokenThreshold at which compaction triggers (default: 80) */
  compactAtPercent: z.number().min(50).max(99).default(COMPACTION_CONFIG_DEFAULTS.compactAtPercent),
  /**
   * Token budget for the kept window after compaction. When set, it wins;
   * when unset, derived from the model context window (or the shared default
   * window when unknown — see keep-policy.ts).
   */
  keepRecentTokens: z.number().int().positive().optional(),
  /** Tokens reserved for summary + next turn when deriving keep budget. Default is `DEFAULT_RESERVE_TOKENS` (keep-policy.ts). */
  reserveTokens: z.number().int().positive().optional(),
});

/**
 * Schema for compaction result.
 */
export const compactionResultSchema = z.object({
  /** Whether compaction was performed */
  compacted: z.boolean(),
  /** Estimated tokens before compaction */
  tokensBefore: z.number().int().nonnegative(),
  /** Estimated tokens after compaction */
  tokensAfter: z.number().int().nonnegative(),
  /** Type of compaction performed */
  type: z.enum(["micro", "auto", "manual", "reactive"]).optional(),
  /** Summary generated if auto/manual/reactive compaction */
  summary: z.string().optional(),
  /** Index in the input messages where the kept portion starts (messages before this were summarized) */
  cutIndex: z.number().int().nonnegative().optional(),
  /** Error message if compaction failed */
  error: z.string().optional(),
  /**
   * True when the summarizer was aborted by the user (Esc). Not a failure: the middleware must
   * not arm its retry backoff or emit an error event for a cancel.
   */
  aborted: z.boolean().optional(),
});

// ============================================================================
// Types
// ============================================================================

/**
 * Compaction configuration options.
 */
export type CompactionConfig = z.infer<typeof compactionConfigSchema>;

/**
 * Input type for partial compaction config (all fields optional).
 */
export type CompactionConfigInput = z.input<typeof compactionConfigSchema>;

/**
 * Result of a compaction operation.
 */
export type CompactionResult = z.infer<typeof compactionResultSchema>;

// ============================================================================
// Resolved defaults & factory
// ============================================================================

/**
 * Default compaction configuration values, derived from
 * {@link COMPACTION_CONFIG_DEFAULTS} (never written independently).
 */
export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = { ...COMPACTION_CONFIG_DEFAULTS };

/**
 * Create a compaction config with defaults applied.
 *
 * @param input - Partial configuration to merge with defaults
 * @returns Complete compaction configuration
 *
 * @example
 * ```typescript
 * const config = createCompactionConfig({ tokenThreshold: 50000 });
 * // Result: { tokenThreshold: 50000, compactAtPercent: 80 }
 * ```
 */
export function createCompactionConfig(input?: CompactionConfigInput): CompactionConfig {
  return compactionConfigSchema.parse(input ?? {});
}
