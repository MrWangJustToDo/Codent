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

import { errorMessage } from "../../utils/errors.js";
import { extractRunErrorMessage } from "../stream/run-error-message.js";

import { isCompactionCancel } from "./abort-classification.js";
import { createCompactedMessages, summarizeConversation } from "./auto-compact.js";
import { findCutPointByBudget } from "./cut-point.js";
import { deriveKeepRecentTokens } from "./keep-policy.js";

import type { AgentManager } from "../../runtime-types/hosts.js";
import type { ModelMessage, StreamChunk } from "@tanstack/ai";

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
 * Stable provider failure codes meaning "the input did not fit the context window".
 *
 * `context_overflow` is `@tanstack/ai`'s normalized code (0.69+, exported there as
 * `CONTEXT_OVERFLOW_CODE`). We hold it as a literal rather than importing the
 * constant because the installed 0.68 does not export one — see
 * {@link isPromptTooLongError} for why the set is wider than the SDK's single code.
 *
 * The rest are the pre-normalization spellings that still arrive from an installed
 * adapter or an older server:
 *
 * - `context_length_exceeded` — what OpenAI-compatible adapters sent **before** 0.69
 *   (and still send from any pinned copy), recorded in the SDK changelog.
 * - `model_context_window_exceeded` — Anthropic's `stop_reason`; the adapter now
 *   raises it as the `RUN_ERROR` code (before, it emitted `RUN_FINISHED` with
 *   `finishReason: "stop"`, so a truncated answer looked complete).
 * - `prompt_too_long` — Anthropic's error type, and the word some gateways put in
 *   `code` instead of `message`.
 */
export const CONTEXT_OVERFLOW_CODES: ReadonlySet<string> = new Set([
  "context_overflow",
  "context_length_exceeded",
  "model_context_window_exceeded",
  "prompt_too_long",
]);

/**
 * Read the `code` a failure carries.
 *
 * One property read covers both shapes we see: an `Error` that
 * `attachRunErrorCode` copied the provider code onto, and a `RUN_ERROR` chunk passed
 * through unchanged — the SDK puts the code at the top level in both cases. The
 * literal `"undefined"` (which the SDK writes when the provider sent no code) is not
 * a signal and is treated as absent.
 */
function errorCode(error: unknown): string | undefined {
  if (error == null || typeof error !== "object") return undefined;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct !== "string" || direct.length === 0 || direct === "undefined") return undefined;
  return direct;
}

/**
 * Prose spellings of "input did not fit", across the providers we support.
 *
 * ⚠️ This is a **fallback**, not the primary signal — {@link isPromptTooLongError}
 * prefers the error `code`, which is why the phrase list never has to be complete.
 * It exists because a code is not guaranteed: a self-hosted gateway, a proxy that
 * rewrites the error body, or an adapter pinned before the SDK's normalization can
 * deliver the overflow as text alone.
 *
 * Provenance matters here — the whole point of the code-first path is to stop
 * guessing from prose — so the entries are grouped by how much they are worth:
 *
 * - the first six are the list as it stood, unchanged; they are what we have been
 *   matching in production and none of them is being dropped;
 * - `prompt is too long` (Anthropic) and `context_length_exceeded` (OpenAI's code
 *   spelled into a message) are the two that were **missing** and that a real
 *   overflow was most likely to carry;
 * - the last three are provider-documented strings that have **not** been observed
 *   in this repo's logs. They are cheap to match and cannot false-positive on a
 *   non-overflow failure, but they are not evidence-backed the way the first eight
 *   are, and that is stated rather than implied.
 *
 * `too large` is deliberately left in place despite being the broadest entry: it is
 * pre-existing behaviour, and it is only reachable from an LLM run failure (tool
 * errors never reach this predicate), so narrowing it is a separate decision.
 */
function looksLikeContextOverflowMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    // The original list — in production, unchanged.
    lower.includes("prompt_too_long") ||
    lower.includes("too many tokens") ||
    lower.includes("max tokens exceeded") ||
    lower.includes("context length exceeded") ||
    lower.includes("too large") ||
    lower.includes("maximum context length") ||
    // Missing spellings of a real overflow.
    lower.includes("prompt is too long") ||
    lower.includes("context_length_exceeded") ||
    // Provider-documented, unobserved here.
    lower.includes("input is too long") ||
    lower.includes("exceeds the maximum number of tokens") ||
    lower.includes("context window exceeded")
  );
}

/**
 * Check if a failure means the prompt did not fit the model's context window.
 *
 * **Code first, prose second.** The `code` is the provider's own stable identifier
 * (`context_overflow`, `context_length_exceeded`, …) and needs no guessing; the
 * message is only consulted when no usable code is present.
 *
 * Why this order is the fix rather than a preference: the previous version matched
 * message substrings only, and its list was missing `prompt is too long` (Anthropic)
 * and `context_length_exceeded` (OpenAI). A real overflow therefore fell through to
 * "not an overflow" unless some other phrase happened to be in the same message, and
 * the emergency compaction never ran — the failure surfaced as a dead run instead.
 * Matching the code removes the dependency on the provider's wording entirely.
 *
 * Accepts an `Error`, a `RUN_ERROR` chunk, or a raw message, because the three
 * recovery paths hold different shapes (see `runStreamWithRecovery`).
 */
export function isPromptTooLongError(error: unknown): boolean {
  if (!error) return false;

  const code = errorCode(error);
  if (code != null && CONTEXT_OVERFLOW_CODES.has(code.toLowerCase())) return true;

  // A chunk's message lives under `error`; an Error's is on itself.
  const message =
    typeof error === "object" && (error as { type?: unknown }).type === "RUN_ERROR"
      ? extractRunErrorMessage(error as StreamChunk)
      : errorMessage(error);

  return looksLikeContextOverflowMessage(message);
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
  // No cut point means there is nothing safe to summarize (one oversized user turn, or a wire
  // whose only cuttable boundary is index 0). Returning the input unchanged used to be read as a
  // successful compaction by the caller, which wrapped the user's own text in a SUMMARY and reset
  // the window — a fabricated checkpoint that made the next retry overflow again.
  if (messages.length === 0) return [];

  // Split into summary portion and pairing-safe token-budgeted tail
  const { summaryMessages, tailMessages } = selectReactiveTail(messages, config);
  if (summaryMessages.length === 0) return [];

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
    if (isCompactionCancel(error, config.abortSignal)) {
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
