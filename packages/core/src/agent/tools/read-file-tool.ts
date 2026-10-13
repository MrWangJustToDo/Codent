import { z } from "zod";

import { estimateImageInputTokens, tryReadImageDimensions } from "../../models/estimate-image-tokens.js";

import { defineServerTool } from "./runtime/define-tool.js";
import { extractPdfText } from "./util/extract-pdf-text.js";
import { formatReadFileToolResult } from "./util/format-read-file-result.js";
import { OUTPUT_LIMITS } from "./util/output-limits.js";
import { detectReadFileType, headProbeSample, isBinaryContent } from "./util/read-file-detect.js";
import { scanTextWindow } from "./util/read-file-window.js";
import { getFile, withDuration } from "./util/tool-result.js";
import { toolOutputBaseSchema } from "./util/types.js";

import type { TextWindowResult } from "./util/read-file-window.js";
import type { CoreEnvFs } from "../../env";
import type { FileStat } from "../../env/types";
import type { UsageTracker } from "../../runtime-types/hosts.js";

// ============================================================================
// Constants
// ============================================================================

/**
 * The shared caps (see `util/output-limits`): the per-result content ceiling, the per-line
 * truncation width, and the byte ceiling this tool will actually read from disk. They live in one
 * place so a `read_file` page and a `webfetch` extract cannot drift apart, and so the MEMORY bound
 * (`MAX_FILE_READ_BYTES`, the whole-file read a text/PDF/image needs) stays visibly distinct from
 * the OUTPUT bound.
 */
const { MAX_RESULT_CONTENT_CHARS, MAX_LINE_CHARS, MAX_FILE_READ_BYTES } = OUTPUT_LIMITS;

/** Default line limit when not specified */
const DEFAULT_LINE_LIMIT = 2000;

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
// Streamed text reading
// ============================================================================

/**
 * Window size for a streamed text read, in bytes.
 *
 * Only decides how often we ask the host for more: the retained memory is the output caps (see
 * `read-file-window`), not this. Big enough that a normal source file is one read, small enough
 * that the transient buffer is irrelevant next to the model's output budget.
 */
const READ_CHUNK_BYTES = 64 * 1024;

/** Byte length of a UTF-8 string — `TextEncoder` is a global in every runtime core targets. */
const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/**
 * Read a text file as decoded, line-aligned pieces: each window is a byte range, but only the part
 * through its last newline is yielded — the rest is re-read in the next window.
 *
 * The alignment is load-bearing, not cosmetic. `readFileRange` decodes each range independently, so
 * a window boundary landing inside a multi-byte character turns it into U+FFFD, which is
 * unrecoverable — and a 64 KB boundary inside non-ASCII text is routine. A newline is a single
 * byte, so the consumed prefix always ends on a character boundary, and advancing by its BYTE
 * length keeps the next window aligned. A full window with no newline at all is a single line
 * longer than the window: every line cap is already behind such a line, so it is yielded and the
 * scan discards it.
 */
async function* readTextPieces(fsys: CoreEnvFs, filePath: string): AsyncGenerator<string> {
  let from = 0;
  for (;;) {
    const window = await fsys.readFileRange!(filePath, from, from + READ_CHUNK_BYTES);
    if (utf8Bytes(window) < READ_CHUNK_BYTES) {
      // A short read is EOF.
      yield window;
      return;
    }
    const lastNewline = window.lastIndexOf("\n");
    if (lastNewline === -1) {
      yield window;
      from += READ_CHUNK_BYTES;
      continue;
    }
    const consumed = window.slice(0, lastNewline + 1);
    yield consumed;
    from += utf8Bytes(consumed);
  }
}

/** Re-yield the head already consumed for the binary probe, then the rest of the read. */
async function* withHead(head: IteratorResult<string>, rest: AsyncIterator<string>): AsyncGenerator<string> {
  if (!head.done) yield head.value;
  for (;;) {
    const next = await rest.next();
    if (next.done) return;
    yield next.value;
  }
}

/** One already-decoded piece, as the piece source the scan expects. */
async function* asPiece(text: string): AsyncGenerator<string> {
  yield text;
}

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

    execute: async ({ path: filePath, offset, limit }, { coreEnv }) => {
      const result = await withDuration(async () => {
        const fsys = coreEnv.fs;

        // Check if file/directory exists
        const exists = await fsys.exists(filePath);
        if (!exists) {
          // Try to find similar files for suggestion
          const envPath = coreEnv.path;
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
        const fileTypeInfo = await detectReadFileType(coreEnv, filePath, stat);

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

          // Same pre-read gate as the text and PDF branches: the whole image is materialised
          // before the vision-token budget is consulted, so an oversized one must be refused on
          // its stat'd size or it OOMs first.
          if (stat && stat.size > MAX_FILE_READ_BYTES) {
            throw new Error(
              `Image too large to read: ${Math.round(stat.size / 1024 / 1024)}MB (max ${MAX_FILE_READ_BYTES / 1024 / 1024}MB)`
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
            const resized = await coreEnv.resizeImage?.(data, { maxWidth: 1024, quality: 80 });
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

          const base64 = coreEnv.base64Encode(data);

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
          //
          // Gate on `stat.size` BEFORE reading. The `buffer.length` guard below can only fire
          // once the whole file is already in memory, so on its own it cannot stop an oversized
          // PDF from OOMing the process; it is kept as the fallback for hosts whose `stat` is
          // unavailable (the `:182` try/catch) and as a defence against a stale size.
          if (stat && stat.size > MAX_FILE_READ_BYTES) {
            throw new Error(
              `PDF file too large: ${Math.round(stat.size / 1024 / 1024)}MB (max ${MAX_FILE_READ_BYTES / 1024 / 1024}MB)`
            );
          }

          const buffer = await fsys.readFile(filePath, "buffer");

          if (buffer.length > MAX_FILE_READ_BYTES) {
            throw new Error(
              `PDF file too large: ${Math.round(buffer.length / 1024 / 1024)}MB (max ${MAX_FILE_READ_BYTES / 1024 / 1024}MB)`
            );
          }

          const extracted = await extractPdfText(buffer);
          let extractedText = extracted?.text;
          if (extractedText && extractedText.length > MAX_RESULT_CONTENT_CHARS) {
            extractedText =
              extractedText.slice(0, MAX_RESULT_CONTENT_CHARS) + "\n...[PDF text truncated for context limit]";
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
            base64: coreEnv.base64Encode(buffer),
            size: buffer.length,
            ...(extractedText ? { extractedText } : {}),
            ...(extracted?.totalPages != null ? { pageCount: extracted.totalPages } : {}),
          };
        }

        // Handle text files.
        //
        // Streamed scan when the host can read a byte window: the file is read in pieces and only
        // the requested window is retained, so memory is bounded by the OUTPUT caps at any file
        // size — which is what demotes the byte ceiling below to a fallback rather than the primary
        // bound (and why an oversized file is no longer refused here). Only the head is handed to
        // `isBinaryContent`, as before.
        const startLine = offset ?? 1;
        const startIdx = startLine - 1;
        const effectiveLimit = limit ?? DEFAULT_LINE_LIMIT;

        let scanned: TextWindowResult;
        // (A host without a byte-window read falls through to the whole-file path below.)
        if (fsys.readFileRange) {
          const pieces = readTextPieces(fsys, filePath);
          const head = await pieces.next();
          if (!head.done && isBinaryContent(headProbeSample(head.value))) {
            throw new Error(`File appears to be binary: ${filePath}. Cannot read binary file content.`);
          }
          scanned = await scanTextWindow(withHead(head, pieces), {
            offset: startLine,
            limit: effectiveLimit,
            maxLineChars: MAX_LINE_CHARS,
            maxWindowChars: MAX_RESULT_CONTENT_CHARS,
          });
        } else {
          // Fallback for a host that cannot stream. The whole file must be materialised, so this
          // byte ceiling is the only thing between a multi-GB file and an OOM.
          if (stat && stat.size > MAX_FILE_READ_BYTES) {
            throw new Error(
              `File too large to read: ${Math.round(stat.size / 1024 / 1024)}MB (max ${MAX_FILE_READ_BYTES / 1024 / 1024}MB). ` +
                `Read it in pieces instead — grep for the lines you need, or stream a slice with run_command ` +
                `(e.g. \`sed -n '1,200p' <path>\` or \`head\`).`
            );
          }

          let textContent: string | undefined;
          let rawBuffer: Uint8Array | undefined;
          try {
            rawBuffer = await fsys.readFile(filePath, "buffer");
          } catch {
            // A host that cannot return bytes degrades to a plain text read — there is then simply
            // no buffer to probe.
            textContent = await getFile(coreEnv, filePath);
          }

          const probeSource = rawBuffer ?? textContent;
          if (probeSource !== undefined && isBinaryContent(headProbeSample(probeSource))) {
            throw new Error(`File appears to be binary: ${filePath}. Cannot read binary file content.`);
          }

          const content = textContent ?? new TextDecoder("utf-8", { ignoreBOM: true }).decode(rawBuffer!);
          scanned = await scanTextWindow(asPiece(content), {
            offset: startLine,
            limit: effectiveLimit,
            maxLineChars: MAX_LINE_CHARS,
            maxWindowChars: MAX_RESULT_CONTENT_CHARS,
          });
        }

        const totalLines = scanned.totalLines;

        // Validate offset. Needs the exact total, so it happens after the scan on both paths.
        if (startIdx >= totalLines && totalLines > 0) {
          throw new Error(`Offset ${startLine} is out of range for this file (${totalLines} lines)`);
        }

        const endIdx = Math.min(startIdx + effectiveLimit, totalLines);
        let selectedContent = scanned.content;
        let contentTruncated = scanned.truncatedByChars;
        // The scan stops the window AT the cap, so the notice is what tells the model there is more
        // — otherwise a cut window is indistinguishable from a short file.
        if (scanned.truncatedByChars) selectedContent += "\n...[content truncated for context limit]";

        // The static window cap is already applied by the scan; this is the per-turn context budget.
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
        const endLine = startIdx + Math.max(0, endIdx - startIdx);

        return {
          type: "text" as const,
          path: filePath,
          content: selectedContent,
          totalLines,
          startLine,
          endLine,
          truncated: contentTruncated || scanned.truncatedByLength || hasMore,
        };
      });

      return result;
    },
    toModelOutput: ({ output }) => formatReadFileToolResult(output as ReadFileOutput),
  });
};
