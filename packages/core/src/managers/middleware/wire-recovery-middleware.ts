/**
 * `wire-recovery` middleware — applies the per-run wire overrides that must
 * survive the channel projection.
 *
 * Placement contract: this middleware MUST run AFTER `tool-compact`, which is also
 * after `message-transform` and therefore after `compaction`. All three orderings are
 * load-bearing, each for a different reason:
 *
 * - After `compaction`, because that middleware rebuilds the wire from
 *   `channel.getMessages()` and discards the incoming `config.messages`. An
 *   override applied before it reaches the first call of a run only, then is
 *   overwritten on every later call — the exact failure this middleware exists to
 *   fix (`capability-sanitize` and `max-tokens-continue` both used to write
 *   straight into the messages handed to the engine).
 * - After `message-transform`, because a capability strip replaces media parts
 *   with a placeholder. Running the strip first would mean an extension sees
 *   `[Media omitted …]` instead of the actual image, so the transform seam's
 *   headline use case (replace an attachment with text from an out-of-process
 *   multimodal endpoint) could never run for a model that lacks vision. Ordering
 *   the strip last keeps the extension's view of the chain faithful.
 * - After `tool-compact`, because that is what makes a TOOL result's media exist as a
 *   part at all: the channel stores the result object, so the wire carries it as JSON
 *   text until the tool's `toModelOutput` projects it (`read_file` → text + image).
 *   Sitting before that stage, this seam could only ever strip media that was already
 *   a part (a user attachment) — a tool's image reached the endpoint untouched, and the
 *   widened retry could not recover, because the projection re-materializes the media
 *   on every wire build.
 *
 * Everything here is wire-only. The channel — and therefore the persisted session
 * and the transcript UI — keeps the original media parts, so nothing in a
 * capability strip or a continuation prompt is ever durable.
 *
 * ## Unhydrated media
 *
 * One input is not a per-run override: a restored transcript can still carry `media://` refs whose
 * files are gone. Those are unfetchable by any provider and would fail every turn, so when the
 * session reports hydration misses (`hasUnhydratedMedia`) they are replaced by identity-carrying
 * text placeholders ({@link multimodalPartPlaceholder}). That pass runs **after** the strip: for a
 * model that cannot take the part anyway, "omitted — no vision" is the actionable report (switch
 * model), while "unavailable" would blame a file that may be perfectly fine. It stays wire-only
 * for the same reason (`wire-abort`): restoring the media directory later must bring the image
 * back.
 *
 * Zero-overhead contract: with no override armed (the common case, and always the
 * case for subagents and for models with full capabilities and a clean restore) this
 * returns `{}`, so the pipeline behaves exactly as if the middleware did not exist.
 * A hydration miss is a boolean the restore reports, not a scan — an always-on part walk
 * would pay the cost on every call to detect a condition that is knowable one time.
 */

import { parseStringifiedMultimodalContent } from "../../agent/media/repair-stringified-multimodal.js";
import { isBinaryMediaPartType, isMediaRefValue } from "../../agent/media/types.js";
import { TURN_CONTEXT_KINDS, formatContextSectionUserContent, formatSectionTag } from "../../agent/turn-context";
import {
  multimodalPartPlaceholder,
  stripMultimodalContentParts,
  stripMultimodalFromChatMessages,
} from "../../models/adapter/capability-message-utils.js";
import { CONTINUATION_PROMPT } from "../stream-recovery/max-tokens-continue.js";

import { defineMiddleware } from "./phase.js";

import type { ToolRunContext } from "../../agent/runner/run-context.js";
import type { MultimodalPartType } from "../../utils/multimodal-part-types.js";
import type { RunCoordinator } from "../run-coordinator.js";
import type { ContentPart, ChatMiddleware, ModelMessage } from "@tanstack/ai";

export interface WireRecoveryMiddlewareDeps {
  /** Per-run override state (survives retries within one run). */
  getRun: () => RunCoordinator | undefined;
  /**
   * Whether the restored transcript still holds `media://` refs whose files could not be read.
   *
   * Optional and flag-gated on purpose: a hydration miss is only knowable at restore, so this is a
   * cheap boolean far cheaper than scanning every part on every wire build just in case. Absent or
   * false restores the zero-overhead contract below.
   */
  hasUnhydratedMedia?: () => boolean;
}

/**
 * Rewrite string-content tool results that carry media the model cannot take.
 *
 * Chat Completions accepts only string `tool` content, so TanStack persists an array result with
 * `JSON.stringify` — and in that form the media is not a content part at all until something
 * re-parses it. The two readers that do are the tool-output projection (skipped when the tool has no
 * registered `toModelOutput`) and the adapter's `liftToolMediaForChatCompletions`, which runs after
 * every middleware and does not consult the drop set. So this seam has to handle the string form
 * itself, or a model without vision is sent the tool's image anyway — on the one path where the
 * widened retry cannot help, because the same string comes back on every call.
 *
 * The recognition lives here, not in the strip module: the parser is `agent/media/`'s and `models/`
 * must not import upward (`validate:layer-boundaries`). What a dropped part becomes stays with the
 * drop set, in {@link stripMultimodalContentParts}. Narrowed to `role: "tool"` — that is the encoding
 * that needs it, and a user message is the user's text even when it happens to parse as parts.
 */
function stripStringifiedToolMedia(messages: ModelMessage[], drop: Set<MultimodalPartType>): ModelMessage[] {
  return messages.map((message) => {
    if (message.role !== "tool" || typeof message.content !== "string") return message;

    const parts = parseStringifiedMultimodalContent(message.content);
    if (!parts) return message;

    const asParts = parts as ContentPart[];
    const stripped = stripMultimodalContentParts(asParts, drop);
    if (stripped === asParts) return message;
    // Stays a string: string `tool` content is the only thing this wire format accepts.
    return { ...message, content: JSON.stringify(stripped) } as ModelMessage;
  });
}

/**
 * Replace media parts whose `source.value` is still a `media://` ref.
 *
 * A `media://` value only survives into a runtime transcript when hydration could not read the
 * file (media dir cleared, session copied from another machine/workspace). It is not a URL any
 * provider can fetch, so sending it fails the whole request — and `isMultimodalUnsupportedError`
 * does not recognise a CDN/loader failure, so the widened retry cannot rescue it either: every
 * subsequent turn fails the same way. Replacing it with a text placeholder keeps the turn
 * usable and tells the model what it is missing.
 *
 * Copy-on-write: the channel (and therefore the persisted session) keeps the `media://` part, so
 * restoring the media directory later brings the image back instead of losing it to a placeholder.
 */
function replaceUnhydratedParts(parts: ContentPart[]): ContentPart[] {
  let changed = false;
  const next = parts.map((part) => {
    if (!isBinaryMediaPartType(part.type)) return part;
    const source = (part as { source?: { value?: unknown } }).source;
    if (typeof source?.value !== "string" || !isMediaRefValue(source.value)) return part;
    changed = true;
    return { type: "text", content: multimodalPartPlaceholder(part.type, part, "missing-media") } as ContentPart;
  });
  return changed ? next : parts;
}

/**
 * Apply {@link replaceUnhydratedParts} across a wire, including stringified tool results.
 *
 * String content is narrowed to `role: "tool"` for the same reason as
 * {@link stripStringifiedToolMedia}: that is the encoding TanStack produces by stringifying an
 * array result, and a user message is the user's text even when it happens to parse as parts. The
 * array branch is role-agnostic — a real content part is media wherever it appears.
 */
function replaceUnhydratedMedia(messages: ModelMessage[]): ModelMessage[] {
  let changed = false;
  const next = messages.map((message) => {
    if (message.role === "tool" && typeof message.content === "string") {
      const parts = parseStringifiedMultimodalContent(message.content);
      if (!parts) return message;
      const asParts = parts as ContentPart[];
      const replaced = replaceUnhydratedParts(asParts);
      if (replaced === asParts) return message;
      changed = true;
      // Stays a string: string `tool` content is the only form that wire format accepts.
      return { ...message, content: JSON.stringify(replaced) } as ModelMessage;
    }

    if (Array.isArray(message.content)) {
      const asParts = message.content as ContentPart[];
      const replaced = replaceUnhydratedParts(asParts);
      if (replaced === asParts) return message;
      changed = true;
      return { ...message, content: replaced } as ModelMessage;
    }

    return message;
  });
  return changed ? next : messages;
}

export function createWireRecoveryMiddleware(deps: WireRecoveryMiddlewareDeps): ChatMiddleware<ToolRunContext> {
  return defineMiddleware("context-transform", {
    name: "wire-recovery",
    onConfig: (_ctx, config) => {
      const run = deps.getRun();
      if (!run) return {};

      const drop = run.getWireDropPartTypes();
      const armed = run.isWireContinuationArmed();
      const unhydrated = deps.hasUnhydratedMedia?.() === true;
      if (!drop?.size && !armed && !unhydrated) return {};

      let messages = config.messages as ModelMessage[];

      if (drop?.size) {
        messages = stripMultimodalFromChatMessages(messages, drop);
        messages = stripStringifiedToolMedia(messages, drop);
      }

      // After the strip: for a model that cannot take the part anyway, "omitted — no vision" is the
      // actionable report (switch model); "unavailable" would blame a file that is perfectly fine.
      if (unhydrated) {
        messages = replaceUnhydratedMedia(messages);
      }

      if (armed) {
        // Wrapped as a synthetic context message: it is a repair instruction, not a user turn.
        // A bare `user` message here is a turn boundary for every window scan (the repeat chain
        // ends at it and never resumes while the continuation stays armed on later calls).
        messages = [
          ...messages,
          {
            role: "user" as const,
            content: formatContextSectionUserContent({
              key: TURN_CONTEXT_KINDS.continuationPrompt,
              content: formatSectionTag(TURN_CONTEXT_KINDS.continuationPrompt, CONTINUATION_PROMPT),
            }),
          },
        ];
      }

      return { messages };
    },
  });
}
