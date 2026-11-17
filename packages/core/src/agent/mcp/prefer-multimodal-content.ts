/**
 * Workaround for @tanstack/ai-mcp dropping MCP `content[]` when `structuredContent` is present.
 *
 * Screenshot-style tools put metadata in structuredContent and images in content[].
 * TanStack's makeMcpExecute prefers structuredContent and discards multimodal content.
 * We resolve results ourselves so vision-capable parts reach the model.
 *
 * ## Which blocks become media parts
 *
 * `image` / `audio` / `video` blocks, and a `resource` block carrying a base64 `blob`, become
 * {@link TanStackContentPart}s — the only shape the persistence walk can move into `.agents/media/`
 * (see `agent/media/media-utils.ts`). A blob whose MIME no model input modality accepts (zip, docx,
 * svg, octet-stream…) is described instead of inlined: the base64 was both unreadable to the model
 * and a large inline payload in the session log.
 */

import { isContentPartArray } from "@tanstack/ai";
import { isMCPInputRequiredError } from "@tanstack/ai-mcp";

import { toError } from "../../utils/errors.js";
import { parseStringifiedContentParts } from "../../utils/stringified-content-parts.js";
import { mediaPartTypeForMime } from "../media/types.js";

import type { MultimodalPartType } from "../../utils/multimodal-part-types.js";
import type { AnyServerTool, ContentPart } from "@tanstack/ai";
import type { MCPInputRequiredError, MCPClient } from "@tanstack/ai-mcp";

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
  | {
      type: MultimodalPartType;
      source: { type: "data"; value: string; mimeType: string };
    };

const MULTIMODAL_CONTENT_TYPES = new Set(["image", "audio", "video", "resource"]);

// ============================================================================
// Content conversion
// ============================================================================

/** A `resource` block's payload — the spec allows `text` or a base64 `blob`. */
interface McpResourcePayload {
  uri?: unknown;
  mimeType?: unknown;
  text?: unknown;
  blob?: unknown;
}

function resourceOf(value: unknown): McpResourcePayload | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as McpResourcePayload;
}

/**
 * Media part for a `resource` blob, or `null` when it is not one a model can take.
 * `source.type: "data"` mirrors the block: a blob is base64 with no data-URL prefix.
 */
function resourceMediaPart(resource: McpResourcePayload): TanStackContentPart | null {
  const { blob, mimeType } = resource;
  if (typeof blob !== "string" || blob.length === 0 || typeof mimeType !== "string") return null;
  const type = mediaPartTypeForMime(mimeType);
  if (!type) return null;
  return { type, source: { type: "data", value: blob, mimeType } };
}

/** `uri (mime, ~N bytes)` — the identity line every resource form starts from. */
function resourceIdentity(resource: McpResourcePayload): string {
  const uri = typeof resource.uri === "string" ? resource.uri : "(no uri)";
  const mimeType = typeof resource.mimeType === "string" ? resource.mimeType : "unknown type";
  const approxBytes = base64ByteCount(resource.blob);
  const size = approxBytes === undefined ? "" : `, ~${approxBytes} bytes`;
  return `${uri} (${mimeType}${size})`;
}

/** Decoded size of a base64 payload, without decoding it. */
function base64ByteCount(value: unknown): number | undefined {
  return typeof value === "string" ? Math.floor((value.length * 3) / 4) : undefined;
}

function blockName(kind: string): string {
  return kind === "resource" ? "Resource" : `${kind.slice(0, 1).toUpperCase()}${kind.slice(1)}`;
}

/**
 * One line standing in for a payload this runtime does not send as media.
 *
 * Names what the file is and how big it is, so the model knows a payload exists and why its bytes
 * are absent. The base64 stays out of the transcript — and out of the session log, where the same
 * payload used to sit inline as JSON text that no media walk could reach.
 */
function describeNotInlined(params: { kind: string; uri?: unknown; mimeType?: unknown; value?: unknown }): string {
  const { kind, uri, mimeType, value } = params;
  const location = typeof uri === "string" && uri.length > 0 ? ` ${uri}` : "";
  const type = typeof mimeType === "string" && mimeType.length > 0 ? mimeType : "unknown type";
  const bytes = base64ByteCount(value);
  const size = bytes === undefined ? "" : `, ~${bytes} bytes`;
  return `[${blockName(kind)} not inlined:${location} (${type}${size}). Its base64 payload is not turned into model-facing content; read it through its own server if the contents matter.]`;
}

/**
 * Push the media part for one block's inline `data`, or a placeholder saying why it is not one.
 *
 * A part type the provider cannot take fails the whole request, so anything the shape does not
 * cleanly support is described instead: a block with no `mimeType` (required by the spec, so the
 * block is malformed), an `image/svg+xml` payload, and a MIME whose modality contradicts the block's
 * own `type` (an `image` block carrying a PDF). Dropping such a block silently — which is what the
 * old `data && mimeType` guard did for `audio` / `video` — hid the payload from the model entirely.
 */
function pushInlinePayload(parts: TanStackContentPart[], block: McpContentBlock): void {
  const { data, mimeType } = block;
  if (typeof data !== "string" || data.length === 0) return;
  const partType = typeof mimeType === "string" ? mediaPartTypeForMime(mimeType) : null;
  if (typeof mimeType !== "string" || partType === null || partType !== block.type) {
    parts.push({ type: "text", content: describeNotInlined({ kind: block.type, mimeType, value: data }) });
    return;
  }
  parts.push({ type: partType, source: { type: "data", value: data, mimeType } });
}

/** True when MCP content[] includes non-text blocks the model should see as media. */
export function mcpContentHasMultimodal(content: McpContentBlock[] | undefined): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block) => MULTIMODAL_CONTENT_TYPES.has(block.type));
}

/**
 * Convert MCP content blocks to TanStack ContentPart[] (or a single string for text-only).
 *
 * Starts from `@tanstack/ai-mcp`'s `mcpContentToTanstack` and deliberately goes further: that one
 * maps `text` / `image` / `resource` only, so an `audio` or `video` block and a `resource` blob
 * would have arrived as JSON text with the base64 still inline (unreadable on the wire, unbounded in
 * the session log).
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
      case "audio":
      case "video":
        pushInlinePayload(parts, block);
        break;
      case "resource": {
        const resource = resourceOf(block.resource);
        const uri = resource?.uri;
        if (typeof uri === "string" && uri.startsWith("ui://")) {
          break;
        }

        const hasBlob = typeof resource?.blob === "string" && resource.blob.length > 0;
        const mediaPart = resource && hasBlob ? resourceMediaPart(resource) : null;
        if (resource && mediaPart) {
          // The media part is paired with a line naming the file, like `read_file` does: a host with
          // no viewer for this modality would otherwise render the result as an empty row, and the
          // model would learn nothing about where the bytes came from.
          parts.push({ type: "text", content: `Resource: ${resourceIdentity(resource)}` });
          // The spec says `text` XOR `blob`; a server sending both meant the text to be readable, and
          // it is the cheap half to keep alongside the media part.
          if (typeof resource.text === "string" && resource.text.length > 0) {
            parts.push({ type: "text", content: resource.text });
          }
          parts.push(mediaPart);
          break;
        }

        if (resource && hasBlob) {
          parts.push({
            type: "text",
            content: describeNotInlined({ kind: "resource", uri, mimeType: resource.mimeType, value: resource.blob }),
          });
          break;
        }

        parts.push({ type: "text", content: JSON.stringify(block.resource) });
        break;
      }
      default:
        // A block type this runtime does not know (a spec addition, an embedded `resource_link`).
        // Shape decides: base64 that would otherwise land in the transcript as JSON text is
        // described, a metadata-only block keeps the JSON form that makes it readable.
        parts.push({
          type: "text",
          content:
            typeof block.data === "string" && block.data.length > 0
              ? describeNotInlined({ kind: block.type, mimeType: block.mimeType, value: block.data })
              : JSON.stringify(block),
        });
    }
  }

  const filtered = parts.filter((part) => !(part.type === "text" && part.content === ""));
  return filtered.length > 0 ? filtered : "";
}

/**
 * Recover multimodal {@link ContentPart}[] from a persisted MCP tool result.
 *
 * Two persisted forms exist and both are accepted here. `@tanstack/ai` **1.0.1**'s
 * `StreamProcessor` parses `TOOL_CALL_RESULT.content` back into a `ContentPart[]` (only the wire
 * chunk is stringified), so a current session hands the array straight over. Sessions written by an
 * older runtime, and any path that re-serialized the result, carry the JSON text of that array
 * instead — same payload, base64 inline either way. The text form is parsed by the shared
 * `parseStringifiedContentParts` and then strict-checked with `isContentPartArray`, because these
 * parts go to the wire.
 */
function coerceMultimodalParts(value: unknown): ContentPart[] | null {
  if (isContentPartArray(value)) return value;

  if (typeof value === "string") {
    const parsed = parseStringifiedContentParts(value);
    if (parsed && isContentPartArray(parsed)) return parsed;
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
 * Text of a converted result, without any binary payload.
 *
 * The message becomes the tool's persisted error string, so a media part contributes its modality,
 * never its base64 — the same rule the success path follows.
 */
function describeModelContent(content: string | TanStackContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.content : `[${part.type} not inlined]`))
    .join("\n")
    .trim();
}

/**
 * Prefer multimodal content[] when present; otherwise keep TanStack's structuredContent preference.
 */
export function resolveMcpToolExecuteResult(toolName: string, result: McpCallToolResult): unknown {
  if (result.isError) {
    const detail = Array.isArray(result.content) ? describeModelContent(mcpContentToTanstack(result.content)) : "";
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
 * Describe a server's request for user input as a tool failure the model can act on.
 *
 * `@tanstack/ai-mcp` converts a spec-2026 `input_required` result into
 * `MCPInputRequiredError`; without this mapping it reaches the model as a generic tool failure
 * whose only content is the SDK's internal wording, which names neither the server nor the request.
 * Throwing (rather than returning text) is deliberate: a returned string would be recorded as a
 * successful call, and the model would believe the action happened.
 */
export function describeInputRequired(serverToolName: string, error: MCPInputRequiredError): string {
  let body: string;
  try {
    body = JSON.stringify(error.request ?? null);
  } catch {
    body = String(error.request);
  }
  if (error.kind === "sampling") {
    return `MCP tool "${serverToolName}" asked for a model sampling request, which this runtime cannot answer. Request: ${body}`;
  }
  return `MCP tool "${serverToolName}" needs user input before it can continue — ask the user, then retry. Request: ${body}`;
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
      let result: McpCallToolResult;
      try {
        result = (await client.callTool(
          serverToolName,
          (args ?? {}) as Record<string, unknown>,
          ctx?.abortSignal ? { signal: ctx.abortSignal } : undefined
        )) as McpCallToolResult;
      } catch (error) {
        // A server that needs input mid-call is not a generic tool failure: name the server and
        // keep the request so the model can ask the user (or report the sampling gap) instead of
        // retrying blind. Every other error keeps its original shape.
        if (isMCPInputRequiredError(error)) throw new Error(describeInputRequired(serverToolName, error));
        throw toError(error);
      }
      return resolveMcpToolExecuteResult(serverToolName, result);
    },
  };
}
