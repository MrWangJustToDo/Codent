import { formatByteSize } from "../../../../../utils/byte-size.js";
import { isProjectedModelContent } from "../../../runtime/projected-model-content.js";

import type { ModelToolContent } from "../../../runtime/contract.js";
import type { ReadFileOutput } from "../read-file-tool.js";
import type { ContentPart } from "@tanstack/ai";

/**
 * The fields the model-facing rendering needs from a media output.
 *
 * Deliberately structural rather than `Extract<ReadFileOutput, { type: "image" | "pdf" }>`: the
 * second consumer is code-mode's `execute_typescript` lift, which holds the same media but not the
 * read-file envelope (`cachedOutputPath`, `durationMs`). Naming the fields once here is what lets
 * both paths render a file identically instead of keeping two copies of the wording.
 */
export interface MediaRenderInput {
  type: "image" | "pdf";
  path: string;
  base64: string;
  /** Byte size; omitted when the producer did not record one (the line then has no size). */
  size?: number;
  /** Image MIME type; defaults to `image/png` when the source did not record one. */
  mimeType?: string;
  extractedText?: string;
  pageCount?: number;
}

/** Shown when a PDF has no extractable text layer (scanned or empty), so the model is told why. */
const PDF_NO_TEXT_LAYER =
  "No extractable text layer (scanned or empty PDF). Document binary is attached for providers that accept multimodal tool documents.";

/**
 * The text line and multimodal part for one media file.
 *
 * `read_file` projects through this directly; code-mode's `execute_typescript` collects the lines
 * into one text part and appends the parts, because a script may return several files. Sharing the
 * rendering is the point: the same file must not be described two different ways to the model
 * depending on whether it was read directly or from inside the sandbox.
 */
export function describeReadFileMedia(output: MediaRenderInput): { line: string; part: ContentPart } {
  const size = output.size != null ? ` (${formatByteSize(output.size)})` : "";
  if (output.type === "image") {
    return {
      line: `Image read: ${output.path}${size}`,
      part: {
        type: "image",
        source: { type: "data", value: output.base64, mimeType: output.mimeType ?? "image/png" },
      },
    };
  }

  const header = `PDF read: ${output.path}${size}${output.pageCount != null ? `, ${output.pageCount} pages` : ""}`;
  const body = output.extractedText?.trim() || PDF_NO_TEXT_LAYER;
  return {
    line: `${header}\n\n${body}`,
    part: { type: "document", source: { type: "data", value: output.base64, mimeType: "application/pdf" } },
  };
}

/**
 * Convert read_file execute output for the model via TanStack {@link normalizeToolResult}.
 * Image/PDF paths return multimodal {@link ContentPart}[]; text/directory stay structured.
 *
 * PDF: always put extractable text in the text part so Chat Completions (after tool-media
 * lift drops `document`) still receives usable content. Keep the `document` part for
 * Anthropic / other providers with native multimodal tool results.
 */
export function formatReadFileToolResult(output: ReadFileOutput): ModelToolContent {
  // Idempotency: on a re-run (resume / later turn) this is fed the already-formatted content rather
  // than the raw `ReadFileOutput` (see {@link isProjectedModelContent}). Without the guard the
  // branches below fall into `JSON.stringify(output)` and flatten image base64 back to plain text,
  // breaking the `image_url` lift.
  if (isProjectedModelContent(output)) return output;

  if (output.type === "image" || output.type === "pdf") {
    const { line, part } = describeReadFileMedia(output);
    return [{ type: "text", content: line }, part];
  }

  return JSON.stringify(output);
}
