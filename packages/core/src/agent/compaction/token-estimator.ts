/**
 * Token Estimator - Estimate token counts for messages.
 *
 * Character-based approximation with a wide-character correction. Latin text is ~4 characters per
 * token; CJK/emoji are ~1 token per character, so counting them at 1/4 kept ~4× the intended
 * window (a 40k `keepRecentTokens` budget retained ~160k real tokens, and the cut could land at or
 * past the trigger it was meant to stay under). A non-ASCII character is therefore counted as
 * {@link CHARS_PER_TOKEN} units, i.e. one token. Handles the TanStack {@link ModelMessage} shape
 * including `toolCalls` and tool messages.
 */

import { estimateImageInputTokens } from "../../models/estimate-image-tokens.js";
import { parseStringifiedMultimodalContent } from "../media/repair-stringified-multimodal.js";

import type { ContentPart, ModelMessage } from "@tanstack/ai";

const CHARS_PER_TOKEN = 4;

/**
 * Length in the estimator's char units: 1 per ASCII character, {@link CHARS_PER_TOKEN} per
 * non-ASCII one. Surrogate pairs count two units each, which over-estimates an emoji slightly —
 * the safe direction for a compaction trigger.
 */
export function estimateCharUnits(text: string): number {
  let units = 0;
  for (let i = 0; i < text.length; i += 1) {
    units += text.charCodeAt(i) < 0x80 ? 1 : CHARS_PER_TOKEN;
  }
  return units;
}

function getStringLength(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return estimateCharUnits(value);
  if (typeof value === "number" || typeof value === "boolean") return estimateCharUnits(String(value));

  try {
    return estimateCharUnits(JSON.stringify(value) ?? "");
  } catch {
    return 0;
  }
}

export function estimateContentPartChars(part: ContentPart): number {
  switch (part.type) {
    case "text": {
      // These parts arrive as `JSON.parse` output, not as typed `ContentPart`s: the loose check that
      // admits them (`isContentPartLike`) accepts `text` as well as `content`. Reading only `content`
      // counted a 100k-character text part as zero when it used the other spelling.
      const text = typeof part.content === "string" ? part.content : (part as { text?: unknown }).text;
      return estimateCharUnits(typeof text === "string" ? text : "");
    }
    case "image":
    case "audio":
    case "video":
    case "document": {
      if (part.source.type === "data") {
        // Vision/document input is not billed like raw base64 text. Approximate tokens
        // then convert back to the estimator's char units (tokens * CHARS_PER_TOKEN).
        //
        // `value` is NOT guaranteed: the loose check admits any `source` object, and this runs inside
        // the wire projection, so a malformed (or hand-edited) part used to throw a TypeError and fail
        // the whole model call. An unmeasurable payload falls back to the coarse placeholder below.
        const value = (part.source as { value?: unknown }).value;
        if (typeof value === "string") {
          const byteLength = Math.floor(value.length * 0.75);
          // Documents/audio/video use the same coarse size brackets as an oversized image.
          return estimateImageInputTokens(byteLength) * CHARS_PER_TOKEN;
        }
      }
      return 1000 * CHARS_PER_TOKEN;
    }
    default:
      return getStringLength(part);
  }
}

/**
 * Approximate character size of message content (tool result or any other role).
 *
 * The ONE content-size reading: `estimateContentPartChars` above decides what a part costs, and every
 * caller that needs "how big is this content" (a tool message's result, or a non-tool message's parts)
 * goes through here. Two implementations of this walked apart once — the local one omitted the
 * non-array `JSON.stringify` fallback, so an object-shaped content contributed 0 chars.
 */
export function getMessageContentSize(content: ModelMessage["content"]): number {
  if (typeof content === "string") {
    // A tool result that carries media arrives as `JSON.stringify(ContentPart[])` until `tool-compact`
    // projects it — and compaction runs BEFORE that stage, so the estimator used to count a 300 KB
    // image's base64 as text: ~100k tokens for one picture. That consumed the whole keep budget (the
    // cut landed on the image message and everything older was summarized) and blew up
    // `stillTokens`, splitting one compaction into dozens of paid summarizer calls.
    //
    // The parser is a `"[{"` prefix test for prose, so the common case pays nothing.
    const media = parseStringifiedMultimodalContent(content);
    if (media) {
      let size = 0;
      for (const part of media) size += estimateContentPartChars(part as ContentPart);
      return size;
    }
    return estimateCharUnits(content);
  }
  if (content === null) return 0;
  if (!Array.isArray(content)) {
    try {
      return estimateCharUnits(JSON.stringify(content) ?? "");
    } catch {
      return 0;
    }
  }

  let size = 0;
  for (const part of content) {
    size += estimateContentPartChars(part);
  }
  return size;
}

function estimateToolCallsChars(toolCalls: ModelMessage["toolCalls"]): number {
  if (!toolCalls || toolCalls.length === 0) return 0;

  let total = 0;
  for (const toolCall of toolCalls) {
    total += getStringLength(toolCall.function.name);
    total += getStringLength(toolCall.function.arguments);
    total += 20;
  }
  return total;
}

function estimateThinkingChars(thinking: ModelMessage["thinking"]): number {
  if (!thinking || thinking.length === 0) return 0;
  return thinking.reduce((sum, entry) => sum + getStringLength(entry.content), 0);
}

/**
 * Estimate token count for a single TanStack ModelMessage.
 */
export function estimateMessageTokens(message: ModelMessage): number {
  let chars = message.role.length + 10;

  if (message.role === "tool") {
    chars += getMessageContentSize(message.content);
    chars += getStringLength(message.toolCallId);
  } else {
    chars += getMessageContentSize(message.content);
    if (message.role === "assistant") {
      chars += estimateToolCallsChars(message.toolCalls);
      chars += estimateThinkingChars(message.thinking);
    }
  }

  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Estimate total token count for an array of messages.
 */
export function estimateTokens(messages: ModelMessage[]): number {
  if (!messages || messages.length === 0) return 0;

  let total = 0;
  for (const message of messages) {
    total += estimateMessageTokens(message);
  }

  total += messages.length * 3;
  return total;
}
