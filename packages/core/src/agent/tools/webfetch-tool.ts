/**
 * WebFetch Tool - Fetches web content and converts to various formats.
 *
 * This tool fetches content from URLs and can:
 * - Return raw HTML
 * - Convert HTML to Markdown (default)
 * - Extract plain text from HTML
 * - Handle images by returning base64 data
 *
 * Based on OpenCode's webfetch implementation.
 */

import { z } from "zod";

import { getEnv } from "../../env";
import { isAbortError } from "../../runtime-types/abort.js";

import { defineServerTool } from "./runtime/define-tool.js";
import { createTimeoutAbort } from "./util/abort-timeout.js";
import { maybeCacheOutput } from "./util/tool-output-cache.js";
import { withDuration } from "./util/tool-result.js";
import { toolOutputBaseSchema } from "./util/types.js";
import { convertHTMLToMarkdown, extractTextFromHTML } from "./util/webfetch-html.js";

import type { ManagedAgent } from "../../runtime-types/hosts.js";

// ============================================================================
// Constants
// ============================================================================

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_CONTENT_CHARS = 100000; // ~100KB, roughly 25k tokens
const DEFAULT_TIMEOUT = 30; // 30 seconds
const MAX_TIMEOUT = 120; // 2 minutes

/**
 * Build Accept header based on requested format
 */
function buildAcceptHeader(format: string): string {
  switch (format) {
    case "markdown":
      return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
    case "text":
      return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
    case "html":
      return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1";
    default:
      return "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8";
  }
}

// ============================================================================
// Output Schema
// ============================================================================

export const webfetchOutputSchema = z.object({
  /** The URL that was fetched */
  url: z.string().describe("The URL that was fetched"),
  /** Content type of the response */
  contentType: z.string().describe("The Content-Type header of the response"),
  /** The fetched content in the requested format */
  content: z.string().describe("The fetched content in the requested format"),
  /** Length of the content in characters */
  contentLength: z.number().describe("Length of the content in characters"),
  /** Whether the content is an image (base64 encoded) */
  isImage: z.boolean().describe("Whether the content is an image"),
  /** Whether the content was truncated due to size limits */
  truncated: z.boolean().describe("Whether content was truncated due to size limits"),
  /** Present when the USER aborted the run mid-fetch; see `runCommandOutputSchema.cancelled`. */
  cancelled: z.boolean().optional().describe("True when the user aborted the run while this fetch was in flight."),
  /** Execution duration in milliseconds */
  durationMs: z.number().describe("Execution duration in milliseconds"),
  ...toolOutputBaseSchema.shape,
});

export type WebfetchOutput = z.infer<typeof webfetchOutputSchema>;

// ============================================================================
// Tool Factory
// ============================================================================

/**
 * Creates a webfetch tool for fetching web content.
 *
 * Unlike the simpler fetch-url tool which uses curl, this tool:
 * - Uses native fetch API
 * - Converts HTML to Markdown by default
 * - Handles images by returning base64 data
 * - Has better content type handling
 *
 * @example
 * ```typescript
 * const webfetchTool = createWebfetchTool();
 * ```
 */
export const createWebfetchTool = ({ managed }: { managed?: ManagedAgent } = {}) => {
  return defineServerTool({
    name: "webfetch",
    present: { category: "searches" },
    description: `Fetches content from a URL and returns it in the specified format.

Use this tool when you need to:
- Read documentation from the web
- Fetch API responses
- Download and analyze web page content
- Get content from GitHub, Stack Overflow, or other web resources

Features:
- Converts HTML to Markdown by default (cleaner for reading)
- Can return raw HTML or plain text
- Handles images by returning base64-encoded data
- Follows redirects automatically
- Has a 5MB size limit

Usage notes:
- The URL must start with http:// or https://
- Format options: "markdown" (default), "text", or "html"
- Timeout defaults to 30 seconds, max 120 seconds
- For large pages, content may be truncated`,

    inputSchema: z.object({
      url: z.string().describe("The URL to fetch content from. Must start with http:// or https://"),
      format: z
        .enum(["text", "markdown", "html"])
        .default("markdown")
        .describe("The format to return content in. Defaults to markdown."),
      timeout: z
        .number()
        .int({ message: "timeout: must be an integer (seconds)" })
        .min(1, { message: "timeout: must be >= 1 second" })
        .max(MAX_TIMEOUT, { message: "timeout: must be <= 120 seconds" })
        .optional()
        .describe(`Timeout in seconds (1-${MAX_TIMEOUT}). Defaults to ${DEFAULT_TIMEOUT}.`),
    }),

    outputSchema: webfetchOutputSchema,

    execute: async ({ url, format, timeout }, { abortSignal, toolCallId }) => {
      return withDuration(async () => {
        // Validate URL
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
          throw new Error("URL must start with http:// or https://");
        }

        const timeoutMs = Math.min((timeout ?? DEFAULT_TIMEOUT) * 1000, MAX_TIMEOUT * 1000);

        // Timeout + run-abort linked through the shared helper (one deadline implementation).
        // The reason matters: a bare `abort()` makes `fetch` reject with the platform
        // `AbortError`, which `isAbortError` accepts by `name` alone — so a 30s timeout was
        // reported to the model as `[Fetch cancelled by user.]`.
        const { controller, cleanup: cleanupAbort } = createTimeoutAbort({ timeoutMs, signal: abortSignal });

        const managedAgent = managed;

        const hasParentAgent = managedAgent?.parentId;

        try {
          if (!hasParentAgent) {
            managedAgent?.addPendingAbortController(controller);
          }

          const headers = {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
            Accept: buildAcceptHeader(format ?? "markdown"),
            "Accept-Language": "en-US,en;q=0.9",
          };

          const envFetch = getEnv().fetch;

          let response = await envFetch(url, {
            signal: controller.signal,
            headers,
            redirect: "follow",
          });

          // Retry with honest UA if blocked by Cloudflare bot detection
          if (response.status === 403 && response.headers.get("cf-mitigated") === "challenge") {
            response = await envFetch(url, {
              signal: controller.signal,
              headers: { ...headers, "User-Agent": "codent-webfetch" },
              redirect: "follow",
            });
          }

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }

          // Check content length
          const contentLengthHeader = response.headers.get("content-length");
          if (contentLengthHeader && parseInt(contentLengthHeader) > MAX_RESPONSE_SIZE) {
            throw new Error(`Response too large: ${contentLengthHeader} bytes (limit: ${MAX_RESPONSE_SIZE})`);
          }

          const arrayBuffer = await response.arrayBuffer();
          if (arrayBuffer.byteLength > MAX_RESPONSE_SIZE) {
            throw new Error(`Response too large: ${arrayBuffer.byteLength} bytes (limit: ${MAX_RESPONSE_SIZE})`);
          }

          const contentType = response.headers.get("content-type") || "text/plain";
          const mime = contentType.split(";")[0]?.trim().toLowerCase() || "text/plain";

          // Handle images
          const isImage = mime.startsWith("image/") && mime !== "image/svg+xml";
          if (isImage) {
            const base64Content = getEnv().base64Encode(new Uint8Array(arrayBuffer));
            return {
              url,
              contentType,
              content: `data:${mime};base64,${base64Content}`,
              contentLength: base64Content.length,
              isImage: true,
              truncated: false,
              cachedOutputPath: null,
            };
          }

          // Decode text content
          const rawContent = new TextDecoder().decode(arrayBuffer);

          // Convert content based on requested format
          let content: string;
          switch (format) {
            case "markdown":
              if (contentType.includes("text/html")) {
                content = convertHTMLToMarkdown(rawContent);
              } else {
                content = rawContent;
              }
              break;

            case "text":
              if (contentType.includes("text/html")) {
                content = extractTextFromHTML(rawContent);
              } else {
                content = rawContent;
              }
              break;

            case "html":
            default:
              content = rawContent;
              break;
          }

          // Cache large content to disk instead of inline truncation
          const originalLength = content.length;
          let cachedOutputPath: string | null = null;
          let truncated = false;

          if (content.length > MAX_CONTENT_CHARS) {
            const cached = await maybeCacheOutput(content, `${toolCallId}-webfetch`);
            content = cached.content;
            cachedOutputPath = cached.cachedOutputPath;
            truncated = cachedOutputPath !== null;
          }

          return {
            url,
            contentType,
            content,
            contentLength: originalLength,
            isImage: false,
            truncated,
            cachedOutputPath,
          };
        } catch (err) {
          // The user aborting is not a fetch failure. Uncaught, the abort surfaces as a throw
          // and TanStack settles the row as `output-error` — a red cross on something the user
          // stopped. Same contract as run_command: return normally with `cancelled: true`.
          if (!isAbortError(err, abortSignal)) throw err;
          return {
            url,
            contentType: "text/plain",
            content: "",
            contentLength: 0,
            isImage: false,
            truncated: false,
            cancelled: true,
            cachedOutputPath: null,
          };
        } finally {
          cleanupAbort();
          if (!hasParentAgent) {
            managedAgent?.removePendingAbortController(controller);
          }
        }
      });
    },
    // Only send url + content (or multimodal image parts) to the LLM —
    // contentType/contentLength/isImage/truncated/cachedOutputPath are UI metadata.
    toModelOutput({ output }: { toolCallId: string; input: unknown; output: z.infer<typeof webfetchOutputSchema> }) {
      // A cancelled fetch has no content; without this the model reads an empty successful
      // fetch of the URL. Same contract as the task tool's cancel notice.
      if (output.cancelled) {
        return [{ type: "text" as const, content: `[Fetch cancelled by user.] ${output.url}` }];
      }
      if (output.isImage) {
        const parsed = parseDataUrl(output.content);
        if (parsed) {
          return [
            { type: "text" as const, content: `Fetched image: ${output.url}` },
            {
              type: "image" as const,
              source: { type: "data" as const, value: parsed.base64, mimeType: parsed.mimeType },
            },
          ];
        }
        // Fallback: keep prior text behavior if content is not a data URL
        return [{ type: "text" as const, content: `Fetched image: ${output.url}\n\n${output.content}` }];
      }
      return [{ type: "text" as const, content: `Fetched ${output.url}\n\n${output.content}` }];
    },
  });
};

function parseDataUrl(content: string): { mimeType: string; base64: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(content);
  if (!match) return null;
  const mimeType = match[1]?.trim();
  const base64 = match[2];
  if (!mimeType || !base64) return null;
  return { mimeType, base64 };
}
