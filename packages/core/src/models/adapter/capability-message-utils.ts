import { errorMessage } from "../../utils/errors.js";
/**
 * Capability-gated chat message sanitization for the model wire format.
 *
 * Some Chat Completions endpoints reject multimodal parts (e.g.
 * `unknown variant 'image_url', expected 'text'`). Before send (and after such
 * API errors) we strip unsupported parts from a **wire copy** using
 * {@link ModelCapability} flags — not provider name checks — so UI history can
 * keep originals for display.
 */

import type { ModelCapability } from "../types.js";
import type { ContentPart, ModelMessage, UIMessage } from "@tanstack/ai";

/** Multimodal content part types that may appear in user/model messages. */
export type MultimodalPartType = "image" | "audio" | "video" | "document";

const MULTIMODAL_PART_TYPES = new Set<string>(["image", "audio", "video", "document"]);

/** Which {@link ModelCapability} is required to send each multimodal part on the wire. */
export const MULTIMODAL_PART_CAPABILITY: Record<MultimodalPartType, ModelCapability> = {
  image: "vision",
  audio: "audio",
  video: "video",
  document: "document",
};

export const MULTIMODAL_OMITTED_PLACEHOLDER =
  "[Media omitted — current model/API does not accept this content type. Use a provider with the matching capability, or describe the content in text.]";

export interface CapabilityProbe {
  hasCapability(cap: ModelCapability): boolean;
}

function isMultimodalPartType(type: string | undefined): type is MultimodalPartType {
  return typeof type === "string" && MULTIMODAL_PART_TYPES.has(type);
}

/** Resolve which multimodal part types should be stripped for the given capabilities. */
export function unsupportedMultimodalPartTypes(probe: CapabilityProbe | null | undefined): Set<MultimodalPartType> {
  const unsupported = new Set<MultimodalPartType>();
  if (!probe) return unsupported;

  for (const [partType, capability] of Object.entries(MULTIMODAL_PART_CAPABILITY) as Array<
    [MultimodalPartType, ModelCapability]
  >) {
    if (!probe.hasCapability(capability)) {
      unsupported.add(partType);
    }
  }
  return unsupported;
}

/**
 * Detect API/schema rejections of multimodal content parts
 * (`image_url`, `input_audio`, `file`, etc.).
 */
export function isMultimodalUnsupportedError(error: unknown): boolean {
  const msg = errorMessage(error).toLowerCase();

  if (msg.includes("unknown variant") && msg.includes("expected") && msg.includes("text")) {
    return true;
  }

  const modalityHints = [
    "image_url",
    "input_audio",
    "audio_url",
    "video_url",
    "input_video",
    "file_url",
    "document",
    "image",
    "audio",
    "video",
    "multimodal",
    "vision",
  ];
  const hasModalityHint = modalityHints.some((hint) => msg.includes(hint));
  if (!hasModalityHint) return false;

  if (msg.includes("unsupported content part")) return true;
  if (msg.includes("unsupported") || msg.includes("not support") || msg.includes("invalid")) return true;
  if (msg.includes("does not support")) return true;
  if (msg.includes("unknown variant")) return true;
  if (msg.includes("expected") && msg.includes("text")) return true;

  return false;
}

function contentHasMultimodal(content: unknown, types?: Set<MultimodalPartType>): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    const type = (part as { type?: string })?.type;
    if (!isMultimodalPartType(type)) return false;
    return !types || types.has(type);
  });
}

function partsHaveMultimodal(parts: Array<{ type?: string }>, types?: Set<MultimodalPartType>): boolean {
  return parts.some((part) => {
    if (!isMultimodalPartType(part.type)) return false;
    return !types || types.has(part.type);
  });
}

/** True when messages carry any multimodal parts (optionally filtered by type). */
export function chatMessagesHaveMultimodal(
  messages: Array<UIMessage | ModelMessage>,
  types?: Set<MultimodalPartType>
): boolean {
  for (const message of messages) {
    if ("parts" in message && Array.isArray(message.parts)) {
      if (partsHaveMultimodal(message.parts, types)) return true;
    }
    if ("content" in message && contentHasMultimodal(message.content, types)) return true;
  }
  return false;
}

/**
 * Drop the parts the model cannot take, appending the placeholder so the model is told why content
 * is missing. Returns the SAME array when nothing was dropped, which is what lets callers treat
 * "unchanged" as a no-op without comparing contents.
 *
 * Exported for the seam that has to reach a tool result in its string form
 * (`wire-recovery-middleware`): Chat Completions accepts only string `tool` content, and the parser
 * that recognises that form is `agent/media/`'s, which this layer must not import
 * (`validate-layer-boundaries`). The rule stays here; only the recognition lives one layer up.
 */
export function stripMultimodalContentParts(content: ContentPart[], drop: Set<MultimodalPartType>): ContentPart[] {
  let removed = 0;
  const kept: ContentPart[] = [];
  for (const part of content) {
    if (isMultimodalPartType(part.type) && drop.has(part.type)) {
      removed++;
      continue;
    }
    kept.push(part);
  }
  if (removed === 0) return content;
  return [...kept, { type: "text", content: MULTIMODAL_OMITTED_PLACEHOLDER }];
}

function stripUiParts(parts: UIMessage["parts"], drop: Set<MultimodalPartType>): UIMessage["parts"] {
  let removed = 0;
  const kept: UIMessage["parts"] = [];
  for (const part of parts) {
    if (isMultimodalPartType(part.type) && drop.has(part.type)) {
      removed++;
      continue;
    }
    kept.push(part);
  }
  if (removed === 0) return parts;
  return [...kept, { type: "text", content: MULTIMODAL_OMITTED_PLACEHOLDER }];
}

/**
 * Shallow-copy messages, replacing dropped multimodal parts with a text placeholder.
 * Does not mutate originals (UI history can keep media for display).
 */
export function stripMultimodalFromChatMessages<T extends UIMessage | ModelMessage>(
  messages: T[],
  drop: Set<MultimodalPartType>
): T[] {
  if (drop.size === 0) return messages;

  return messages.map((message) => {
    if ("parts" in message && Array.isArray(message.parts)) {
      const parts = stripUiParts(message.parts, drop);
      if (parts === message.parts) return message;
      return { ...message, parts } as T;
    }

    if ("content" in message && Array.isArray(message.content)) {
      const content = stripMultimodalContentParts(message.content as ContentPart[], drop);
      if (content === message.content) return message;
      return { ...message, content } as T;
    }

    return message;
  });
}

/**
 * Pre-send sanitize: drop multimodal parts the model is known not to support.
 * Empty/unknown capabilities (probe returns true for all) → no strip.
 */
export function sanitizeMessagesForCapabilities<T extends UIMessage | ModelMessage>(
  messages: T[],
  probe: CapabilityProbe | null | undefined
): T[] {
  const drop = unsupportedMultimodalPartTypes(probe);
  if (drop.size === 0) return messages;
  if (!chatMessagesHaveMultimodal(messages, drop)) return messages;
  return stripMultimodalFromChatMessages(messages, drop);
}

/**
 * After a multimodal schema/API rejection: strip every multimodal part still present
 * and return a copy suitable for one retry. Returns null if nothing to strip.
 */
export function trySanitizeForMultimodalRetry(
  error: unknown,
  messages: Array<UIMessage | ModelMessage>
): Array<UIMessage | ModelMessage> | null {
  if (!isMultimodalUnsupportedError(error)) return null;
  const all = new Set<MultimodalPartType>(["image", "audio", "video", "document"]);
  if (!chatMessagesHaveMultimodal(messages, all)) return null;
  return stripMultimodalFromChatMessages(messages, all);
}
