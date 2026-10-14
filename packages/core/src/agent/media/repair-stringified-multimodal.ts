/**
 * Repair multimodal user messages corrupted by TanStack's MESSAGES_SNAPSHOT.
 *
 * On tool-approval interrupts, `buildMessagesSnapshotChunk` JSON.stringifies
 * `ContentPart[]` into a string `content` field. StreamProcessor then treats
 * that string as a single text part — history dumps base64 + metadata JSON.
 *
 * Vision capability is irrelevant: the same UIMessage shape must survive
 * interrupt snapshots whether or not the model accepts images on the wire.
 *
 * NOTE (upstream fixed): @tanstack/ai >= 0.53.0 no longer produces this
 * corruption — `uiMessagesToWire` routes user parts through `collectUserContent`
 * (utilities/ag-ui-wire.js), emitting multimodal parts as a structured array
 * instead of JSON.stringify. We keep this repair for legacy sessions: old
 * persisted history can still carry stringified ContentPart[] (see
 * dehydrateUIMessages / hydrateUIMessages in media-utils.ts), and the
 * passthrough cost is zero for healthy snapshots. Safe to drop once all
 * legacy session stores are migrated.
 */

import { isBinaryMediaPartType } from "./types.js";

import type { StreamChunk, UIMessage } from "@tanstack/ai";

type LoosePart = {
  type?: string;
  content?: unknown;
  text?: unknown;
  source?: unknown;
  metadata?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/** True when a JSON value looks like TanStack ContentPart[] with multimodal parts. */
export function isStringifiedMultimodalContentParts(value: unknown): value is LoosePart[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  let sawMultimodal = false;
  for (const part of value) {
    if (!isRecord(part) || typeof part.type !== "string") return false;
    if (part.type === "text") {
      if (typeof part.content !== "string" && typeof part.text !== "string") return false;
      continue;
    }
    if (isBinaryMediaPartType(part.type)) {
      if (!isRecord(part.source)) return false;
      sawMultimodal = true;
      continue;
    }
    return false;
  }
  return sawMultimodal;
}

/**
 * Parse a text blob that is JSON.stringify(ContentPart[]) from an interrupt snapshot.
 */
export function parseStringifiedMultimodalContent(content: string): LoosePart[] | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("[{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!isStringifiedMultimodalContentParts(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Convert TanStack text parts (`content`) to AG-UI user content (`text`). */
function toAguiUserContent(parts: LoosePart[]): Array<Record<string, unknown>> {
  return parts.map((part) => {
    if (part.type === "text") {
      const text = typeof part.content === "string" ? part.content : typeof part.text === "string" ? part.text : "";
      return { type: "text", text };
    }
    return { ...part };
  });
}

/** Convert parsed parts into UIMessage `parts` (TanStack text uses `content`). */
function toUiMessageParts(parts: LoosePart[]): UIMessage["parts"] {
  return parts.map((part) => {
    if (part.type === "text") {
      const content = typeof part.content === "string" ? part.content : typeof part.text === "string" ? part.text : "";
      return { type: "text" as const, content };
    }
    return part as UIMessage["parts"][number];
  });
}

/**
 * Rewrite a MESSAGES_SNAPSHOT chunk so stringified ContentPart[] becomes an
 * AG-UI multimodal content array (handled by `aguiUserContentToParts`).
 */
export function repairMessagesSnapshotChunk(chunk: StreamChunk): StreamChunk {
  if (chunk.type !== "MESSAGES_SNAPSHOT") return chunk;

  let changed = false;
  const messages = chunk.messages.map((message) => {
    if (message.role !== "user") return message;
    if (typeof message.content !== "string") return message;
    const parsed = parseStringifiedMultimodalContent(message.content);
    if (!parsed) return message;
    changed = true;
    return {
      ...message,
      content: toAguiUserContent(parsed),
    };
  });

  if (!changed) return chunk;
  return { ...chunk, messages } as StreamChunk;
}

/**
 * Restore user UIMessages whose sole text part is stringified ContentPart[].
 * Used for already-persisted bad sessions and as a post-snapshot safety net.
 */
export function repairStringifiedMultimodalUIMessages(messages: UIMessage[]): UIMessage[] {
  let changed = false;
  const next = messages.map((message) => {
    if (message.role !== "user") return message;
    if (message.parts.length !== 1 || message.parts[0]?.type !== "text") return message;
    const textPart = message.parts[0] as { type: "text"; content?: string };
    const content = textPart.content;
    if (typeof content !== "string") return message;
    const parsed = parseStringifiedMultimodalContent(content);
    if (!parsed) return message;
    changed = true;
    return { ...message, parts: toUiMessageParts(parsed) };
  });
  return changed ? next : messages;
}
