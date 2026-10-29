import { isContentPartArray } from "@tanstack/ai";

import {
  extractToolErrorMessage,
  isPendingToolExecutionResult,
  isToolErrorResult,
} from "../../../runtime-types/tool-error.js";
import { serializeToolMessageContent } from "../message-utils.js";

import type { ContentPart, ModelMessage } from "@tanstack/ai";

/** Normalize tool output for ModelMessage `content` (string or ContentPart[]). */
export function normalizeModelToolContent(result: unknown): string | ContentPart[] {
  if (typeof result === "string") return result;
  if (isContentPartArray(result)) return result;
  if (result === undefined || result === null) return "";
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/** Parse structured tool output from a model tool message for `toModelOutput`. */
export function parseToolMessageOutput(content: ModelMessage["content"]): unknown {
  if (typeof content === "string") {
    try {
      return JSON.parse(content);
    } catch {
      return content;
    }
  }

  if (isContentPartArray(content)) {
    return content;
  }

  if (content === null || content === undefined) {
    return null;
  }

  const serialized = serializeToolMessageContent(content);
  try {
    return JSON.parse(serialized);
  } catch {
    return serialized;
  }
}

/**
 * TanStack `output-error` tool results — see `runtime-types/tool-error.ts`.
 *
 * Re-exported here because the compaction projection is the original consumer; the predicate is
 * defined once, in the low layer, so the UI path (`formatToolOutput` / `getInlineSummary`) uses
 * the same reading.
 */
export { extractToolErrorMessage, isPendingToolExecutionResult, isToolErrorResult };

/** LLM-facing shape for failed tool results (preserves failure semantics). */
export function formatToolErrorForModel(output: unknown): string | ContentPart[] {
  return [{ type: "text", content: `Error: ${extractToolErrorMessage(output)}` }];
}
