/**
 * Compaction Module - Context compression for infinite agent sessions.
 *
 * Implements context compaction layers:
 * - Layer 1 (tool_compact): `toModelOutput` transforms (cached per toolCallId)
 * - Layer 2 (auto_compact): LLM summarization when threshold exceeded
 * - Reactive: emergency compaction on prompt_too_long errors
 * Manual: CLI `/compact` command (optional)
 *
 * Large tool outputs at execute time use `maybeCacheOutput` (tool-output-cache) — separate from compaction.
 */

// Types and schemas
export {
  compactionConfigSchema,
  compactionResultSchema,
  type CompactionConfig,
  type CompactionConfigInput,
  type CompactionResult,
  DEFAULT_COMPACTION_CONFIG,
  createCompactionConfig,
} from "./types.js";

// Token estimation
export { estimateTokens, estimateMessageTokens } from "./token-estimator.js";

// Summarization token budget (model-metadata driven)
export {
  DEFAULT_SUMMARIZATION_CONTEXT_WINDOW,
  MIN_SUMMARIZATION_INPUT_BUDGET,
  SUMMARIZATION_OVERHEAD_TOKENS,
  SUMMARY_OUTPUT_CAP,
  resolveSummarizationBudget,
  resolveSummarizationInputBudget,
  splitMessagesByTokenBudget,
} from "./summarization-budget.js";

// Message content helpers
export { extractTextFromContent, getFirstTextPartContent } from "./message-utils.js";

// Compaction prompt
export {
  COMPACTION_PROMPT,
  UPDATE_COMPACTION_PROMPT,
  COMPACTION_SYSTEM_PROMPT,
  STILL_IN_CONTEXT_RULES,
  TURN_PREFIX_INSTRUCTION,
  buildCompactionPrompt,
  type CompactionTodoItem,
} from "./compaction-prompt.js";

// Keep policy (token-budget vs legacy turn counting)
export {
  DEFAULT_RESERVE_TOKENS,
  KEEP_RECENT_WINDOW_CAP,
  KEEP_RECENT_WINDOW_MIN,
  KEEP_RECENT_WINDOW_RATIO,
  deriveKeepRecentTokens,
  keepPolicyProjectionOptions,
  resolveAutoCompactTrigger,
  resolveKeepPolicy,
  resolveReserveTokens,
  type KeepPolicy,
} from "./keep-policy.js";

export { applyToolCompact, type ApplyToolCompactOptions } from "./tool-compact";
export { ToolCompactCache, toolCompactCacheKey } from "./tool-compact/tool-compact-cache.js";

// Message-chain projection (summary-first wire)
export {
  CONVERSATION_SUMMARY_END,
  CONVERSATION_SUMMARY_START,
  createCompactionSummaryUIMessage,
  findLatestSummaryIndex,
  formatCompactionSummaryContent,
  getModelVisibleMessages,
  isCompactionSummaryModelMessage,
  isCompactionSummaryText,
  isCompactionSummaryUIMessage,
  isLatestDurableMessageCompactionSummary,
  type GetModelVisibleMessagesOptions,
} from "./message-chain-projection.js";
export {
  assertNotCompactionSummaryInput,
  extractCompactionSummaryBody,
  hasOuterEndMarker,
} from "./compaction-summary.js";

// Wire projection cache (onConfig reuse)
export {
  WireProjectionCache,
  lastMessageContentLen,
  policyKeyFromOptions,
  wireSourceFingerprint,
  type WireProjectionCacheEntry,
} from "./wire-projection-cache.js";

// Auto compaction (Layer 2)
export {
  shouldTriggerAutoCompact,
  summarizeConversation,
  autoCompact,
  createCompactedMessages,
  buildSummarizationUserPrompt,
  findCutPointByBudget,
  extractExistingSummary,
  type BudgetedCutPointResult,
  type SummarizeOptions,
} from "./auto-compact.js";
export { buildSegmentedConversationText, serializeConversation } from "./serialize-conversation.js";
export {
  applyCompactionResult,
  findOrphanedToolCut,
  applyReactiveCompactionResult,
  type ApplyCompactionResultOptions,
} from "./apply-compaction-result.js";

// Reactive compaction (Emergency)
export { isPromptTooLongError, reactiveCompact, getMaxReactiveRetries } from "./reactive-compact.js";
export type { ReactiveCompactConfig } from "./reactive-compact.js";

export type { TokenUsage } from "../../runtime-types/token-usage.js";
