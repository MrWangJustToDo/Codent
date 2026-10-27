/**
 * Conversation serialization for compaction summarization.
 *
 * Converts TanStack ModelMessage[] to a plain text transcript. This prevents
 * the summarization LLM from generating tool calls.
 *
 * Format:
 *   [User]: ...
 *   [Assistant]: ...
 *   [Assistant tool calls]: name(args); ...
 *   [Tool result from name]: ...
 */

import { truncateText } from "../../utils/text-truncation.js";

import { buildToolCallNameMap, extractTextFromContent, serializeToolMessageContent } from "./message-utils.js";
import { estimateCharUnits } from "./token-estimator.js";

import type { ModelMessage } from "@tanstack/ai";

/** Maximum characters for a single tool result in serialized output */
export const TOOL_RESULT_MAX_CHARS = 2000;

/** Maximum characters for a single tool-call argument string in serialized output */
export const TOOL_ARGS_MAX_CHARS = 200;

function truncateToolArgs(args: string): string {
  return truncateText(args, TOOL_ARGS_MAX_CHARS);
}

function truncateToolResult(text: string): string {
  if (text.length <= TOOL_RESULT_MAX_CHARS) return text;
  return text.slice(0, TOOL_RESULT_MAX_CHARS) + `\n[... ${text.length - TOOL_RESULT_MAX_CHARS} chars truncated]`;
}

/**
 * Character length of the segment one message contributes to
 * {@link serializeConversation} — labels and truncation included.
 *
 * Kept in lockstep with the serializer so callers sizing a summarizer prompt
 * (e.g. {@link splitMessagesByTokenBudget}) measure what is actually sent
 * rather than the untruncated wire.
 *
 * @param toolCallMap - toolCallId → tool name, built from the whole message
 *   list via {@link buildToolCallNameMap} so tool result labels are accurate.
 */
export function serializedMessageChars(message: ModelMessage, toolCallMap: Map<string, string>): number {
  if (message.role === "user") {
    const text = extractTextFromContent(message.content);
    return text ? estimateCharUnits(`[User]: ${text}`) : 0;
  }

  if (message.role === "assistant") {
    let chars = 0;
    const text = extractTextFromContent(message.content);
    if (text) chars += estimateCharUnits(`[Assistant]: ${text}`);
    if (message.toolCalls && message.toolCalls.length > 0) {
      const toolCalls = message.toolCalls.map((tc) => {
        const args = truncateToolArgs(tc.function.arguments);
        return `${tc.function.name}(${args})`;
      });
      chars += estimateCharUnits(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
    }
    return chars;
  }

  if (message.role === "tool") {
    const toolName = (message.toolCallId && toolCallMap.get(message.toolCallId)) || "tool";
    const resultText = truncateToolResult(serializeToolMessageContent(message.content));
    return resultText ? estimateCharUnits(`[Tool result from ${toolName}]: ${resultText}`) : 0;
  }

  return 0;
}

/**
 * Serialized size in estimator char units (wide characters count as one token's worth, not one
 * quarter), matching
 * {@link serializeConversation} (including the `\n\n` segment join).
 */
export function measureSerializedConversationChars(messages: ModelMessage[]): number {
  const toolCallMap = buildToolCallNameMap(messages);
  let chars = 0;
  let segments = 0;
  for (const message of messages) {
    const messageChars = serializedMessageChars(message, toolCallMap);
    if (messageChars > 0) {
      chars += messageChars;
      segments += 1;
    }
  }
  return chars + Math.max(0, segments - 1) * 2;
}

/**
 * Serialize ModelMessage[] to plain text for summarization.
 */
export function serializeConversation(messages: ModelMessage[]): string {
  const parts: string[] = [];
  const toolCallMap = buildToolCallNameMap(messages);

  for (const msg of messages) {
    if (msg.role === "user") {
      const text = extractTextFromContent(msg.content);
      if (text) parts.push(`[User]: ${text}`);
      continue;
    }

    if (msg.role === "assistant") {
      const text = extractTextFromContent(msg.content);
      if (text) parts.push(`[Assistant]: ${text}`);

      if (msg.toolCalls && msg.toolCalls.length > 0) {
        const toolCalls = msg.toolCalls.map((tc) => {
          const args = truncateToolArgs(tc.function.arguments);
          return `${tc.function.name}(${args})`;
        });
        parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
      }
      continue;
    }

    if (msg.role === "tool") {
      const toolName = (msg.toolCallId && toolCallMap.get(msg.toolCallId)) || "tool";
      const resultText = truncateToolResult(serializeToolMessageContent(msg.content));
      if (resultText) {
        parts.push(`[Tool result from ${toolName}]: ${resultText}`);
      }
    }
  }

  return parts.join("\n\n");
}

/**
 * Build labeled summarizer input: history to compress, an optional split-turn
 * prefix (discarded head of an oversized turn), and turns that remain after cut.
 *
 * Segments are emitted in order; empty segments are omitted.
 */
export function buildSegmentedConversationText(
  toCompress: ModelMessage[],
  stillInContext?: ModelMessage[],
  turnPrefix?: ModelMessage[]
): string {
  const parts: string[] = [];

  if (toCompress.length > 0) {
    parts.push(`<to_compress>\n${serializeConversation(toCompress)}\n</to_compress>`);
  }

  if (turnPrefix && turnPrefix.length > 0) {
    parts.push(`<turn_prefix>\n${serializeConversation(turnPrefix)}\n</turn_prefix>`);
  }

  if (stillInContext && stillInContext.length > 0) {
    parts.push(`<still_in_context>\n${serializeConversation(stillInContext)}\n</still_in_context>`);
  }

  return parts.join("\n\n");
}
