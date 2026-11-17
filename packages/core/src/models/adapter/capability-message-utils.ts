/**
 * Capability-gated chat message sanitization for the model wire format.
 *
 * Some Chat Completions endpoints reject multimodal parts (e.g.
 * `unknown variant 'image_url', expected 'text'`). Before send (and after such
 * API errors) we strip unsupported parts from a **wire copy** using
 * {@link ModelCapability} flags — not provider name checks — so UI history can
 * keep originals for display.
 *
 * ## Ordering contract
 *
 * Several multimodal items can appear in one session, and the transcript UI renders each next
 * to the `[Image #N: file]` ref the app input layer writes into the message text
 * (`packages/app/src/utils/user-input-helpers.ts`). A strip must preserve that pairing, so each
 * dropped part is replaced **in place** by {@link multimodalPartPlaceholder}, which reuses the
 * part's own `metadata.imageIndex` / `metadata.filename`. Merging every dropped part into one
 * trailing placeholder (the previous behaviour) lost both the count and the position, leaving the
 * model unable to tell which `#N` was omitted.
 *
 * ## Where a strip actually happens
 *
 * This module owns the **rules**; the strip itself runs in `wire-recovery-middleware`, from the
 * per-run drop set `armCapabilityStrip` / `tryCapabilitySanitizeRetry`
 * (`managers/stream-recovery/capability-sanitize.ts`) put on the `RunCoordinator`. It must: the
 * compaction projection rebuilds every wire call from the UI channel and discards
 * `config.messages`, so editing the messages handed to the engine applies to the first call of a
 * run and is overwritten from the second one on.
 */

import { errorMessage } from "../../utils/errors.js";
import { isMultimodalPartType, type MultimodalPartType } from "../../utils/multimodal-part-types.js";

import type { ModelCapability } from "../types.js";
import type { ContentPart, ModelMessage, TextPart, UIMessage } from "@tanstack/ai";

/** Which {@link ModelCapability} is required to send each multimodal part on the wire. */
export const MULTIMODAL_PART_CAPABILITY: Record<MultimodalPartType, ModelCapability> = {
  image: "vision",
  audio: "audio",
  video: "video",
  document: "document",
};

/**
 * Generic placeholder, used when a dropped part carries no identity to name.
 *
 * Kept as one constant (rather than inlined into the per-part form) because a metadata-less part has
 * nothing more specific to say, and because the wire-level validators assert on it —
 * `validate-wire-override-reaches-adapter` checks that this exact string reached the provider, which
 * only works if every capability drop produces the same one. Hosts do not match on it: they render
 * whatever text part the strip leaves behind.
 *
 * **Not** the same diagnostic as `OMITTED_UNSENDABLE_MEDIA` in
 * `lift-tool-media-for-chat-completions.ts`, even though both end up in a message the model reads.
 * That one is about the **wire format** (a Chat Completions tool result is one string, so video and
 * document parts cannot ride in it whatever the model supports) and collapses every dropped part
 * into one line. This one is about the **model's capability** or a missing file, replaces each part
 * in place, and names its `#index`/filename so the omission stays pairable with the text that
 * mentions it. Two causes, two granularities — merging them would lose the identity.
 */
export const MULTIMODAL_OMITTED_PLACEHOLDER =
  "[Media omitted — current model/API does not accept this content type. Use a provider with the matching capability, or describe the content in text.]";

/**
 * Generic placeholder for a media part whose file cannot be read at send time.
 *
 * Distinct from {@link MULTIMODAL_OMITTED_PLACEHOLDER} because the cause is different: the model
 * could take the content, the workspace just cannot produce it (media dir cleared, session copied
 * from another machine, remote workspace switched). A `media://` ref that reaches a provider is
 * not fetchable and fails the whole request.
 */
export const MULTIMODAL_UNAVAILABLE_PLACEHOLDER =
  "[Media unavailable — its file is missing from this workspace. Do not assume the content.]";

/** Why a multimodal part was replaced on the wire. */
export type MultimodalPlaceholderReason = "capability" | "missing-media";

/** Human label per multimodal part kind, used when a placeholder can name what was dropped. */
const MULTIMODAL_PART_LABEL: Record<MultimodalPartType, string> = {
  image: "Image",
  audio: "Audio",
  video: "Video",
  document: "Document",
};

/**
 * Identity fields an attachment carries from the app input layer (`use-agent-chat`).
 *
 * Mirrors `SessionMediaMetadata` in `agent/media/media-utils.ts`; the fields are restated here
 * because `models/` must not import upward (`validate:layer-boundaries`). Keep the two in step —
 * if the input layer stops writing `imageIndex`/`filename`, these placeholders silently fall back
 * to the generic constant and the ordering they exist to preserve is lost.
 */
interface PlaceholderIdentity {
  filename?: unknown;
  imageIndex?: unknown;
}

/**
 * Text placeholder standing in for one replaced multimodal part.
 *
 * Ordering is the whole point: several attachments in one session must stay identifiable
 * after their media is replaced, so a part that carries identity (`metadata.imageIndex` /
 * `metadata.filename`, set by the app input layer next to the `[Image #N: file]` ref in the
 * message text) becomes `[Image #2: b.png omitted — …]`. Matching the ref's index is what
 * lets the model pair a placeholder with the text that mentions it.
 *
 * Parts without identity (tool results — `read_file` labels its own text part) fall back to a
 * generic constant, which is deliberately index-free: inventing an index there would collide
 * with the attachment numbering.
 *
 * @param reason - `capability` when the model cannot take the content, `missing-media` when the
 *   workspace cannot produce it. The two must stay distinguishable: one is fixed by switching
 *   models, the other by restoring the file.
 */
export function multimodalPartPlaceholder(
  partType: MultimodalPartType,
  part?: { metadata?: unknown },
  reason: MultimodalPlaceholderReason = "capability"
): string {
  const metadata = (part?.metadata ?? undefined) as PlaceholderIdentity | undefined;
  const index = typeof metadata?.imageIndex === "number" ? metadata.imageIndex : undefined;
  const filename =
    typeof metadata?.filename === "string" && metadata.filename.length > 0 ? metadata.filename : undefined;
  if (index === undefined && filename === undefined) {
    return reason === "capability" ? MULTIMODAL_OMITTED_PLACEHOLDER : MULTIMODAL_UNAVAILABLE_PLACEHOLDER;
  }

  const id = index === undefined ? "" : ` #${index}`;
  const name = filename === undefined ? "" : `: ${filename}`;
  const subject = `${MULTIMODAL_PART_LABEL[partType]}${id}${name}`;
  if (reason === "missing-media") return `[${subject} unavailable — its file is missing from this workspace.]`;
  return `[${subject} omitted — current model has no ${MULTIMODAL_PART_CAPABILITY[partType]} input.]`;
}

export interface CapabilityProbe {
  hasCapability(cap: ModelCapability): boolean;
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

/**
 * Whether any part in the array is a multimodal one (optionally narrowed to `types`).
 *
 * Tolerates a hole/`null` entry: the wire `content` array is derived data that has crossed JSON, and
 * the caller of this scan (`capability-sanitize`) uses the answer to decide whether to emit a
 * diagnostic — a malformed element must not throw out of that path. The strip that follows tolerates
 * the same hole (`stripMultimodalContentParts`), so "this wire has media to drop" and "here is the
 * strip" cannot disagree about which elements exist.
 */
function partsHaveMultimodal(
  parts: Array<{ type?: string } | null | undefined>,
  types?: Set<MultimodalPartType>
): boolean {
  return parts.some((part) => {
    const type = part?.type;
    if (!isMultimodalPartType(type)) return false;
    return !types || types.has(type);
  });
}

/**
 * True when messages carry any multimodal parts (optionally filtered by type).
 *
 * One scan for both message shapes — a channel message carries `parts`, a wire message carries
 * `content` — because the predicate is the same for either container.
 */
export function chatMessagesHaveMultimodal(
  messages: Array<UIMessage | ModelMessage>,
  types?: Set<MultimodalPartType>
): boolean {
  for (const message of messages) {
    if ("parts" in message && Array.isArray(message.parts)) {
      if (partsHaveMultimodal(message.parts, types)) return true;
    }
    if ("content" in message && Array.isArray(message.content)) {
      if (partsHaveMultimodal(message.content, types)) return true;
    }
  }
  return false;
}

/**
 * Drop the parts the model cannot take, replacing each with its own text placeholder.
 * Returns the SAME array when nothing was dropped, which is what lets callers treat
 * "unchanged" as a no-op without comparing contents.
 *
 * Replacement is **in place**, not an append: with several dropped parts in one message, a
 * single trailing placeholder loses how many were dropped and where they sat relative to the
 * surviving content. The part's own position is what carries the ordering.
 *
 * One loop for both part vocabularies — a wire `ContentPart[]` and a channel message's `parts`
 * — because the rule is identical and a `text` part (what a placeholder becomes) is a member of
 * both. The single cast is that fact: the placeholder is built shape-first and re-typed as the
 * caller's part type, rather than written twice with two different annotations.
 *
 * Exported for the seam that has to reach a tool result in its string form
 * (`wire-recovery-middleware`): Chat Completions accepts only string `tool` content, and the parser
 * that recognises that form is `agent/media/`'s, which this layer must not import
 * (`validate-layer-boundaries`). The rule stays here; only the recognition lives one layer up.
 */
export function stripMultimodalContentParts<T extends { type: string; metadata?: unknown }>(
  content: T[],
  drop: Set<MultimodalPartType>
): T[] {
  let removed = 0;
  const kept: T[] = [];
  for (const part of content) {
    // Tolerate a hole/`null` entry for the same reason `partsHaveMultimodal` does: the wire
    // `content` array is derived data that has crossed JSON, and a strip that throws on one
    // malformed element would fail the send it was armed to repair.
    if (!part || typeof part !== "object") {
      kept.push(part);
      continue;
    }
    if (isMultimodalPartType(part.type) && drop.has(part.type)) {
      removed++;
      // Shape-first, then one cast: the placeholder is built as the wire vocabulary's `TextPart` —
      // which is also a `text` part in a channel message's `parts` — so the literal is type-checked
      // against the real shape instead of being spelled `as unknown as T` from an object literal.
      const placeholder: TextPart = { type: "text", content: multimodalPartPlaceholder(part.type, part) };
      kept.push(placeholder as unknown as T);
      continue;
    }
    kept.push(part);
  }
  if (removed === 0) return content;
  return kept;
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
      const parts = stripMultimodalContentParts(message.parts, drop);
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

// (No `sanitizeMessagesForCapabilities` / `trySanitizeForMultimodalRetry` here: both edited the
// message array handed to the engine, which the compaction projection overwrites from the second
// call of a run onward. The production path arms a per-run drop set instead — `armCapabilityStrip`
// / `tryCapabilitySanitizeRetry` in `managers/stream-recovery/` — and the strip above runs inside
// the wire projection for every call. Those two helpers outlived their call site by one refactor
// and were only exercised by a validator, so they were removed rather than kept as a second way to
// spell one decision.)
