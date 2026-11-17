/**
 * The text a projection reads OFF a stored transcript (as opposed to the wire).
 *
 * They live in one place because three projections need the same answer to "what does this message
 * say": the message cursor (how much was already sent), the compaction row (`[CONVERSATION SUMMARY]`
 * body), and a `task` result (either persisted shape).
 */

import { toolResultText } from "./tools.js";

import type { UIMessage } from "@tanstack/ai";

/** The concatenated assistant text of one message. */
export function textOf(message: UIMessage): string {
  return message.parts
    .filter((part): part is { type: "text"; content: string } => part.type === "text")
    .map((part) => part.content)
    .join("");
}

/** The concatenated thinking of one message. */
export function thoughtOf(message: UIMessage): string {
  return message.parts
    .filter((part): part is { type: "thinking"; content: string } => part.type === "thinking")
    .map((part) => part.content)
    .join("");
}

/**
 * A task result from either persisted shape: the call part's `output`, or the result part's raw-JSON
 * `content` (older sessions persist no `output`). Anything that is not a JSON object stays unknown,
 * so a non-task payload is never guessed into a task result.
 */
export function taskOutputOf(part: { output?: unknown; content?: unknown }): unknown {
  if (part.output !== undefined) return part.output;
  const text = typeof part.content === "string" ? part.content : toolResultText(part.content);
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}
