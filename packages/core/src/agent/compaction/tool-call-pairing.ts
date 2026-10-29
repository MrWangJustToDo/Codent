/**
 * Pair every tool result with the call that produced it — the one chronological rule shared by
 * tool-compact, the summarizer serializer and its size estimator.
 *
 * A single `Map<id, …>` built in one pass is not enough: provider ids are request-scoped and
 * reused (`call_0`), and a call with no result (iteration limit, interrupted stream) would leave a
 * stale entry. Queuing per id was also wrong in that case — the queued call would be paired with a
 * LATER request's result. The wire is chronological, so the only call a result can belong to is
 * the most recent one with that id; storing one slot and clearing it on consumption also makes a
 * duplicate result fall back to "no formatter" instead of stealing another call's metadata.
 */

import { parseToolArguments } from "../../utils/parse-tool-arguments.js";

import type { ModelMessage } from "@tanstack/ai";

export interface ToolResultPair {
  /** Index of the `role: "tool"` message in the wire. */
  messageIndex: number;
  toolCallId: string;
  /** The call that produced this result; `"tool"` when no preceding call carried its id. */
  toolName: string;
  /** Parsed arguments of that call, or `undefined` when it cannot be paired. */
  input: unknown;
}

/** Pair tool results with their calls, keyed by the result message's index. */
export function pairToolResults(messages: ModelMessage[]): Map<number, ToolResultPair> {
  const pending = new Map<string, { name: string; input: unknown }>();
  const pairs = new Map<number, ToolResultPair>();

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;

    if (message.role === "assistant" && message.toolCalls) {
      for (const toolCall of message.toolCalls) {
        pending.set(toolCall.id, {
          name: toolCall.function.name,
          input: parseToolArguments(toolCall.function.arguments),
        });
      }
      continue;
    }

    if (message.role !== "tool") continue;

    const toolCallId = message.toolCallId ?? "";
    const meta = pending.get(toolCallId);
    pending.delete(toolCallId);
    pairs.set(i, {
      messageIndex: i,
      toolCallId,
      toolName: meta?.name ?? "tool",
      input: meta?.input,
    });
  }

  return pairs;
}

/** Tool name per result-message index (the serializer's label lookup). */
export function toolNameByMessageIndex(messages: ModelMessage[]): Map<number, string> {
  return new Map([...pairToolResults(messages)].map(([index, pair]) => [index, pair.toolName]));
}
