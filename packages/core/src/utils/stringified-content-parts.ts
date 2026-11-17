/**
 * The **text form** of a persisted `ContentPart[]`, and the one definition of how to recognise it.
 *
 * TanStack serializes parts-array content as JSON text in more than one place: the AG-UI wire chunk
 * for `role: "tool"` (Chat Completions accepts only string content), `MESSAGES_SNAPSHOT` on
 * tool-approval interrupts, and any session persisted by an older `StreamProcessor`. Three modules
 * have to read that text, and each had written its own trim / `"[{"` / `JSON.parse` / validate
 * sequence: `agent/media/repair-stringified-multimodal.ts`, the MCP result coerce, and the Chat
 * Completions lift. This module owns the mechanical half.
 *
 * It deliberately stops at **parsing**. The shape check stays with each caller, because the
 * strictness each one needs differs and a shared answer would be wrong in one direction or the
 * other:
 *
 * - A **rewrite** of the text (strip one part, move its bytes into the media store) can work on
 *   *loose* parts — it only needs to find media, and a part it cannot classify is left alone. That
 *   is {@link isContentPartLike}, used by the snapshot repair and the dehydrate walk.
 * - A **wire lift** hands the array to a provider, so it validates against TanStack's
 *   `isContentPartArray` instead: a part the provider would reject must not be lifted. An array that
 *   fails that stricter check stays text — the pre-existing behaviour for JSON this runtime does not
 *   recognise — which is why {@link parseStringifiedContentParts} does not decide for the caller.
 */

import { isRecord } from "./is-record.js";
import { isMultimodalPartType } from "./multimodal-part-types.js";

/** A part as it looks right after `JSON.parse`, before any vocabulary check. */
export interface ParsedContentPart {
  type?: string;
  content?: unknown;
  text?: unknown;
  source?: unknown;
  metadata?: unknown;
}

/**
 * Parse `JSON.stringify(ContentPart[])` text into its array, or `null` when the text is not that.
 *
 * `Array.isArray` is the only requirement: `[]`, a text-only array, and an array whose elements are
 * not parts all come back as-is, because which of those counts is the caller's question (see the
 * module header). The `"[{"` prefix test rejects the overwhelmingly common case — tool output that
 * is prose, not JSON — before paying for `JSON.parse`.
 */
export function parseStringifiedContentParts(content: string): unknown[] | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("[{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Loose per-part check: a text part carrying `content` or `text`, or a binary media part carrying a
 * `source` object. A part of any other type is not something this runtime knows.
 *
 * "Loose" is about the payload, not the content: `source.value` and `source.mimeType` are not
 * required, because a rewrite only needs the shape it has to replace.
 */
export function isContentPartLike(part: unknown): part is ParsedContentPart {
  if (!isRecord(part) || typeof part.type !== "string") return false;
  if (part.type === "text") return typeof part.content === "string" || typeof part.text === "string";
  if (isMultimodalPartType(part.type)) return isRecord(part.source);
  return false;
}
