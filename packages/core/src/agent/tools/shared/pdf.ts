/**
 * Extract plain text from a PDF buffer for Completions-friendly tool results.
 *
 * Chat Completions cannot embed `document` parts on the wire; Anthropic can.
 * Putting extractable text in the tool's text part means Completions models
 * still get usable PDF content after {@link liftToolMediaForChatCompletions}
 * drops the document part.
 */

export interface ExtractPdfTextResult {
  text: string;
  totalPages: number;
}

/**
 * Best-effort PDF text extraction. Returns null when the runtime cannot load
 * the extractor or the PDF has no extractable text layer.
 */
export async function extractPdfText(buffer: Uint8Array): Promise<ExtractPdfTextResult | null> {
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(buffer);
    const { totalPages, text } = await extractText(pdf, { mergePages: true });
    const merged = Array.isArray(text) ? text.join("\n\n") : String(text ?? "");
    const trimmed = merged.replace(/\n{3,}/g, "\n\n").trim();
    if (!trimmed) return null;
    return { text: trimmed, totalPages };
  } catch {
    return null;
  }
}
