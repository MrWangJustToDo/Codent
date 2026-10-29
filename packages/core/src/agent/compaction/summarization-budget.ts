/**
 * Token budget helpers for compaction summarization subagents.
 */

import { measureSerializedConversationChars, serializedMessageChars } from "./serialize-conversation.js";
import { toolNameByMessageIndex } from "./tool-call-pairing.js";

import type { AgentManager } from "../../runtime-types/hosts.js";
import type { ModelMessage } from "@tanstack/ai";

/** Fallback context window when model metadata is unavailable. */
export const DEFAULT_SUMMARIZATION_CONTEXT_WINDOW = 128_000;

/** Fraction of the context window used as output reserve when the model reports no max output. */
export const SUMMARIZATION_OUTPUT_RESERVE_FALLBACK_RATIO = 0.12;

/** Approximate characters per token, used to widen the char-truncation backstop. */
export const SUMMARIZATION_CHARS_PER_TOKEN = 4;

/** Reserve tokens for system prompt, instructions, and model output. */
export const SUMMARIZATION_OVERHEAD_TOKENS = 8_000;

/**
 * Hard cap on the output reserve. A model's declared `defaultMaxTokens` is an
 * upper bound on generation, not what a summarizer emits; reserving it whole
 * (some models report 384k) needlessly starves the input budget and forces
 * multi-segment summarization.
 */
export const SUMMARY_OUTPUT_CAP = 32_000;

/** Minimum input budget so tiny models still get a usable slice. */
export const MIN_SUMMARIZATION_INPUT_BUDGET = 16_000;

/** Resolved budget for one summarization pass. */
export interface SummarizationBudget {
  /** Tokens of serialized input one summarization call can accept. */
  inputBudget: number;
  /** Model's max output tokens (falls back to a window-derived reserve). */
  maxOutputTokens: number;
}

/**
 * Resolve the budget for one summarization call from model metadata.
 *
 * The input budget reserves the output tokens (capped at {@link SUMMARY_OUTPUT_CAP})
 * plus overhead so the summarizer round-trips a single pass without overflowing
 * the model's context window. When the model reports no `defaultMaxTokens`, a
 * window-derived output reserve is used instead (sized so a typical window still
 * single-passes).
 *
 * @param modelInfo - Model metadata (contextWindow / defaultMaxTokens), if known
 */
export function resolveSummarizationBudget(
  modelInfo: { contextWindow?: number; defaultMaxTokens?: number } | null | undefined
): SummarizationBudget {
  const contextWindow = modelInfo?.contextWindow ?? DEFAULT_SUMMARIZATION_CONTEXT_WINDOW;
  const reportedOutput =
    modelInfo?.defaultMaxTokens && modelInfo.defaultMaxTokens > 0 ? modelInfo.defaultMaxTokens : undefined;
  const reserve = reportedOutput ?? Math.floor(contextWindow * SUMMARIZATION_OUTPUT_RESERVE_FALLBACK_RATIO);
  const maxOutputTokens = Math.min(reserve, SUMMARY_OUTPUT_CAP);
  const inputBudget = Math.max(
    MIN_SUMMARIZATION_INPUT_BUDGET,
    contextWindow - maxOutputTokens - SUMMARIZATION_OVERHEAD_TOKENS
  );
  return { inputBudget, maxOutputTokens };
}

/**
 * Resolve how many tokens of conversation can be sent to one summarization call.
 */
export function resolveSummarizationInputBudget(manager: AgentManager, parentAgentId: string): number {
  const parent = manager.getAgent(parentAgentId);
  return resolveSummarizationBudget(parent?.getModelInfo()).inputBudget;
}

/** Serialized-size tokens for one message (see {@link splitMessagesByTokenBudget}). */
function estimateSerializedMessageTokens(
  message: ModelMessage,
  toolNames: Map<number, string>,
  messageIndex: number
): number {
  const chars = serializedMessageChars(message, toolNames, messageIndex);
  return chars > 0 ? Math.ceil(chars / SUMMARIZATION_CHARS_PER_TOKEN) : 0;
}

/**
 * Split messages into batches that each fit within the summarization token budget.
 *
 * Sizing mirrors {@link serializeConversation} (tool results capped at
 * `TOOL_RESULT_MAX_CHARS`, tool args at `TOOL_ARGS_MAX_CHARS`) so the decision
 * measures the prompt actually sent to the summarizer — the raw wire carries
 * full tool output and overestimates the prompt several-fold.
 */
export function splitMessagesByTokenBudget(messages: ModelMessage[], maxTokens: number): ModelMessage[][] {
  if (messages.length === 0) return [];

  const toolNames = toolNameByMessageIndex(messages);
  const batches: ModelMessage[][] = [];
  let current: ModelMessage[] = [];
  let currentTokens = 0;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    const messageTokens = estimateSerializedMessageTokens(message, toolNames, i);
    if (current.length > 0 && currentTokens + messageTokens > maxTokens) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(message);
    currentTokens += messageTokens;
  }

  if (current.length > 0) {
    batches.push(current);
  }

  return batches;
}

/**
 * Serialized-size tokens for a message list — the same truncated, label-inclusive
 * measure {@link splitMessagesByTokenBudget} uses to size a summarizer prompt.
 *
 * Exposed for observability: logging this alongside the raw
 * `estimateTokens` makes the wire-vs-prompt gap (full tool output vs the
 * truncated prompt actually sent) visible at compact time.
 */
export function measureSerializedTokens(messages: ModelMessage[]): number {
  const chars = measureSerializedConversationChars(messages);
  return chars > 0 ? Math.ceil(chars / SUMMARIZATION_CHARS_PER_TOKEN) : 0;
}
