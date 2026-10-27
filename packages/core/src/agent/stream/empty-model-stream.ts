import { findLastMeaningfulAssistant } from "./empty-assistant-shell.js";

import type { ToolCallPart, UIMessage } from "@tanstack/ai";

/**
 * Shown when a chat() stream finishes without abort/error but also without any
 * model output. Common cause: OpenAI-compatible streaming against an SSO/HTML
 * page (HTTP 200) yields zero chunks and does not throw.
 */
export const EMPTY_MODEL_STREAM_MESSAGE =
  "Model returned an empty stream. Check provider URL, API key, and network/SSO access.";

function partTextLen(part: { type?: string; content?: unknown }): number {
  if (part.type !== "text") return 0;
  return typeof part.content === "string" ? part.content.trim().length : 0;
}

function thinkingLen(part: { type?: string; content?: unknown }): number {
  if (part.type !== "thinking") return 0;
  return typeof part.content === "string" ? part.content.length : 0;
}

/** Compact signature of assistant progress (text / tools / thinking). */
export function assistantProgressSignature(message: UIMessage): string {
  return message.parts
    .map((part) => {
      if (part.type === "text") return `t:${partTextLen(part)}`;
      if (part.type === "thinking") return `h:${thinkingLen(part)}`;
      if (part.type === "tool-call") {
        const tool = part as ToolCallPart;
        return `c:${tool.id}:${tool.state}:${tool.output !== undefined ? "1" : "0"}`;
      }
      if (part.type === "tool-result") {
        return `r:${part.toolCallId}:${part.state}`;
      }
      return part.type;
    })
    .join("|");
}

/**
 * Whether the stream advanced model-visible state (new/updated assistant text,
 * tool calls, or tool results). Used to catch SDK "empty success" streams.
 */
export function didStreamProduceModelOutput(before: UIMessage[], after: UIMessage[]): boolean {
  const beforeAssistant = findLastMeaningfulAssistant(before);
  const afterAssistant = findLastMeaningfulAssistant(after);

  if (!afterAssistant) return false;
  if (!beforeAssistant) return true;
  if (beforeAssistant.id !== afterAssistant.id) return true;

  return assistantProgressSignature(beforeAssistant) !== assistantProgressSignature(afterAssistant);
}

/**
 * Whether this chat() invocation was expected to produce model output.
 * Skips nothing by default — even tool-phase continues must advance tool state.
 * Callers should still skip when the run was aborted.
 */
export function shouldFlagEmptyModelStream(before: UIMessage[], after: UIMessage[]): boolean {
  // `findLastMeaningfulAssistant` already skips trailing empty shells, so filtering `after` here
  // would change neither lookup nor the id comparison (and `before` was never filtered).
  return !didStreamProduceModelOutput(before, after);
}
