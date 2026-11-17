/**
 * Chat Completions wire format only allows string `tool` content. Multimodal
 * ContentPart[] in tool results would be JSON.stringified (base64-as-text) and
 * never become `image_url` / `input_audio`. Rewrite: keep tool text as a string,
 * then inject a synthetic user message with image/audio parts (universal
 * OpenAI-compatible pattern).
 *
 * Anthropic / Responses keep native multimodal tool results — do not use here.
 *
 * Content may arrive either as a real ContentPart[] (after `applyToolCompact`
 * reshaped it via a tool's `toModelOutput`) or as JSON text. The array is the
 * normal live shape — `@tanstack/ai` 1.0.1's `StreamProcessor` parses
 * `TOOL_CALL_RESULT.content` back into parts and only the wire chunk is
 * stringified — while the JSON text is what older sessions hold. Both are
 * handled here, so subagents and legacy sessions do not leak base64 as text.
 */

import { isContentPartArray } from "@tanstack/ai";

import { parseStringifiedContentParts } from "../../utils/stringified-content-parts.js";

import type { ContentPart, ModelMessage } from "@tanstack/ai";

const MEDIA_FOLLOW_UP_TEXT = "[Media from tool result — inspect the attached content.]";

/**
 * Standing note for media this wire cannot carry at all.
 *
 * **Not** the same diagnostic as `MULTIMODAL_OMITTED_PLACEHOLDER` / `multimodalPartPlaceholder` in
 * `capability-message-utils.ts`, and the two must not be merged. Those say "the model lacks the
 * capability" or "the file is gone", replace one part in place, and keep its `#index`/filename so the
 * model can pair the omission with the text that mentions it. This one says "the wire format cannot
 * express it": a model that advertises `video` still cannot receive video inside a Chat Completions
 * tool result. It also collapses everything dropped into one line, because the message being
 * rewritten is a single string — there is no position to preserve.
 *
 * `image` and `audio` never reach it: those are lifted into the synthetic user message below.
 */
const OMITTED_UNSENDABLE_MEDIA =
  "[Omitted media: Chat Completions cannot embed video/document content in a tool result. Prefer a provider with native multimodal tool results, or summarize it in text.]";

function isLiftableMediaPart(part: ContentPart): part is Extract<ContentPart, { type: "image" | "audio" }> {
  return part.type === "image" || part.type === "audio";
}

/**
 * Resolve tool-message content to {@link ContentPart}[] when it carries media.
 *
 * Two shapes, both real: a `ContentPart[]` (the live shape — TanStack 1.0.1 keeps the parsed parts on
 * `tool-result.content`, and `applyToolCompact` produces one for tools with a registered
 * `toModelOutput`), and the JSON text of that array, which is what the wire chunk carries and what
 * sessions written by an older runtime hold on disk. Subagents skip `applyToolCompact`, so their tool
 * results arrive in whichever form the channel kept: revive here too, so base64 never reaches the wire
 * as plain text.
 *
 * Parsing is the shared `parseStringifiedContentParts`; the check that follows is deliberately the
 * **strict** one (`isContentPartArray`), unlike the strip path's loose recogniser
 * (`agent/media/repair-stringified-multimodal.ts`). Everything this function returns is handed to a
 * provider, so a part the provider would reject must stay text rather than be lifted — those bytes
 * then reach the model exactly as they did before this function existed. That asymmetry is the reason
 * the shared helper stops at parsing and leaves the shape check to its callers.
 */
function asToolContentParts(content: ModelMessage["content"]): ContentPart[] | null {
  if (isContentPartArray(content)) return content;
  if (typeof content !== "string") return null;

  const parsed = parseStringifiedContentParts(content);
  if (!parsed || !isContentPartArray(parsed)) return null;
  return parsed;
}

function splitToolContentParts(parts: ContentPart[]): { text: string; media: ContentPart[] } {
  const textChunks: string[] = [];
  const media: ContentPart[] = [];
  let omittedUnsendable = false;

  for (const part of parts) {
    if (part.type === "text") {
      if (part.content) textChunks.push(part.content);
      continue;
    }
    if (isLiftableMediaPart(part)) {
      media.push(part);
      continue;
    }
    omittedUnsendable = true;
  }

  // Only mention the omission when there is no useful text (e.g. the PDF text extraction already
  // carries the content after the document part is dropped).
  if (omittedUnsendable && textChunks.every((chunk) => !chunk.trim())) {
    textChunks.push(OMITTED_UNSENDABLE_MEDIA);
  }

  let text = textChunks.join("\n").trim();
  if (!text && media.length > 0) {
    text = "Media attached in the following user message.";
  }
  return { text, media };
}

/**
 * Rewrite ModelMessages so Chat Completions adapters never stringify image/audio
 * base64 inside `role: "tool"`. Batches media from consecutive tool messages
 * into one trailing synthetic user message (avoids tool/user/tool interleaving).
 */
export function liftToolMediaForChatCompletions(messages: ModelMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  let pendingMedia: ContentPart[] = [];

  const flushMedia = () => {
    if (pendingMedia.length === 0) return;
    out.push({
      role: "user",
      content: [{ type: "text", content: MEDIA_FOLLOW_UP_TEXT }, ...pendingMedia],
    });
    pendingMedia = [];
  };

  for (const message of messages) {
    const toolParts = message.role === "tool" ? asToolContentParts(message.content) : null;

    if (toolParts) {
      const { text, media } = splitToolContentParts(toolParts);
      out.push({
        ...message,
        content: text,
      });
      pendingMedia.push(...media);
      continue;
    }

    flushMedia();
    out.push(message);
  }

  flushMedia();
  return out;
}
