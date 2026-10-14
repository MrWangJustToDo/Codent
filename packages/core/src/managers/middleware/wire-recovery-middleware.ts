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

import { stripMultimodalFromChatMessages } from "../../models/adapter/capability-message-utils.js";
import { CONTINUATION_PROMPT } from "../stream-recovery/max-tokens-continue.js";

import { defineMiddleware } from "./phase.js";

import type { ToolRunContext } from "../../agent/runner/run-context.js";
import type { RunCoordinator } from "../run-coordinator.js";
import type { ChatMiddleware, ModelMessage } from "@tanstack/ai";

export interface WireRecoveryMiddlewareDeps {
  /** Per-run override state (survives retries within one run). */
  getRun: () => RunCoordinator | undefined;
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
      }

      if (armed) {
        messages = [...messages, { role: "user" as const, content: CONTINUATION_PROMPT }];
      }

      return { messages };
    },
  });
}
