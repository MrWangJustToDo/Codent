/**
 * Shared message content utilities for the compaction module.
 *
 * Helpers for TanStack {@link ModelMessage} shape:
 * - assistant tool calls live on `message.toolCalls`
 * - tool results are `role: "tool"` messages with `toolCallId` + `content`
 * - text parts use the `content` field (not legacy `text`)
 */

import { type ContentPart, type ModelMessage, type UIMessage } from "@tanstack/ai";

/** Build toolCallId → tool name from assistant `toolCalls`. */
export function buildToolCallNameMap(messages: ModelMessage[]): Map<string, string> {
  const map = new Map<string, string>();

  for (const message of messages) {
    if (message.role !== "assistant" || !message.toolCalls) continue;
    for (const toolCall of message.toolCalls) {
      map.set(toolCall.id, toolCall.function.name);
    }
  }

  return map;
}

/**
 * Extract text from ModelMessage `content` (string or ContentPart[]).
 * Non-text modalities are replaced with short placeholders.
 */
export function extractTextFromContent(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content;
  if (content === null) return "";
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const part of content) {
    parts.push(describeContentPart(part));
  }
  return parts.filter(Boolean).join("\n");
}

/** Text from the first text part, or the string content directly. */
export function getFirstTextPartContent(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  for (const part of content) {
    if (part.type === "text") return part.content;
  }
  return "";
}

/** Serialize tool-message content to a string for size checks and transcripts. */
export function serializeToolMessageContent(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content;
  if (content === null) return "";
  if (!Array.isArray(content)) {
    try {
      return JSON.stringify(content);
    } catch {
      return "";
    }
  }

  const parts: string[] = [];
  for (const part of content) {
    if (part.type === "text") {
      parts.push(part.content);
    } else {
      parts.push(describeContentPart(part));
    }
  }
  return parts.join("\n");
}

function describeContentPart(part: ContentPart): string {
  switch (part.type) {
    case "text":
      return part.content;
    case "image":
      return "[Image was attached]";
    case "audio":
      return "[Audio was attached]";
    case "video":
      return "[Video was attached]";
    case "document":
      return "[Document was attached]";
    default:
      return "";
  }
}

function findUserMessage(messages: Array<UIMessage | ModelMessage>, from: "first" | "last") {
  if (from === "last") {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!;
      if (message.role === "user") return message;
    }
  } else {
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]!;
      if (message.role === "user") return message;
    }
  }
  return null;
}

/** Text of a user message: `parts` for UIMessage, `content` for ModelMessage. */
function userMessageText(message: UIMessage | ModelMessage): string {
  if ("parts" in message && Array.isArray(message.parts)) {
    return message.parts.map((part) => (part.type === "text" ? part.content : "")).join("\n");
  }
  return extractTextFromContent((message as ModelMessage).content);
}

/** Text of the first user message. */
export const getFirstUserInput = (messages: Array<UIMessage | ModelMessage>) => {
  const item = findUserMessage(messages, "first");
  return item ? userMessageText(item) : "";
};
