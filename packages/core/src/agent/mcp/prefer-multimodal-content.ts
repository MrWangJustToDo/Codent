/**
 * Workaround for @tanstack/ai-mcp dropping MCP `content[]` when `structuredContent` is present.
 *
 * Screenshot-style tools put metadata in structuredContent and images in content[].
 * TanStack's makeMcpExecute prefers structuredContent and discards multimodal content.
 * We resolve results ourselves so vision-capable parts reach the model.
 */

import { isContentPartArray } from "@tanstack/ai";

import type { AnyServerTool, ContentPart } from "@tanstack/ai";
import type { MCPClient } from "@tanstack/ai-mcp";

// ============================================================================
// Types
// ============================================================================

export type McpContentBlock = {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: unknown;
};

export type McpCallToolResult = {
  isError?: boolean;
  content?: McpContentBlock[];
  structuredContent?: unknown;
};

export type TanStackContentPart =
  | { type: "text"; content: string }
  | { type: "image"; source: { type: "data"; value: string; mimeType: string } }
  | { type: "audio"; source: { type: "data"; value: string; mimeType: string } };

const MULTIMODAL_CONTENT_TYPES = new Set(["image", "audio", "video", "resource"]);

// ============================================================================
// Content conversion
// ============================================================================

/** True when MCP content[] includes non-text blocks the model should see as media. */
export function mcpContentHasMultimodal(content: McpContentBlock[] | undefined): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block) => MULTIMODAL_CONTENT_TYPES.has(block.type));
}

/**
 * Convert MCP content blocks to TanStack ContentPart[] (or a single string for text-only).
 * Mirrors @tanstack/ai-mcp mcpContentToTanstack.
 */
export function mcpContentToTanstack(content: McpContentBlock[] | undefined): string | TanStackContentPart[] {
  if (!Array.isArray(content)) return "";
  if (content.length === 1 && content[0]?.type === "text") {
    return content[0].text ?? "";
  }

  const parts: TanStackContentPart[] = [];
  for (const block of content) {
    switch (block.type) {
      case "text":
        parts.push({ type: "text", content: block.text ?? "" });
        break;
      case "image":
        if (typeof block.data === "string" && typeof block.mimeType === "string") {
          parts.push({
            type: "image",
            source: { type: "data", value: block.data, mimeType: block.mimeType },
          });
        }
        break;
      case "audio":
        if (typeof block.data === "string" && typeof block.mimeType === "string") {
          parts.push({
            type: "audio",
            source: { type: "data", value: block.data, mimeType: block.mimeType },
          });
        }
        break;
      case "resource": {
        const uri =
          block.resource && typeof block.resource === "object" && "uri" in block.resource
            ? (block.resource as { uri?: unknown }).uri
            : undefined;
        if (typeof uri === "string" && uri.startsWith("ui://")) {
          break;
        }
        parts.push({ type: "text", content: JSON.stringify(block.resource) });
        break;
      }
      default:
        parts.push({ type: "text", content: JSON.stringify(block) });
    }
  }

  const filtered = parts.filter((part) => !(part.type === "text" && part.content === ""));
  return filtered.length > 0 ? filtered : "";
}

/**
 * Recover multimodal {@link ContentPart}[] from a persisted MCP tool result.
 *
 * Tool results reach `toModelOutput` in their **persisted** form: TanStack's
 * `normalize-stream-chunk` turns `TOOL_CALL_END.result` into
 * `TOOL_CALL_RESULT.content` via `JSON.stringify` whenever the result is an
 * array. So a multimodal MCP result arrives as the JSON text of a ContentPart[]
 * (base64 inline) instead of the array itself.
 */
function coerceMultimodalParts(value: unknown): ContentPart[] | null {
  if (isContentPartArray(value)) return value;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("[{")) return null;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isContentPartArray(parsed)) return parsed;
    } catch {
      // Not JSON — treat as plain text.
    }
  }

  return null;
}

/**
 * Model-facing content for a dynamically created MCP tool.
 *
 * MCP tools are not authored via `defineServerTool`, so they have no
 * `toModelOutput` registered. Without this resolver `applyToolCompact` leaves the
 * persisted string untouched: image base64 stays plain text, the adapter can
 * never lift it into `image_url`, and the model has to fall back to another tool
 * to actually see the media (while re-sending the base64 every turn).
 *
 * Multimodal results are revived to {@link ContentPart}[]; everything else keeps
 * the existing passthrough/JSON-text shape.
 */
export function resolveMcpModelOutput(output: unknown): string | ContentPart[] {
  const parts = coerceMultimodalParts(output);
  if (parts) return parts;

  if (typeof output === "string") return output;
  if (output === undefined || output === null) return "";

  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

/**
 * Prefer multimodal content[] when present; otherwise keep TanStack's structuredContent preference.
 */
export function resolveMcpToolExecuteResult(toolName: string, result: McpCallToolResult): unknown {
  if (result.isError) {
    const text = Array.isArray(result.content) ? mcpContentToTanstack(result.content) : undefined;
    const detail = typeof text === "string" ? text : text === undefined ? undefined : JSON.stringify(text);
    throw new Error(
      !detail ? `MCP tool "${toolName}" returned an error` : `MCP tool "${toolName}" returned an error: ${detail}`
    );
  }

  if (mcpContentHasMultimodal(result.content)) {
    return mcpContentToTanstack(result.content);
  }

  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }

  return mcpContentToTanstack(result.content);
}

function readServerToolName(tool: AnyServerTool): string | undefined {
  const mcp = tool.metadata?.mcp;
  if (!mcp || typeof mcp !== "object") return undefined;
  const name = (mcp as { serverToolName?: unknown }).serverToolName;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

/**
 * Replace TanStack MCP tool execute so multimodal content[] is not discarded.
 */
export function wrapMcpToolForMultimodalContent(tool: AnyServerTool, client: MCPClient): AnyServerTool {
  const serverToolName = readServerToolName(tool);
  if (!serverToolName || typeof tool.execute !== "function") {
    return tool;
  }

  return {
    ...tool,
    execute: async (args, ctx) => {
      ctx?.abortSignal?.throwIfAborted();
      // Forward the run's abort signal: without it, Esc could not reach a slow/hung `tools/call`
      // and the row (and the pump) stayed parked on the server until it finished on its own.
      const result = (await client.callTool(
        serverToolName,
        (args ?? {}) as Record<string, unknown>,
        ctx?.abortSignal ? { signal: ctx.abortSignal } : undefined
      )) as McpCallToolResult;
      return resolveMcpToolExecuteResult(serverToolName, result);
    },
  };
}
