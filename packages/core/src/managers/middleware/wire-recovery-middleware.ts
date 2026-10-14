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
 * Zero-overhead contract: with no override armed (the common case, and always the
 * case for subagents and for models with full capabilities) this returns `{}`, so
 * the pipeline behaves exactly as if the middleware did not exist.
 */

import { parseStringifiedMultimodalContent } from "../../agent/media/repair-stringified-multimodal.js";
import {
  stripMultimodalContentParts,
  stripMultimodalFromChatMessages,
} from "../../models/adapter/capability-message-utils.js";
import { CONTINUATION_PROMPT } from "../stream-recovery/max-tokens-continue.js";

import { defineMiddleware } from "./phase.js";

import type { ToolRunContext } from "../../agent/runner/run-context.js";
import type { RunCoordinator } from "../run-coordinator.js";
import type { ContentPart, ChatMiddleware, ModelMessage } from "@tanstack/ai";
import type { MultimodalPartType } from "../../models/adapter/capability-message-utils.js";

export interface WireRecoveryMiddlewareDeps {
  /** Per-run override state (survives retries within one run). */
  getRun: () => RunCoordinator | undefined;
}

/**
 * Rewrite string-content tool results that carry media the model cannot take.
 *
 * Chat Completions accepts only string `tool` content, so TanStack persists an array result with
 * `JSON.stringify` — and in that form the media is not a content part at all until something
 * re-parses it. The two readers that do are the tool-output projection (skipped when the tool has no
 * registered `toModelOutput`, and never run for a subagent) and the adapter's
 * `liftToolMediaForChatCompletions`, which runs after every middleware and does not consult the drop
 * set. So this seam has to handle the string form itself, or a model without vision is sent the tool's
 * image anyway — on the one path where the widened retry cannot help, because the same string comes
 * back on every call.
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

export function createWireRecoveryMiddleware(deps: WireRecoveryMiddlewareDeps): ChatMiddleware<ToolRunContext> {
  return defineMiddleware("context-transform", {
    name: "wire-recovery",
    onConfig: (_ctx, config) => {
      const run = deps.getRun();
      if (!run) return {};

      const drop = run.getWireDropPartTypes();
      const armed = run.isWireContinuationArmed();
      if (!drop?.size && !armed) return {};

      let messages = config.messages as ModelMessage[];

      if (drop?.size) {
        messages = stripMultimodalFromChatMessages(messages, drop);
        messages = stripStringifiedToolMedia(messages, drop);
      }

      if (armed) {
        messages = [...messages, { role: "user" as const, content: CONTINUATION_PROMPT }];
      }

      return { messages };
    },
  });
}
