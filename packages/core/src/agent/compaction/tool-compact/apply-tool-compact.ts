import { buildToolCallNameMap } from "../message-utils.js";

import { buildToolCallInputMap } from "./build-tool-call-input-map.js";
import {
  formatToolErrorForModel,
  isPendingToolExecutionResult,
  isToolErrorResult,
  normalizeModelToolContent,
  parseToolMessageOutput,
} from "./parse-tool-message.js";

import type { ToolCompactCache } from "./tool-compact-cache.js";
import type { ToModelOutputRegistry } from "./types.js";
import type { CompactionConfig } from "../types.js";
import type { ContentPart, ModelMessage } from "@tanstack/ai";

// ============================================================================
// Types
// ============================================================================

interface ToolResultRef {
  messageIndex: number;
  toolCallId: string;
}

export interface ApplyToolCompactOptions {
  /** Reserved for future tool-compact options; currently unused. */
  config?: Partial<CompactionConfig>;
  registry: Pick<ToModelOutputRegistry, "get">;
  cache: ToolCompactCache;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * A denied approval placeholder (`{ approved: false }`) is not a tool output. Kept as a predicate
 * rather than an `@ts-ignore` on `rawOutput.approved` — the payload is `unknown`, and this branch is
 * load-bearing (compacting the placeholder away makes TanStack skip the approval gate).
 */
function isDeniedToolResult(output: unknown): output is { approved: false } {
  return typeof output === "object" && output !== null && (output as Record<string, unknown>).approved === false;
}

function findToolResultMessages(messages: ModelMessage[]): ToolResultRef[] {
  const results: ToolResultRef[] = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role !== "tool") continue;

    results.push({
      messageIndex: i,
      toolCallId: message.toolCallId ?? "",
    });
  }

  return results;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Transform tool results for the LLM path.
 *
 * Only {@link toModelOutput} formatting runs (cached per `toolCallId`).
 *
 * **Returns a new array / new message objects and never edits its input.**
 * The array handed in may be the one `WireProjectionCache` retains and hands back by
 * reference across calls, so writing into it would corrupt every later call of the run.
 * Messages whose content did not change are shared (`applyToolCompact` is a no-op for
 * them), so the copy is proportional to the number of results actually transformed.
 *
 * The cache is consulted **before** parsing: parsing a tool payload is the expensive
 * part (`JSON.parse` of up to ~100KB per result), it runs on every model call, and its
 * result is discarded whenever the cache hits. Reordering also keeps the hit path free
 * of the `pendingExecution` / error probes, which is sound because only a non-pending
 * result ever reaches {@link ToolCompactCache.set}.
 */
export async function applyToolCompact(
  messages: ModelMessage[],
  options: ApplyToolCompactOptions
): Promise<ModelMessage[]> {
  const cache = options.cache;
  const toolResults = findToolResultMessages(messages);

  if (toolResults.length === 0) {
    return messages;
  }

  const toolCallMap = buildToolCallNameMap(messages);
  const toolInputMap = buildToolCallInputMap(messages);
  /** Replacements keyed by index; only touched results are copied. */
  const replaced = new Map<number, ModelMessage>();

  const setContent = (index: number, content: string | ContentPart[]): void => {
    const base = replaced.get(index) ?? messages[index]!;
    replaced.set(index, { ...base, content } as ModelMessage);
  };

  for (const target of toolResults) {
    const message = messages[target.messageIndex];
    if (!message || message.role !== "tool") continue;

    // Cache first: a hit is the steady state after the first turn, and parsing here
    // would redo work whose only consumer is the probes below.
    const cached = cache.get(target.toolCallId);
    if (cached !== undefined) {
      setContent(target.messageIndex, cached);
      continue;
    }

    const toolName = toolCallMap.get(target.toolCallId) ?? "tool";
    const rawOutput = parseToolMessageOutput(message.content);
    if (isPendingToolExecutionResult(rawOutput)) continue;

    if (isDeniedToolResult(rawOutput)) continue;

    if (isToolErrorResult(rawOutput)) {
      const normalized = normalizeModelToolContent(formatToolErrorForModel(rawOutput));
      cache.set(target.toolCallId, normalized);
      setContent(target.messageIndex, normalized);
      continue;
    }

    const toModelOutput = options.registry.get(toolName);
    if (!toModelOutput) continue;
    const input = toolInputMap.get(target.toolCallId);
    const transformed = await toModelOutput({
      toolCallId: target.toolCallId,
      input,
      output: rawOutput,
    });

    const normalized = normalizeModelToolContent(transformed);
    cache.set(target.toolCallId, normalized);
    setContent(target.messageIndex, normalized);
  }

  if (replaced.size === 0) return messages;

  const next = messages.slice();
  for (const [index, message] of replaced) next[index] = message;
  return next;
}
