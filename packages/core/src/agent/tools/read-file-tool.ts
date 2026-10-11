import { z } from "zod";

import { getEnv } from "../../env";
import { estimateImageInputTokens, tryReadImageDimensions } from "../../models/estimate-image-tokens.js";

import { defineServerTool } from "./runtime/define-tool.js";
import { extractPdfText } from "./util/extract-pdf-text.js";
import { formatReadFileToolResult } from "./util/format-read-file-result.js";
import { detectReadFileType, isBinaryContent } from "./util/read-file-detect.js";
import { getFile, withDuration } from "./util/tool-result.js";
import { toolOutputBaseSchema } from "./util/types.js";

import type { FileStat } from "../../env/types";
import type { UsageTracker } from "../../runtime-types/hosts.js";

// ============================================================================
// Constants
// ============================================================================

/** Maximum characters for text file content (to prevent context overflow) */
const MAX_CONTENT_LENGTH = 100000; // ~100KB, roughly 25k tokens

/** Maximum bytes for binary files (PDFs) */
const MAX_BINARY_SIZE = 10 * 1024 * 1024; // 10MB

/** Default line limit when not specified */
const DEFAULT_LINE_LIMIT = 2000;

/** Maximum characters per line before truncation */
const MAX_LINE_LENGTH = 2000;

/** Characters per token for budget estimation */
const CHARS_PER_TOKEN = 4;

// ============================================================================
// Output Schema
// ============================================================================

export const readFileOutputSchema = z.discriminatedUnion("type", [
  // Text file output
  z.object({
    type: z.literal("text"),
    path: z.string().describe("The file path that was read."),
    content: z.string().describe("The file content with line numbers."),
    totalLines: z.number().describe("Total number of lines in the file."),
    startLine: z.number().describe("Starting line number (1-indexed)."),
    endLine: z.number().describe("Ending line number (inclusive)."),
    truncated: z.boolean().describe("Whether content was truncated."),
    durationMs: z.number().describe("Execution duration in milliseconds."),
    ...toolOutputBaseSchema.shape,
  }),
  // Directory output
  z.object({
    type: z.literal("directory"),
    path: z.string().describe("The directory path that was read."),
    entries: z.array(z.string()).describe("List of entries (files and directories)."),
    totalEntries: z.number().describe("Total number of entries."),
    truncated: z.boolean().describe("Whether entries were truncated."),
    durationMs: z.number().describe("Execution duration in milliseconds."),
    ...toolOutputBaseSchema.shape,
  }),
  // Image output
  z.object({
    type: z.literal("image"),
    path: z.string().describe("The image file path."),
    mimeType: z.string().describe("MIME type of the image."),
    base64: z.string().describe("Base64 encoded image data."),
    size: z.number().describe("File size in bytes."),
    durationMs: z.number().describe("Execution duration in milliseconds."),
    ...toolOutputBaseSchema.shape,
  }),
  // PDF output
  z.object({
    type: z.literal("pdf"),
    path: z.string().describe("The PDF file path."),
    base64: z.string().describe("Base64 encoded PDF data."),
    size: z.number().describe("File size in bytes."),
    /** Plain-text layer when extractable (Completions-friendly). */
    extractedText: z.string().optional().describe("Extracted PDF text when available."),
    pageCount: z.number().int().optional().describe("Number of PDF pages when known."),
    durationMs: z.number().describe("Execution duration in milliseconds."),
    ...toolOutputBaseSchema.shape,
  }),
]);

export type ReadFileOutput = z.infer<typeof readFileOutputSchema>;

// ============================================================================
// Tool Factory
// ============================================================================

/**
 * Creates a read-file tool for reading file and directory contents.
 *
 * This tool reads file contents and supports multiple file types:
 * - Text files: Returns content with line numbers, supports offset/limit pagination
 * - Directories: Returns list of entries
 * - Images: Returns base64 encoded data for LLM vision capabilities
 * - PDFs: Returns base64 encoded data for document analysis
 * - Binary files: Returns error (cannot read binary files)
 */
export const createReadFileTool = ({ usage }: { usage?: UsageTracker } = {}) => {
  const getRemainingTokenBudget = (): number => {
    if (!usage) return Infinity;
    const limit = usage.getTokenLimit();
    if (limit <= 0) return Infinity;
    // Context fill, not the raw input field — an exclusive-cache upstream reports only the
    // cache-miss part there, which would vastly overstate the remaining budget.
    const used = usage.getContextFillTokens();
    return Math.max(0, Math.floor((limit - used) * 0.8));
  };

  return defineServerTool({
    name: "read_file",
    present: { category: "reads" },
    description: `Read the contents of a file or directory.

Supports multiple file types:
- **Text files**: Returns content with line numbers. Use offset/limit for large files.
- **Directories**: Returns list of entries (files and subdirectories).
- **Images** (.png, .jpg, .jpeg, .gif, .webp): Returns image for visual analysis.
- **PDFs**: Returns PDF document for analysis.
- **Binary files**: Cannot be read (audio, video, archives, executables, etc.)

For text files, each line is prefixed with its line number (1-indexed).
Use the offset parameter to read from a specific line, and limit to control how many lines to read.

IMPORTANT: Reading images adds significant data to context. Avoid reading more than 2-3 images in a single turn. If you need to process many images, do them in separate turns.`,

    inputSchema: z.object({
      path: z.string().describe("The path to the file or directory to read, relative to the project root."),
      offset: z
        .number()
        .int({ message: "offset: must be an integer" })
        .min(1, { message: "offset: must be >= 1 (1-indexed)" })
        .optional()
        .describe("The line number to start reading from (1-indexed). Only for text files. Defaults to 1."),
      limit: z
        .number()
        .int({ message: "limit: must be an integer" })
        .min(1, { message: "limit: must be >= 1" })
        .optional()
        .describe(
          "The maximum number of lines to read. Only for text files. Defaults to 2000. Use smaller values for targeted reading."
        ),
    }),

    execute: async ({ path: filePath, offset, limit }) => {
      const result = await withDuration(async () => {
        const fsys = getEnv().fs;

        // Check if file/directory exists
        const exists = await fsys.exists(filePath);
        if (!exists) {
          // Try to find similar files for suggestion
          const envPath = getEnv().path;
          const dir = envPath.dirname(filePath);
          const base = envPath.basename(filePath).toLowerCase();
          let suggestion = "";

          try {
            const dirExists = await fsys.exists(dir);
            if (dirExists) {
              const entries = await fsys.readdir(dir);
              const similar = entries
                .filter((e) => e.name.toLowerCase().includes(base) || base.includes(e.name.toLowerCase().split(".")[0]))
                .slice(0, 3)
                .map((e) => envPath.join(dir, e.name));

              if (similar.length > 0) {
                suggestion = `\n\nDid you mean one of these?\n${similar.join("\n")}`;
              }
            }
          } catch {
            // Ignore errors when looking for suggestions
          }

          throw new Error(`File not found: ${filePath}${suggestion}`);
        }

        // Get file stats if available
        let stat: FileStat | undefined;
        if (fsys.stat) {
          try {
            stat = await fsys.stat(filePath);
          } catch {
            // stat not available, continue without it
          }
        }

        // Detect file type
        const fileTypeInfo = await detectReadFileType(filePath, stat);

        // Handle directory
        if (fileTypeInfo.type === "directory") {
          const entries = await fsys.readdir(filePath);
          const sortedEntries = entries
            .map((e) => (e.type === "directory" ? `${e.name}/` : e.name))
            .sort((a, b) => a.localeCompare(b));

          const startIdx = (offset ?? 1) - 1;
          const effectiveLimit = limit ?? DEFAULT_LINE_LIMIT;
          const slicedEntries = sortedEntries.slice(startIdx, startIdx + effectiveLimit);
          const truncated = startIdx + slicedEntries.length < sortedEntries.length;

          return {
            type: "directory" as const,
            path: filePath,
            entries: slicedEntries,
            totalEntries: sortedEntries.length,
            truncated,
          };
        }

        // Handle binary files (error)
        if (fileTypeInfo.type === "binary") {
          throw new Error(
            `Cannot read binary file: ${filePath}. This tool cannot read binary files like audio, video, archives, or executables.`
          );
        }

        // Handle images
        if (fileTypeInfo.type === "image") {
          // Skip image data if model doesn't support vision
          if (usage && !usage.hasCapability("vision")) {
            throw new Error(
              `Cannot analyze image: ${filePath} (${fileTypeInfo.mimeType}). The current model does not support vision — image content cannot be read.`
            );
          }

          const buffer = await fsys.readFile(filePath, "buffer");

          // Budget against vision-token estimate (not base64-as-text).
          let data = buffer;
          let mimeType = fileTypeInfo.mimeType || "image/png";
          let dimensions = tryReadImageDimensions(data);
          let estimatedTokens = estimateImageInputTokens(data.length, dimensions);
          const remainingTokens = getRemainingTokenBudget();

          // Downscale/compress oversized images to fit the vision-token budget
          // instead of rejecting outright (optional CoreEnv capability — Node
          // hosts implement it via sharp; browsers/WebContainer degrade to reject).
          if (estimatedTokens > remainingTokens) {
            const resized = await getEnv().resizeImage?.(data, { maxWidth: 1024, quality: 80 });
            if (resized && resized.length > 0 && resized.length < data.length) {
              data = resized;
              mimeType = "image/jpeg";
              dimensions = tryReadImageDimensions(data);
              estimatedTokens = estimateImageInputTokens(data.length, dimensions);
            }
          }

          if (estimatedTokens > remainingTokens) {
            const dimLabel = dimensions ? `${dimensions.width}x${dimensions.height}` : "unknown size";
            throw new Error(
              `Skipping image to avoid context overflow: ${Math.round(buffer.length / 1024)}KB image (${dimLabel}) would use ~${estimatedTokens} vision tokens, but only ~${remainingTokens} tokens remain in budget. Try reading fewer images per turn.`
            );
          }

          const base64 = getEnv().base64Encode(data);

          return {
            type: "image" as const,
            path: filePath,
            mimeType,
            base64,
            size: data.length,
          };
        }

        // Handle PDFs
        if (fileTypeInfo.type === "pdf") {
          // Completions cannot embed PDF binaries on the wire; we extract text for those
          // models. Anthropic (and similar) also receive the `document` part via toModelOutput.
          const buffer = await fsys.readFile(filePath, "buffer");

          if (buffer.length > MAX_BINARY_SIZE) {
            throw new Error(
              `PDF file too large: ${Math.round(buffer.length / 1024 / 1024)}MB (max ${MAX_BINARY_SIZE / 1024 / 1024}MB)`
            );
          }

          const extracted = await extractPdfText(buffer);
          let extractedText = extracted?.text;
          if (extractedText && extractedText.length > MAX_CONTENT_LENGTH) {
            extractedText = extractedText.slice(0, MAX_CONTENT_LENGTH) + "\n...[PDF text truncated for context limit]";
          }
          if (extractedText) {
            const remainingTokens = getRemainingTokenBudget();
            const remainingChars = remainingTokens * CHARS_PER_TOKEN;
            if (remainingChars > 0 && extractedText.length > remainingChars) {
              extractedText =
                extractedText.slice(0, remainingChars) + "\n...[PDF text truncated: context budget limit reached]";
            }
          }

          return {
            type: "pdf" as const,
            path: filePath,
            base64: getEnv().base64Encode(buffer),
            size: buffer.length,
            ...(extractedText ? { extractedText } : {}),
            ...(extracted?.totalPages != null ? { pageCount: extracted.totalPages } : {}),
          };
        }

        // Handle text files — probe for binary content before UTF-8 read
        try {
          const buffer = await fsys.readFile(filePath, "buffer");
          if (isBinaryContent(buffer)) {
            throw new Error(`File appears to be binary: ${filePath}. Cannot read binary file content.`);
          }
        } catch (err) {
          if (err instanceof Error && err.message.includes("appears to be binary")) throw err;
          // If buffer read fails, try text read anyway
        }

        // Read text file
        const content = await getFile(filePath);

        const lines = content.split("\n");
        const totalLines = lines.length;

        // Use 1-indexed offset (default to 1)
        const startLine = offset ?? 1;
        const startIdx = startLine - 1;

        // Validate offset
        if (startIdx >= totalLines && totalLines > 0) {
          throw new Error(`Offset ${startLine} is out of range for this file (${totalLines} lines)`);
        }

        // Apply line limit
        const effectiveLimit = limit ?? DEFAULT_LINE_LIMIT;
        const endIdx = Math.min(startIdx + effectiveLimit, totalLines);
        const selectedLines = lines.slice(startIdx, endIdx);

        // Truncate long lines and add line numbers
        let truncatedByLength = false;
        const numberedLines = selectedLines.map((line, idx) => {
          const lineNum = startIdx + idx + 1;
          if (line.length > MAX_LINE_LENGTH) {
            truncatedByLength = true;
            return `${lineNum}: ${line.slice(0, MAX_LINE_LENGTH)}... (line truncated)`;
          }
          return `${lineNum}: ${line}`;
        });

        let selectedContent = numberedLines.join("\n");

        // Truncate total content if too large (static cap)
        let contentTruncated = false;
        if (selectedContent.length > MAX_CONTENT_LENGTH) {
          selectedContent = selectedContent.slice(0, MAX_CONTENT_LENGTH) + "\n...[content truncated for context limit]";
          contentTruncated = true;
        }

        // Also truncate based on remaining context budget
        const remainingTokens = getRemainingTokenBudget();
        const remainingChars = remainingTokens * CHARS_PER_TOKEN;
        if (remainingChars <= 0) {
          throw new Error(
            `Context budget exhausted. Cannot read more files this turn. The file has ${totalLines} lines — try reading it in a subsequent turn or use offset/limit for a smaller range.`
          );
        }
        if (selectedContent.length > remainingChars) {
          selectedContent =
            selectedContent.slice(0, remainingChars) + "\n...[content truncated: context budget limit reached]";
          contentTruncated = true;
        }

        const hasMore = endIdx < totalLines;
        const endLine = startIdx + selectedLines.length;

        return {
          type: "text" as const,
          path: filePath,
          content: selectedContent,
          totalLines,
          startLine,
          endLine,
          truncated: contentTruncated || truncatedByLength || hasMore,
        };
      });

      return result;
    },
    toModelOutput: ({ output }) => formatReadFileToolResult(output as ReadFileOutput),
  });
};
