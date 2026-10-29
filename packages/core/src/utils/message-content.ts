/**
 * Reading text out of a TanStack {@link ModelMessage} content value.
 *
 * Lives in `utils/` because it is not compaction's: `agent/memory`, `agent/turn-context` and
 * `agent-session` all read the same field (`content`, not the legacy `text`), and `agent-session`
 * reaching into `agent/compaction` for a leaf helper was a layering smell the edge table could not
 * see (it only knows `agent-session → agent`).
 */

import type { ContentPart, ModelMessage } from "@tanstack/ai";

/**
 * Extract text from ModelMessage `content` (string or ContentPart[]).
 * Non-text modalities are replaced with short placeholders.
 */
export function extractTextFromContent(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content;
  if (content === null) return "";
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const part of content) {
    parts.push(describeContentPart(part));
  }
  return parts.filter(Boolean).join("\n");
}

/** One content part as text: its text, or a bracketed note for a non-text modality. */
export function describeContentPart(part: ContentPart): string {
  switch (part.type) {
    case "text":
      return part.content;
    case "image":
      return "[Image was attached]";
    case "audio":
      return "[Audio was attached]";
    case "video":
      return "[Video was attached]";
    case "document":
      return "[Document was attached]";
    default:
      return "";
  }
}
