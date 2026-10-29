/**
 * Auto Compaction (Layer 2) - LLM-based conversation compression.
 *
 * When estimated tokens exceed the configured threshold:
 * 1. Use a subagent to generate a summary of the conversation
 * 2. Replace messages with compressed summary + acknowledgment
 *
 * This allows agents to work indefinitely by compressing context strategically.
 * Session persistence (save/restore) is handled by the session store separately.
 *
 * The summarization is done via a subagent with:
 * - No tools (pure summarization task)
 * - Custom compaction system prompt
 * - Single iteration (maxIterations: 1)
 * - No retry on empty (the prompt is explicit about output format)
 */

import { errorMessage } from "../../utils/errors.js";
import { generateId } from "../../utils/generate-id.js";
import { runSubagent } from "../subagent/run-subagent.js";
import { EMPTY_SUMMARY } from "../subagent/subagent-output.js";
import { isContextModelMessage } from "../turn-context/turn-context-message.js";

import { compactionAbortError, isCompactionCancel } from "./abort-classification.js";
import { buildCompactionPrompt, COMPACTION_SYSTEM_PROMPT, TURN_PREFIX_INSTRUCTION } from "./compaction-prompt.js";
import { formatCompactionSummaryContent, isCompactionSummaryModelMessage } from "./compaction-summary.js";
import { extractExistingSummary, findCutPointByBudget } from "./cut-point.js";
import { extractFileOpsFromMessages, formatFileOperations } from "./file-ops-tracker.js";
import { resolveAutoCompactTrigger, resolveKeepPolicy } from "./keep-policy.js";
import { buildSegmentedConversationText, serializeConversation } from "./serialize-conversation.js";
import {
  measureSerializedTokens,
  resolveSummarizationInputBudget,
  resolveSummarizationBudget,
  splitMessagesByTokenBudget,
  SUMMARIZATION_OVERHEAD_TOKENS,
  SUMMARIZATION_CHARS_PER_TOKEN,
} from "./summarization-budget.js";
import { estimateTokens } from "./token-estimator.js";

import type { CompactionTodoItem } from "./compaction-prompt.js";
import type { CompactionConfig, CompactionResult } from "./types.js";
import type { AgentManager } from "../../runtime-types/hosts.js";
import type { AgentLog } from "../agent-log/agent-log.js";
import type { ModelMessage } from "@tanstack/ai";

/**
 * Resolve the parent agent's log for observability, tolerating managers that
 * expose no logger or throw from `getAgent` (e.g. the no-op validation harness).
 * Logging must never change compaction behaviour.
 */
function resolveCompactionLog(manager: AgentManager, parentAgentId: string): AgentLog | null {
  try {
    return manager.getAgent(parentAgentId)?.getLog() ?? null;
  } catch {
    return null;
  }
}

export { extractExistingSummary, findCutPointByBudget, type BudgetedCutPointResult } from "./cut-point.js";

// ============================================================================
// Public API
// ============================================================================

/**
 * Check if auto compaction should be triggered.
 *
 * The trigger point is `workingBudget * compactAtPercent / 100`, where the
 * working budget is `tokenThreshold` (auto-filled by the agent factory as
 * `min(contextWindow, MAX_THRESHOLD)`), clamped to the real context window.
 * This keeps the trigger consistent with the UI percentage base.
 *
 * `contextFillTokens` is the tracker's window fill (`UsageTracker.getContextFillTokens()`),
 * i.e. the cache-aware prompt — **not** `window.inputTokens`, which on an exclusive upstream
 * holds only the cache-miss part and would keep the trigger from ever firing.
 */
export function shouldTriggerAutoCompact(
  config: Partial<CompactionConfig>,
  options: { contextFillTokens?: number; messages?: ModelMessage[]; contextWindow?: number } = {}
): boolean {
  const { triggerAt } = resolveAutoCompactTrigger(config, options.contextWindow);
  const { contextFillTokens = 0, messages } = options;

  if (contextFillTokens > 0) return contextFillTokens >= triggerAt;
  if (messages) return estimateTokens(messages) >= triggerAt;
  return false;
}

/** Options for summarizing a conversation */
export interface SummarizeOptions {
  /** Optional focus guidance for the summary */
  focus?: string;
  /** Optional todos to include in the summary */
  todos?: CompactionTodoItem[];
  /** Optional previous summary for incremental update (skips auto-detection) */
  existingSummary?: string;
  /**
   * Recent turns that remain after compaction. Included in the summarizer prompt
   * under `<still_in_context>` for alignment; not applied as part of the cut.
   */
  stillInContext?: ModelMessage[];
  /**
   * Label the input as a discarded turn prefix (`<turn_prefix>`) instead of
   * regular history (`<to_compress>`). Used by split-turn compaction.
   */
  asTurnPrefix?: boolean;
  /** Phase label shown on the compact banner while this pass streams. */
  streamLabel?: string;
  /**
   * Compaction run identity shared by every pass of one auto/manual compaction:
   * same-epoch passes append to the banner instead of resetting it.
   */
  streamEpoch?: string;
  /**
   * Custom instruction prompt replacing `buildCompactionPrompt`. Used
   * internally for the split-turn prefix summary.
   */
  instruction?: string;
  /**
   * Abort signal for the summarization subagent. When the run is cancelled the
   * summarizer rejects (rather than yielding a partial summary), so callers
   * never apply a half-written compaction checkpoint.
   */
  abortSignal?: AbortSignal;
}

/**
 * Build the full summarizer user prompt (segments + instructions) without calling the LLM.
 * Exported for validation scripts.
 */
export function buildSummarizationUserPrompt(toCompress: ModelMessage[], options?: SummarizeOptions): string {
  const { focus, todos, existingSummary, stillInContext, asTurnPrefix, instruction } = options ?? {};
  const conversationText =
    asTurnPrefix && !stillInContext?.length
      ? `<turn_prefix>\n${serializeConversation(toCompress)}\n</turn_prefix>`
      : buildSegmentedConversationText(toCompress, stillInContext);
  const instructionPrompt =
    instruction ??
    buildCompactionPrompt({
      focus,
      todos,
      existingSummary,
      hasStillInContext: Boolean(stillInContext?.length),
    });
  return `${conversationText}\n\n${instructionPrompt}`;
}

/**
 * Use a subagent to summarize the conversation.
 *
 * The subagent is spawned with:
 * - No tools (pure summarization task)
 * - Custom compaction system prompt
 * - Single iteration
 * - No retry on empty output
 *
 * @param messages - Messages to summarize
 * @param parentAgentId - Parent agent ID for spawning subagent
 * @param options - Optional summarization options (focus, todos)
 * @returns Summary text
 */
export async function summarizeConversation(
  messages: ModelMessage[],
  parentAgentId: string,
  manager: AgentManager,
  options?: SummarizeOptions
): Promise<string> {
  const { focus, todos, existingSummary: explicitSummary } = options ?? {};

  let existingSummary: string | undefined;
  let cleanMessages = messages;
  if (explicitSummary) {
    existingSummary = explicitSummary;
  } else {
    const detected = extractExistingSummary(messages);
    existingSummary = detected.existingSummary;
    cleanMessages = detected.cleanMessages;
  }

  const stillInContext = options?.stillInContext;
  const instruction = options?.instruction;
  const asTurnPrefix = options?.asTurnPrefix ?? false;
  const streamEpoch = options?.streamEpoch ?? generateId("cmpepoch");
  const inputBudget = resolveSummarizationInputBudget(manager, parentAgentId);
  // Prefer keeping still_in_context in budget; batch only the to-compress slice.
  const stillTokens = stillInContext?.length ? estimateTokens(stillInContext) : 0;
  const compressBudget = Math.max(SUMMARIZATION_OVERHEAD_TOKENS, inputBudget - stillTokens);
  const batches = splitMessagesByTokenBudget(cleanMessages, compressBudget);

  // Decision-side observability: the segment count is driven by the *serialized*
  // prompt size vs. the resolved budget. Log both that measure and the raw
  // `estimateTokens` so a wire-vs-prompt gap (full tool output vs. truncated
  // prompt) that over-splits is visible without reconstructing it from subagent logs.
  resolveCompactionLog(manager, parentAgentId)?.debug("compaction", "Summarizer segment split", {
    inputBudget,
    stillTokens,
    compressBudget,
    estimatedTokens: estimateTokens(cleanMessages),
    serializedTokens: measureSerializedTokens(cleanMessages),
    segments: batches.length,
    segmentTokens: batches.map((batch) => measureSerializedTokens(batch)),
  });

  if (batches.length <= 1) {
    return summarizeConversationBatch(cleanMessages, parentAgentId, manager, {
      focus,
      todos,
      existingSummary,
      stillInContext,
      asTurnPrefix,
      instruction,
      streamEpoch,
      ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
    });
  }

  const partialSummaries: string[] = [];
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!;
    const batchFocus = instruction
      ? instruction
      : focus != null
        ? `${focus} (segment ${i + 1} of ${batches.length})`
        : `Summarize segment ${i + 1} of ${batches.length} of the conversation`;
    partialSummaries.push(
      await summarizeConversationBatch(batch, parentAgentId, manager, {
        focus: batchFocus,
        todos: i === batches.length - 1 ? todos : undefined,
        existingSummary: i === 0 ? existingSummary : undefined,
        // Align with kept turns only on the final merge step.
        asTurnPrefix,
        instruction,
        streamLabel: `Segment ${i + 1}/${batches.length}`,
        streamEpoch,
        ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
      })
    );
  }

  const mergedInput = partialSummaries.map((summary, index) => `## Segment ${index + 1}\n\n${summary}`).join("\n\n");
  return summarizeConversationBatch([{ role: "user", content: mergedInput }], parentAgentId, manager, {
    focus: instruction
      ? undefined
      : (focus ?? "Merge the segment summaries into one cohesive continuation prompt for the next agent"),
    todos,
    existingSummary,
    stillInContext,
    asTurnPrefix,
    instruction,
    streamLabel: "Merging segment summaries",
    streamEpoch,
    ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
  });
}

async function summarizeConversationBatch(
  messages: ModelMessage[],
  parentAgentId: string,
  manager: AgentManager,
  options?: SummarizeOptions
): Promise<string> {
  // A session switch can abort between two compaction batches, before this batch has spawned a
  // subagent. Do not start a new summarizer (and recreate its stream) after the switch.
  if (options?.abortSignal?.aborted) throw compactionAbortError();
  const fullPrompt = buildSummarizationUserPrompt(messages, options);
  const compactId = parentAgentId;
  const { maxOutputTokens } = resolveSummarizationBudget(manager.getAgent(parentAgentId)?.getModelInfo());

  const result = await runSubagent(
    {
      prompt: fullPrompt,
      parentAgentId,
      profile: "internal",
      systemPrompt: COMPACTION_SYSTEM_PROMPT,
      tools: {},
      maxIterations: 1,
      maxOutputLength: maxOutputTokens * SUMMARIZATION_CHARS_PER_TOKEN,
      autoDestroy: true,
      aggregateUsageToParent: true,
      description: "compaction",
      compactSummaryStream: {
        compactId,
        label: options?.streamLabel ?? "Summarizing conversation",
        epoch: options?.streamEpoch ?? generateId("cmpepoch"),
      },
      ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
    },
    { manager }
  );

  // An aborted run returns partial text (+ a cancel notice) — never treat that as
  // a summary, or a half-written compaction checkpoint would be applied.
  if (result.aborted || options?.abortSignal?.aborted) {
    throw compactionAbortError();
  }

  const output = result.output?.trim() ?? "";
  if (!output || output === EMPTY_SUMMARY) {
    throw new Error(
      `Compaction subagent returned no summary (tokens=${result.usage.totalTokens}, ` +
        `incomplete=${result.incomplete}, reachedLimit=${result.reachedLimit}, wasAborted=${result.aborted})`
    );
  }

  return output;
}

/**
 * Create the compressed message with the conversation summary.
 *
 * @param summary - The generated summary
 * @returns Array with just the summary as a user message
 */
export function createCompactedMessages(summary: string): ModelMessage[] {
  return [
    {
      role: "user" as const,
      content: formatCompactionSummaryContent(summary),
    },
  ];
}

/**
 * Perform auto compaction on messages.
 *
 * `messages` is the channel-derived list (chronological or already summary-first
 * wire). After success the caller appends a new SUMMARY onto the UI channel;
 * middleware then re-projects summary-first wire from the live channel.
 *
 * Algorithm:
 * 1. Detect a previous summary at index 0 when the input is already wire-ordered
 *    (summary-first); strip it from cut counting and feed as `existingSummary`.
 * 2. Find the cut point by a backward token-budget walk (pairing-safe; may cut
 *    inside a turn — see cut-point.ts).
 * 3. Summarize with segmented input: `<to_compress>` (pre-cut) + `<still_in_context>`
 *    (kept turns). Previous summary is fed as `existingSummary` for incremental updates.
 *    When the cut lands inside a turn (token-budget policy), the discarded turn
 *    prefix is summarized separately under `<turn_prefix>` and merged into the
 *    final SUMMARY.
 * 4. Optionally archive the compressed slice and append a pointer to the summary.
 * 5. Return `cutIndex` relative to the input `messages` array (including any
 *    summary-first offset). The caller maps that onto the chronological channel.
 *
 * @param messages - Chronological or summary-first model-visible messages
 * @param config - Compaction configuration (keepRecentTokens budget; see keep-policy.ts)
 * @param parentAgentId - Parent agent ID for spawning summarization subagent
 * @param options - Optional summarization options (focus, todos)
 * @returns Compaction result with summary and cutIndex (relative to input messages)
 */
export async function autoCompact(
  messages: ModelMessage[],
  config: Partial<CompactionConfig>,
  parentAgentId: string,
  manager: AgentManager,
  options?: SummarizeOptions & { actualTokens?: number; contextWindow?: number }
): Promise<CompactionResult> {
  const estimated = estimateTokens(messages);
  const tokensBefore = options?.actualTokens ?? estimated;

  if (messages.length === 0) {
    return { compacted: false, tokensBefore, tokensAfter: tokensBefore, type: "auto" };
  }

  // One compaction run = one continuous banner stream: every summarizer pass
  // shares this epoch so follow-up passes append instead of resetting.
  const streamEpoch = options?.streamEpoch ?? generateId("cmpepoch");

  // Detect previous summary message at index 0 (if any). It is excluded from
  // cut counting and from the slice sent to the summarizer — instead it
  // is passed via `existingSummary` for incremental update.
  const hasPrevSummary = messages[0].role === "user" && extractExistingSummary([messages[0]]).existingSummary;
  const summaryOffset = hasPrevSummary ? 1 : 0;

  // Find the cut point relative to the input `messages` array using the
  // token-budget policy (always tokens — see keep-policy.ts).
  let contextWindow = options?.contextWindow;
  if (!contextWindow) {
    try {
      contextWindow = manager.getAgent(parentAgentId)?.getModelInfo()?.contextWindow ?? undefined;
    } catch {
      // Host without agent-registry access — fall back to the default-window derivation.
    }
  }
  const policy = resolveKeepPolicy(config, contextWindow);
  const cut = findCutPointByBudget(messages, policy.keepRecentTokens, hasPrevSummary ? 0 : -1);
  const llmCutIndex = cut.cutIndex;
  const turnStartIndex = cut.turnStartIndex;

  if (llmCutIndex === 0) {
    return { compacted: false, tokensBefore, tokensAfter: tokensBefore, type: "auto" };
  }

  // Slice to summarize: everything before llmCutIndex, excluding the previous
  // summary message (it's passed as existingSummary instead). Kept turns are
  // passed as stillInContext for summarizer alignment only.
  const splitTurn = turnStartIndex >= 0 && turnStartIndex < llmCutIndex;
  const historyEnd = splitTurn ? turnStartIndex : llmCutIndex;
  const historyToSummarize = messages.slice(summaryOffset, historyEnd);
  const turnPrefixMessages = splitTurn ? messages.slice(turnStartIndex, llmCutIndex) : [];
  const keptMessages = messages.slice(llmCutIndex);

  // Nothing older than the kept window to summarize and no oversized turn to
  // split — compacting here would run a wasteful no-op summary that barely
  // shrinks context. Bail out without calling the summarizer.
  if (historyToSummarize.length === 0 && turnPrefixMessages.length === 0) {
    return { compacted: false, tokensBefore, tokensAfter: tokensBefore, type: "auto" };
  }

  // A previous SUMMARY sitting in the kept/cut window (or a just-appended
  // checkpoint re-projected to the wire head) is not new history. Summarizing
  // it would append a near-duplicate checkpoint without shrinking context.
  const toSummarize = [...historyToSummarize, ...turnPrefixMessages];
  if (toSummarize.every((message) => isCompactionSummaryModelMessage(message) || isContextModelMessage(message))) {
    return { compacted: false, tokensBefore, tokensAfter: tokensBefore, type: "auto" };
  }

  // Convert cutIndex from "relative to llmMessages" to "relative to raw
  // context.messages" by subtracting the summary message offset. This makes
  // applyCompactionResult's `absoluteCut = oldCompactIndex + cutIndex` correct.
  const cutIndex = llmCutIndex - summaryOffset;

  // Decision-side observability: record the cut plan and the size of the slice
  // handed to the summarizer. `estimatedTokens` (raw wire) vs `serializedTokens`
  // (truncated prompt) exposes why a single pass may split into segments.
  resolveCompactionLog(manager, parentAgentId)?.debug("compaction", "Auto-compact cut plan", {
    tokensBefore,
    triggerAt: resolveAutoCompactTrigger(config, contextWindow).triggerAt,
    keepRecentTokens: policy.keepRecentTokens,
    cutIndex,
    turnStartIndex,
    splitTurn,
    historyToSummarize: historyToSummarize.length,
    turnPrefixMessages: turnPrefixMessages.length,
    keptMessages: keptMessages.length,
    estimatedTokens: estimateTokens(toSummarize),
    serializedTokens: measureSerializedTokens(toSummarize),
  });

  try {
    // If there's a previous summary, pass it for incremental update.
    const prevSummary = hasPrevSummary ? extractExistingSummary([messages[0]]).existingSummary : undefined;

    let summary: string;
    if (splitTurn && turnPrefixMessages.length > 0) {
      // Split-turn compaction: summarize pre-history and the discarded turn
      // prefix separately, then merge (pi-style). The prefix gets a dedicated
      // prompt focused on what the retained suffix needs.
      const historySummary =
        historyToSummarize.length > 0
          ? await summarizeConversation(historyToSummarize, parentAgentId, manager, {
              ...options,
              ...(prevSummary ? { existingSummary: prevSummary } : {}),
              stillInContext: keptMessages,
              streamLabel: "Summarizing earlier conversation",
              streamEpoch,
            })
          : undefined;
      const prefixSummary = await summarizeConversation(turnPrefixMessages, parentAgentId, manager, {
        asTurnPrefix: true,
        instruction: TURN_PREFIX_INSTRUCTION,
        streamLabel: "Summarizing discarded turn context",
        streamEpoch,
        ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
      });
      // When the split turn starts right after the head SUMMARY (no history to
      // compress), prevSummary must still survive — otherwise the new checkpoint
      // would silently drop all pre-split context.
      summary = historySummary
        ? `${historySummary}\n\n---\n\n## Turn Context (split turn)\n\n${prefixSummary}`
        : prevSummary
          ? `${prevSummary}\n\n---\n\n## Turn Context (split turn)\n\n${prefixSummary}`
          : prefixSummary;
    } else {
      summary = await summarizeConversation(historyToSummarize, parentAgentId, manager, {
        ...options,
        ...(prevSummary ? { existingSummary: prevSummary } : {}),
        stillInContext: keptMessages,
        streamEpoch,
      });
    }

    const fileOps = extractFileOpsFromMessages(toSummarize);
    const summaryWithFileOps = summary + formatFileOperations(fileOps);

    const keptTokens = estimateTokens(keptMessages);
    const summaryTokens = estimateTokens(createCompactedMessages(summaryWithFileOps));

    return {
      compacted: true,
      tokensBefore,
      tokensAfter: summaryTokens + keptTokens,
      type: "auto",
      summary: summaryWithFileOps,
      cutIndex,
    };
  } catch (error) {
    // User cancel: leave the conversation untouched and report that explicitly. It is NOT a
    // failure: the caller must not arm the compaction retry backoff (a cancel would otherwise
    // defer the next real compaction until the context grew by another 8k tokens) and must not
    // emit an error event.
    if (isCompactionCancel(error, options?.abortSignal)) {
      return { compacted: false, tokensBefore, tokensAfter: tokensBefore, type: "auto", aborted: true };
    }
    const failureText = errorMessage(error);

    return {
      compacted: false,
      tokensBefore,
      tokensAfter: tokensBefore,
      type: "auto",
      error: `Compaction failed: ${failureText}. Original messages preserved.`,
    };
  }
}
