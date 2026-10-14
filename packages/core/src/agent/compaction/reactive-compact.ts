/**
 * Reactive Compact (Emergency) - Emergency compaction when API returns prompt_too_long.
 *
 * Despite the proactive layers (micro → auto), context can still grow too fast
 * for compression triggers. This emergency handler:
 *
 * 1. Uses LLM to generate a summary (via existing summarizeConversation)
 * 2. Keeps only the summary + last N messages
 *
 * The reactive compact is more aggressive than auto-compact — it retains fewer
 * tail messages and replaces everything else with a summary.
 *
 * Max retries: 1 (configurable). After that, the error propagates.
 */

import { isAbortError } from "../../runtime-types/abort.js";
import { errorMessage } from "../../utils/errors.js";

import { createCompactedMessages, summarizeConversation } from "./auto-compact.js";
import { findCutPointByBudget } from "./cut-point.js";
import { deriveKeepRecentTokens } from "./keep-policy.js";

import type { AgentManager } from "../../runtime-types/hosts.js";
import type { ModelMessage } from "@tanstack/ai";

// ============================================================================
// Constants
// ============================================================================

/** Default maximum reactive retries */
const DEFAULT_MAX_REACTIVE_RETRIES = 1;

/** Default token budget for the kept tail when no window/config is available */
const DEFAULT_REACTIVE_KEEP_TOKENS = 16_000;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if an error is a prompt_too_long error.
 */
export function isPromptTooLongError(error: unknown): boolean {
  if (!error) return false;
  const message = errorMessage(error);
  const lower = message.toLowerCase();
  return (
    lower.includes("prompt_too_long") ||
    lower.includes("too many tokens") ||
    lower.includes("max tokens exceeded") ||
    lower.includes("context length exceeded") ||
    lower.includes("too large") ||
    lower.includes("maximum context length")
  );
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Configuration for reactive compaction.
 */
export interface ReactiveCompactConfig {
  /** Maximum reactive retry attempts (default: 1) */
  maxReactiveRetries?: number;
  /** Token budget for the kept tail (overrides context-window derivation) */
  keepRecentTokens?: number;
  /** Model input context window in tokens, if known (derives the tail budget) */
  contextWindow?: number;
  /** Abort signal for the summarization subagent (cancel propagates, no fallback applied). */
  abortSignal?: AbortSignal;
}

/**
 * Resolve the tail token budget and split `messages` into summary + kept
 * portions at a pairing-safe boundary.
 *
 * The cut never orphans a tool result from its tool call. Because this is an
 * emergency path, progress is guaranteed: when the whole input fits the budget
 * (cut index 0), the cut degrades to the latest valid boundary so at least one
 * message gets summarized.
 */
function selectReactiveTail(
  messages: ModelMessage[],
  config: ReactiveCompactConfig
): { summaryMessages: ModelMessage[]; tailMessages: ModelMessage[] } {
  const budget =
    config.keepRecentTokens && config.keepRecentTokens > 0
      ? config.keepRecentTokens
      : config.contextWindow && config.contextWindow > 0
        ? deriveKeepRecentTokens(config.contextWindow)
        : DEFAULT_REACTIVE_KEEP_TOKENS;

  let cutIndex = findCutPointByBudget(messages, budget).cutIndex;
  if (cutIndex <= 0) {
    // Whole input fits the budget, but a prompt_too_long error means we must
    // shrink anyway — fall back to keeping only the latest valid boundary.
    for (let i = messages.length - 1; i >= 1; i--) {
      const message = messages[i]!;
      if (message.role !== "user" && message.role !== "assistant") continue;
      cutIndex = i;
      break;
    }
  }

  return {
    summaryMessages: messages.slice(0, cutIndex),
    tailMessages: messages.slice(cutIndex),
  };
}

/**
 * Perform reactive compaction — emergency compression triggered when the
 * API returns a prompt_too_long error despite the proactive layers.
 *
 * Steps:
 * 1. Summarize the conversation using the LLM (via summarizeConversation)
 * 2. Keep only the summary + a token-budgeted tail (pairing-safe boundary)
 *
 * Session recovery is handled by the session store (JSONL), so no separate
 * transcript is needed — the session already captures full history.
 *
 * @param messages - Current messages that caused the prompt_too_long error
 * @param parentAgentId - Parent agent ID for spawning summarization subagent
 * @param compactionConfig - Regular compaction config (passed to summarizer)
 * @param config - Reactive-specific options (tail budget, context window)
 * @returns Compacted messages array (summary + tail)
 *
 * @example
 * ```typescript
 * const compacted = await reactiveCompact(messages, "agent-123", manager);
 * // Returns: [summary-message, ...recent-messages]
 * ```
 */
export async function reactiveCompact(
  messages: ModelMessage[],
  parentAgentId: string,
  manager: AgentManager,
  config: ReactiveCompactConfig = {}
): Promise<ModelMessage[]> {
  if (messages.length === 0) return messages;

  // Split into summary portion and pairing-safe token-budgeted tail
  const { summaryMessages, tailMessages } = selectReactiveTail(messages, config);
  if (summaryMessages.length === 0) return messages;

  let summary: string;

  try {
    // Generate LLM summary of the older portion; pass tail as still_in_context for alignment.
    summary = await summarizeConversation(summaryMessages, parentAgentId, manager, {
      focus: "Emergency compaction — preserve all critical information for continuing work",
      stillInContext: tailMessages,
      ...(config.abortSignal ? { abortSignal: config.abortSignal } : {}),
    });
  } catch (error) {
    // A cancelled run must not fall back to a placeholder compaction checkpoint
    // (that would still mutate the channel after the user aborted).
    if (isAbortError(error, config.abortSignal)) {
      throw error;
    }
    // If summarization fails, use a simple fallback so the session isn't lost
    summary = `[Emergency reactive compaction performed. ${summaryMessages.length} messages summarized. Full history is preserved in session storage. Please read relevant files to re-establish detailed context.]`;
  }

  // Build compacted messages: summary + recent tail
  const compacted = createCompactedMessages(`[Reactive Compact]\n\n${summary}`);

  return [...compacted, ...tailMessages];
}

/**
 * Maximum reactive retry attempts.
 * Defaults to 1 — if the first retry also fails, the error propagates.
 */
export function getMaxReactiveRetries(config?: ReactiveCompactConfig): number {
  return config?.maxReactiveRetries ?? DEFAULT_MAX_REACTIVE_RETRIES;
}
