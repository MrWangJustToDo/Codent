/**
 * Todo reminder middleware — the delivery half of the todo nag.
 *
 * The nag used to ride along with the turn-context middleware, but it is a different kind of
 * injection: turn context is **hash-admitted** (inject when the content differs), while this is
 * **condition + counter** (inject when the window's round counter crosses the schedule). The
 * scan itself lives in `agent/turn-context/reminder/todo-reminder.ts` next to the repeat nudge;
 * this module only resolves it against the wire it was handed and delivers it through the
 * shared synthetic-injection path (channel + wire in sync, persisted).
 */

import { resolveTodoReminder } from "../../agent/turn-context/reminder";
import { injectSyntheticMessages, nextSyntheticNonce } from "../../agent/turn-context/synthetic-injection.js";
import { TURN_CONTEXT_KINDS, formatContextSectionUserContent } from "../../agent/turn-context/turn-context-message.js";

import { defineMiddleware } from "./phase.js";

import type { TodoManager } from "../../agent/todo";
import type { AgentUIChannel } from "../../agent/ui/ui-channel.js";
import type { ChatMiddleware, ModelMessage, UIMessage } from "@tanstack/ai";

export interface TodoReminderMiddlewareDeps {
  /** The owning agent's todo list (root agents only; subagents get `null`). */
  getTodoManager: () => TodoManager | null;
  /** Live access to the UI channel (to persist the synthetic reminder). */
  getUIChannel: () => AgentUIChannel | undefined;
  /** Persist the updated UI messages (no-op for subagents without a session store). */
  persistMessages: (next: UIMessage[]) => void;
}

/**
 * Nudge the model to keep its todo list current.
 *
 * Runs on every model call and reads the round/episode state back from the window, so a
 * compaction cut, a restore or a restart cannot replay or lose the schedule. With no channel
 * the nag is wire-only (transient), by the same contract as the other synthetic sections.
 */
export function createTodoReminderMiddleware(deps: TodoReminderMiddlewareDeps): ChatMiddleware {
  return defineMiddleware("tools", {
    name: "todo-reminder",
    onConfig: async (_ctx, config) => {
      const messages = config.messages as ModelMessage[];
      const section = resolveTodoReminder(deps.getTodoManager(), messages);
      if (!section) return {};

      const content = formatContextSectionUserContent(section);
      const ui = deps.getUIChannel();
      if (!ui) return { messages: [...messages, { role: "user", content }] };

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
