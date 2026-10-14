/**
 * Apply a successful compaction result onto the UI channel.
 * Shared by auto-compaction middleware and CLI `/compact`.
 */

import { convertMessagesToModelMessages } from "@tanstack/ai";

import { toError } from "../../utils/errors.js";
import { cleanupOrphanedToolCache } from "../tools/util/tool-output-cache.js";
import { appendChannelMessages } from "../ui/channel-write.js";

import { extractCompactionSummaryBody } from "./compaction-summary.js";
import { deriveKeepRecentTokens } from "./keep-policy.js";
import { createCompactionSummaryUIMessage, getModelVisibleMessages } from "./message-chain-projection.js";
import { DEFAULT_SUMMARIZATION_CONTEXT_WINDOW } from "./summarization-budget.js";

import type { CompactionResult } from "./types.js";
import type { ResolvedCoreEnv } from "../../env";
import type { UsageTracker } from "../../runtime-types/hosts.js";
import type { AgentUIChannel } from "../ui/ui-channel.js";
import type { ModelMessage } from "@tanstack/ai";

export interface ApplyCompactionResultOptions {
  /** Called if orphaned tool-cache cleanup fails (non-fatal). */
  onCacheCleanupError?: (error: Error) => void;
  /** Token-budget keep policy (derived from the shared default window when unset). */
  keepRecentTokens?: number;
}

/**
 * Append a compaction summary checkpoint to the UI channel, reset window usage,
 * and clean orphaned tool-output caches for messages no longer on the wire.
 *
 * @returns true if result was applied; false if nothing to apply
 */
export function applyCompactionResult(
  env: ResolvedCoreEnv,
  _messages: ModelMessage[],
  channel: AgentUIChannel,
  usage: UsageTracker,
  result: CompactionResult,
  options?: ApplyCompactionResultOptions
): boolean {
  if (!result.compacted || !result.summary) {
    return false;
  }

  const keepRecentTokens = options?.keepRecentTokens ?? deriveKeepRecentTokens(DEFAULT_SUMMARIZATION_CONTEXT_WINDOW);
  const summaryUI = createCompactionSummaryUIMessage(result.summary);
  // Single safe channel-append entry (shared with synthetic injection): dedupes
  // by stable id, appends at the tail, and emits the same channel write path.
  appendChannelMessages(channel, [summaryUI]);
  usage.resetWindow();

  // Orphan cleanup must use post-append chronology (summary at end changes the wire window).
  const chronologic = convertMessagesToModelMessages(channel.getMessages());
  const visible = getModelVisibleMessages(chronologic, { keepRecentTokens });
  const visibleToolIds = collectToolCallIds(visible);
  const orphanCut = firstOrphanToolIndex(chronologic, visibleToolIds);
  if (orphanCut > 0) {
    cleanupOrphanedToolCache(env, chronologic, orphanCut).catch((err) => {
      const error = toError(err);
      options?.onCacheCleanupError?.(error);
    });
  }

  return true;
}

/**
 * Apply reactive compaction: append the summary message onto the channel.
 * Tail continuity comes from in-chain look-back projection (not compactIndex).
 */
export function applyReactiveCompactionResult(
  env: ResolvedCoreEnv,
  messages: ModelMessage[],
  channel: AgentUIChannel,
  usage: UsageTracker,
  compactedMessages: ModelMessage[],
  options?: ApplyCompactionResultOptions
): boolean {
  if (compactedMessages.length === 0) return false;

  const summaryMsg = compactedMessages[0];
  if (!summaryMsg || summaryMsg.role !== "user") return false;

  const text =
    typeof summaryMsg.content === "string"
      ? summaryMsg.content
      : Array.isArray(summaryMsg.content)
        ? summaryMsg.content
            .map((part) => (part.type === "text" && "content" in part ? String(part.content) : ""))
            .join("")
        : "";

  // Strip markers if present — createCompactionSummaryUIMessage re-wraps.
  const body = extractCompactionSummaryBody(text);
  if (!body) return false;

  return applyCompactionResult(
    env,
    messages,
    channel,
    usage,
    {
      compacted: true,
      tokensBefore: 0,
      tokensAfter: 0,
      type: "reactive",
      summary: body,
    },
    options
  );
}

function collectToolCallIds(messages: ModelMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "tool" && msg.toolCallId) ids.add(msg.toolCallId);
  }
  return ids;
}

/** First index of a tool message whose toolCallId is not in the visible set. */
function firstOrphanToolIndex(messages: ModelMessage[], visibleToolIds: Set<string>): number {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role === "tool" && msg.toolCallId && !visibleToolIds.has(msg.toolCallId)) {
      return i + 1;
    }
  }
  return 0;
}
