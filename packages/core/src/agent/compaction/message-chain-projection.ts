/**
 * Chronological UIMessage/ModelMessage chain → summary-first LLM wire projection.
 *
 * Durable channel order stays chronological (`[…kept…][SUMMARY][…newer…]`).
 * Wire order for the model is `[SUMMARY, …kept…, …newer…]`. Never write the
 * projected array back into the channel.
 */

import { generateId } from "../../utils/generate-id.js";

import { formatCompactionSummaryContent, isCompactionSummaryModelMessage } from "./compaction-summary.js";
import { findCutPointByBudget } from "./cut-point.js";

import type { ModelMessage, UIMessage } from "@tanstack/ai";

export {
  CONVERSATION_SUMMARY_END,
  CONVERSATION_SUMMARY_START,
  formatCompactionSummaryContent,
  isCompactionSummaryModelMessage,
  isCompactionSummaryText,
  isCompactionSummaryUIMessage,
  isLatestDurableMessageCompactionSummary,
} from "./compaction-summary.js";

/** Index of the latest in-chain compaction summary, or -1. */
export function findLatestSummaryIndex(messages: ModelMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isCompactionSummaryModelMessage(messages[i]!)) return i;
  }
  return -1;
}

/** Build a UIMessage checkpoint for appending onto the channel. */
export function createCompactionSummaryUIMessage(summary: string, id?: string): UIMessage {
  return {
    id: id ?? generateId("compact"),
    role: "user",
    parts: [{ type: "text", content: formatCompactionSummaryContent(summary) }],
  };
}

export interface GetModelVisibleMessagesOptions {
  /** Token budget for the kept window (pairing-safe token walk). */
  keepRecentTokens?: number;
}

/**
 * Project a chronological model-message chain to summary-first wire order.
 *
 * - No summary → identity
 * - With summary → `[summary, …kept before summary…, …after summary…]`
 */
export function getModelVisibleMessages(
  messages: ModelMessage[],
  options: GetModelVisibleMessagesOptions = {}
): ModelMessage[] {
  const { keepRecentTokens } = options;
  const summaryIdx = findLatestSummaryIndex(messages);
  if (summaryIdx < 0) {
    return messages;
  }

  const summary = messages[summaryIdx]!;
  const before = messages.slice(0, summaryIdx);
  const after = messages.slice(summaryIdx + 1);
  // Deterministic over the frozen pre-summary slice: same content + policy
  // always yields the same kept window (see design notes in keep-policy.ts).
  const keptStart = findCutPointByBudget(before, keepRecentTokens ?? 0).cutIndex;
  // The latest summary is an incremental update of every older one, and older summaries are
  // structural (they do not consume the keep budget — see `findCutPointByBudget`). Keeping them in
  // the kept slice therefore accumulated one stale checkpoint per compaction: a long session's
  // wire carried 3+ "CONVERSATION SUMMARY" blocks, only the last of which was current. Filter them
  // out of the chronological window; the single head checkpoint is the only one the model sees.
  const kept = before.slice(keptStart).filter((message) => !isCompactionSummaryModelMessage(message));
  return [summary, ...kept, ...after];
}
