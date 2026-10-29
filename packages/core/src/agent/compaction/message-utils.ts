/**
 * Compaction-local message helpers.
 *
 * The content readers themselves (`extractTextFromContent` / `describeContentPart`) live in
 * `utils/message-content.ts`: `agent/memory`, `agent/turn-context` and `agent-session` read the same
 * TanStack `content` field, and `agent-session` must not depend on compaction for a leaf helper.
 *
 * What stays here is about turning messages into a compact transcript:
 * - assistant tool calls live on `message.toolCalls`
 * - tool results are `role: "tool"` messages with `toolCallId` + `content`
 * - text parts use the `content` field (not legacy `text`)
 */

import { describeContentPart, extractTextFromContent } from "../../utils/message-content.js";

import type { ModelMessage, UIMessage } from "@tanstack/ai";

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
