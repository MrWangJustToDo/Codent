/**
 * Repeat-tool-call reminder — the middleware half of a condition + counter reminder.
 *
 * The decision and the text live in `agent/turn-context/reminder/repeat-reminder.ts`, next
 * to the todo nag, because both ask the window the same question. This module only does
 * what a middleware owns: resolve the section against the wire it was handed, then deliver
 * it through the shared synthetic-injection path (channel + wire in sync, persisted).
 */

import { resolveRepeatReminder } from "../../agent/turn-context/reminder";
import { injectSyntheticMessages, nextSyntheticNonce } from "../../agent/turn-context/synthetic-injection.js";
import { TURN_CONTEXT_KINDS, formatContextSectionUserContent } from "../../agent/turn-context/turn-context-message.js";

import { defineMiddleware } from "./phase.js";

import type { AgentUIChannel } from "../../agent/ui/ui-channel.js";
import type { ChatMiddleware, ModelMessage, UIMessage } from "@tanstack/ai";

export interface RepeatReminderMiddlewareDeps {
  /** Consecutive-repeat counts that trigger a reminder (default `DEFAULT_REPEAT_THRESHOLDS`). */
  thresholds?: number[];
  /** Tools that never count (default `DEFAULT_REPEAT_EXCLUDED_TOOLS`). */
  excludeTools?: string[];
  /** Max characters of the repeated arguments quoted in the detailed reminder. */
  argumentsPreviewChars?: number;
  /** Live access to the UI channel (to persist the synthetic reminder). */
  getUIChannel: () => AgentUIChannel | undefined;
  /** Persist the updated UI messages (no-op for subagents without a session store). */
  persistMessages: (next: UIMessage[]) => void;
}

/**
 * Add-run loop hygiene: nudge the model out of identical tool-call loops.
 *
 * Runs on every model call and reads the loop straight off the wire, so a retry, an aborted
 * run, a compaction cut or a restore all produce the same answer. With no channel the nudge
 * is wire-only (transient), by the same contract as turn context.
 */
export function createRepeatReminderMiddleware(deps: RepeatReminderMiddlewareDeps): ChatMiddleware {
  return defineMiddleware("tools", {
    name: "repeat-reminder",
    onConfig: async (_ctx, config) => {
      const messages = config.messages as ModelMessage[];
      const resolved = resolveRepeatReminder(messages, {
        thresholds: deps.thresholds,
        excludeTools: deps.excludeTools,
        previewChars: deps.argumentsPreviewChars,
      });
      if (!resolved) return {};

      const content = formatContextSectionUserContent(resolved.section);
      const ui = deps.getUIChannel();
      if (!ui) {
        // No channel: transient wire-only injection (still a new array).
        return { messages: [...messages, { role: "user", content }] };
      }

      // The kind is shared with the todo nag; the nonce only has to make the id unique, so an
      // identical chain at the same count in a later turn still lands as a new message.
      const kind = TURN_CONTEXT_KINDS.reminder;
      const { messages: next } = injectSyntheticMessages(
        messages,
        [{ kind, content, nonce: nextSyntheticNonce(ui.getMessages(), kind) }],
        { ui, persist: deps.persistMessages }
      );
      return { messages: next };
    },
  });
}
