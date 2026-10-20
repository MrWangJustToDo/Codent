/**
 * Keep policy resolution for compaction.
 *
 * The kept window after compaction is decided by a token budget
 * (`keepRecentTokens`) instead of a fixed count of user turns. When the budget
 * is not explicitly configured and the model's context window is known, it is
 * derived as a bounded fraction of that window; when no context window is
 * known, it is derived from the shared default window
 * ({@link DEFAULT_SUMMARIZATION_CONTEXT_WINDOW}) so the token-budget path is
 * always used (never legacy user-turn counting).
 */

import { DEFAULT_SUMMARIZATION_CONTEXT_WINDOW } from "./summarization-budget.js";
import { createCompactionConfig } from "./types.js";

import type { CompactionConfig } from "./types.js";

// ============================================================================
// Constants
// ============================================================================

/** Fraction of the model context window kept after compaction (opencode-style). */
export const KEEP_RECENT_WINDOW_RATIO = 0.25;

/** Cap on the derive-reserve as a fraction of the window (reserve never exceeds this). */
export const RESERVE_WINDOW_CAP_RATIO = 0.25;

/** Upper bound for the derived keep budget. */
export const KEEP_RECENT_WINDOW_CAP = 64_000;

/** Lower bound so tiny-window models still retain a usable working set. */
export const KEEP_RECENT_WINDOW_MIN = 4_000;

/** Tokens reserved for the summary + next turn when deriving thresholds. */
export const DEFAULT_RESERVE_TOKENS = 16_384;

// ============================================================================
// Types
// ============================================================================

/**
 * Resolved keep policy for one agent.
 *
 * Always token-budget based (`tokens`): keep the most recent messages whose
 * estimated tokens fit in {@link KeepPolicy.keepRecentTokens} (pairing-safe
 * boundaries). The budget is either an explicit config value, derived from the
 * model context window, or derived from the shared default window when the
 * window is unknown.
 */
export interface KeepPolicy {
  kind: "tokens";
  keepRecentTokens: number;
}

// ============================================================================
// Public API
// ============================================================================

/** Effective reserve tokens for window-relative derivation. */
export function resolveReserveTokens(config?: Partial<CompactionConfig>): number {
  return config?.reserveTokens ?? DEFAULT_RESERVE_TOKENS;
}

/**
 * Clamp the reserve to a fraction of the context window. A fixed reserve
 * larger than ~25% of a small window would push the trigger point into
 * constant-compaction territory (or below zero usable space).
 */
function effectiveReserveTokens(reserveTokens: number, contextWindow: number): number {
  const cap = Math.max(1, Math.floor(contextWindow * RESERVE_WINDOW_CAP_RATIO));
  return Math.min(Math.max(0, reserveTokens), cap);
}

/**
 * Derive a keep budget from the model context window.
 */
export function deriveKeepRecentTokens(contextWindow: number, reserveTokens = DEFAULT_RESERVE_TOKENS): number {
  const usable = Math.max(0, contextWindow - effectiveReserveTokens(reserveTokens, contextWindow));
  if (usable <= 0) return KEEP_RECENT_WINDOW_MIN;
  return Math.min(
    KEEP_RECENT_WINDOW_CAP,
    Math.max(KEEP_RECENT_WINDOW_MIN, Math.floor(usable * KEEP_RECENT_WINDOW_RATIO))
  );
}

/**
 * Resolve the keep policy for an agent.
 *
 * Priority: explicit `keepRecentTokens` > derived from the model context window
 * > derived from the shared default window (when the window is unknown). The
 * result is always token-budget based — never legacy user-turn counting — so a
 * conversation dominated by few (but large) turns can always be cut on token
 * budget rather than bailing out for not having enough turns.
 *
 * @param config - Compaction config (partial; defaults applied where relevant)
 * @param contextWindow - Model input context window in tokens, if known
 */
export function resolveKeepPolicy(
  config: Partial<CompactionConfig> | null | undefined,
  contextWindow?: number
): KeepPolicy {
  const resolved = createCompactionConfig(config ?? undefined);
  const explicit = resolved.keepRecentTokens;
  const contextBudget = contextWindow && contextWindow > 0 ? contextWindow : DEFAULT_SUMMARIZATION_CONTEXT_WINDOW;
  return {
    kind: "tokens",
    keepRecentTokens:
      explicit && explicit > 0 ? explicit : deriveKeepRecentTokens(contextBudget, resolveReserveTokens(resolved)),
  };
}

/**
 * Projection options payload derived from a keep policy — spread into
 * `getModelVisibleMessages` / `applyCompactionResult` options.
 */
export function keepPolicyProjectionOptions(policy: KeepPolicy): {
  keepRecentTokens: number;
} {
  return { keepRecentTokens: policy.keepRecentTokens };
}

/**
 * Resolve the absolute token count at which auto-compaction triggers.
 *
 * The trigger base is the **working budget** (`tokenThreshold`) — the same
 * number the UI shows as 100%. The agent factory auto-fills it as
 * `min(contextWindow, MAX_THRESHOLD)` when unset, so a huge models.dev window
 * (e.g. 1M) never defers compaction past the displayed budget; the threshold
 * is still clamped to the real window so an oversized config cannot defer
 * compaction past what the model accepts.
 *
 * @returns absolute trigger point in input tokens
 */
export function resolveAutoCompactTrigger(
  config: Partial<CompactionConfig>,
  contextWindow?: number
): { triggerAt: number } {
  const resolved = createCompactionConfig(config);
  const limit =
    contextWindow && contextWindow > 0 ? Math.min(resolved.tokenThreshold, contextWindow) : resolved.tokenThreshold;
  return { triggerAt: Math.floor((limit * resolved.compactAtPercent) / 100) };
}
