import { isProjectedModelContent } from "../runtime/projected-model-content.js";

import type { ReadFileOutput } from "../read-file-tool.js";
import type { ModelToolContent } from "../runtime/to-model-output-registry.js";

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

  if (output.type === "image") {
    return [
      { type: "text", content: `Image read: ${output.path} (${Math.round(output.size / 1024)}KB)` },
      {
        type: "image",
        source: { type: "data", value: output.base64, mimeType: output.mimeType },
      },
    ];
  }

  if (output.type === "pdf") {
    const header = `PDF read: ${output.path} (${Math.round(output.size / 1024)}KB${
      output.pageCount != null ? `, ${output.pageCount} pages` : ""
    })`;
    const body =
      output.extractedText?.trim() ||
      "No extractable text layer (scanned or empty PDF). Document binary is attached for providers that accept multimodal tool documents.";
    return [
      { type: "text", content: `${header}\n\n${body}` },
      {
        type: "document",
        source: { type: "data", value: output.base64, mimeType: "application/pdf" },
      },
    ];
  }

  return JSON.stringify(output);
}
