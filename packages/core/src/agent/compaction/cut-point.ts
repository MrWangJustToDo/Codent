/**
 * Cut-point helpers for auto-compaction.
 *
 * Token-budget walk (`findCutPointByBudget`): keep the most recent messages
 * whose estimated tokens fit a budget, cutting only at user/assistant
 * boundaries so tool call/result pairs are never split.
 */

import { extractTextFromContent } from "../../utils/message-content.js";
import { isContextModelMessage } from "../turn-context/turn-context-message.js";

import {
  extractCompactionSummaryBody,
  hasOuterEndMarker,
  isCompactionSummaryModelMessage,
  isCompactionSummaryText,
} from "./compaction-summary.js";
import { estimateMessageTokens } from "./token-estimator.js";

import type { ModelMessage } from "@tanstack/ai";

// ============================================================================
// Previous-summary extraction
// ============================================================================

/**
 * Detect and extract existing conversation summary from the first message.
 *
 * After compaction, the first message in compactMessages is always a user message
 * with format:
 *   [CONVERSATION SUMMARY] / [END SUMMARY] markers (see compaction-summary.ts)
 *   ...summary text...
 *   ...
 *
 * When detected, we strip this message from the conversation and pass it separately
 * via <previous-summary> tags, enabling incremental (update-style) compaction.
 *
 * @returns extracted summary text and remaining messages (without the summary message)
 */
export function extractExistingSummary(messages: ModelMessage[]): {
  existingSummary?: string;
  cleanMessages: ModelMessage[];
} {
  if (messages.length === 0) return { cleanMessages: messages };

  const first = messages[0];
  if (first.role !== "user") return { cleanMessages: messages };

  const text = extractTextFromContent(first.content);
  // Only treat it as a real compact checkpoint when the outer closing marker is
  // present solo on its own line. This keeps summaries that merely quote the
  // markers (or streamed bodies without a closing marker yet) from being
  // mis-detected and swallowed.
  if (!isCompactionSummaryText(text) || !hasOuterEndMarker(text)) {
    return { cleanMessages: messages };
  }

  const summary = extractCompactionSummaryBody(text);
  if (!summary) return { cleanMessages: messages };

  return {
    existingSummary: summary,
    cleanMessages: messages.slice(1),
  };
}

// ============================================================================
// Cut-point selection
// ============================================================================

/** Result of a budget-based cut-point search. */
export interface BudgetedCutPointResult {
  /**
   * Index of the first kept message (`messages[0..cutIndex)` = to summarize).
   * `0` means "no cut" — either the whole input fits the budget or no valid
   * boundary exists; callers bail out without summarizing.
   */
  cutIndex: number;
  /** The cut lands inside a turn (cut message is not the turn's user message). */
  isSplitTurn: boolean;
  /** Index of the user message starting the split turn, or -1 when not split. */
  turnStartIndex: number;
}

/**
 * A valid cut boundary: user or assistant messages only. Tool results are
 * excluded so a kept suffix never starts between a tool call and its result
 * (results always follow their call-bearing assistant message). Summaries and
 * synthetic `<ctx kind=...>` messages are excluded from cut counting.
 */
function isValidCutBoundary(message: ModelMessage, index: number, summaryMessageIndex: number): boolean {
  if (index === summaryMessageIndex) return false;
  if (message.role !== "user" && message.role !== "assistant") return false;
  if (isCompactionSummaryModelMessage(message)) return false;
  if (isContextModelMessage(message)) return false;
  return true;
}

function findTurnStart(messages: ModelMessage[], fromIndex: number, summaryMessageIndex: number): number {
  for (let i = fromIndex; i >= 0; i--) {
    if (i === summaryMessageIndex) continue;
    const message = messages[i]!;
    if (message.role !== "user") continue;
    if (isCompactionSummaryModelMessage(message)) continue;
    if (isContextModelMessage(message)) continue;
    return i;
  }
  return -1;
}

/**
 * Find the cut point by accumulating estimated tokens backward until the keep
 * budget is reached, then cutting at the nearest valid boundary at or after
 * that index (falling back to the nearest valid boundary before it — the kept
 * window may then exceed the budget, but tool pairs stay intact).
 *
 * @returns cut result; `cutIndex === 0` when nothing needs to be summarized.
 */
export function findCutPointByBudget(
  messages: ModelMessage[],
  budgetTokens: number,
  summaryMessageIndex = -1
): BudgetedCutPointResult {
  const noop = { cutIndex: 0, isSplitTurn: false, turnStartIndex: -1 };
  if (messages.length === 0 || !(budgetTokens > 0)) return noop;

  let accumulated = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    accumulated += estimateMessageTokens(messages[i]!);

    if (accumulated < budgetTokens) continue;

    // Budget reached at index i — nearest valid boundary at or after i.
    for (let j = i; j < messages.length; j++) {
      if (!isValidCutBoundary(messages[j]!, j, summaryMessageIndex)) continue;

      const cutRole = messages[j]!.role;
      const turnStartIndex = cutRole === "user" ? -1 : findTurnStart(messages, j - 1, summaryMessageIndex);
      return { cutIndex: j, isSplitTurn: cutRole !== "user" && turnStartIndex !== -1, turnStartIndex };
    }

    // No valid boundary in the suffix — degrade to the latest valid boundary
    // before i (kept window exceeds budget but pairing stays intact).
    for (let j = i - 1; j >= 0; j--) {
      if (!isValidCutBoundary(messages[j]!, j, summaryMessageIndex)) continue;

      const cutRole = messages[j]!.role;
      const turnStartIndex = cutRole === "user" ? -1 : findTurnStart(messages, j - 1, summaryMessageIndex);
      return { cutIndex: j, isSplitTurn: cutRole !== "user" && turnStartIndex !== -1, turnStartIndex };
    }

    return noop;
  }

  return noop;
}
