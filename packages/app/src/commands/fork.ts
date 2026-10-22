import { isContextUIMessage } from "@codent/core";

import { bumpAgentUsage } from "../hooks/use-agent-usage.js";
import { useDynamic } from "../hooks/use-dynamic.js";
import { getTextContent } from "../utils/get-messages.js";
import { getActiveSession } from "../utils/session-resolve.js";

import { registerBuiltinCommand } from "./utils/registry.js";

import type { TextPart, UIMessage } from "@tanstack/ai";

/** Text of a user message's text parts. */
function messageText(message: UIMessage): string {
  const textParts = (Array.isArray(message.parts) ? message.parts : []).filter(
    (part) => part.type === "text"
  ) as TextPart[];
  return textParts.map(getTextContent).join("\n").trim();
}

registerBuiltinCommand("fork", {
  immediate: false,
  allowCustomInput: true,
  getOptions: () => {
    const snapshot = getActiveSession()?.getSnapshot();
    const messages = (snapshot?.messages ?? []) as UIMessage[];
    return messages
      .filter((message) => message.role === "user" && !isContextUIMessage(message))
      .map((message) => {
        const text = messageText(message).replace(/\s+/g, " ").slice(0, 80);
        return { label: text || "(empty message)", value: message.id };
      });
  },
  execute: async (args, ctx) => {
    const session = ctx.getSession();
    if (!session) {
      return { ok: false, error: "Agent not initialized" };
    }

    const upToMessageId = args.trim();
    if (!upToMessageId) {
      return { ok: false, error: "Pick a message to fork from (open the /fork menu)." };
    }

    ctx.saveSessionFromChat?.();

    const result = await session.dispatch({ type: "session.fork", upToMessageId });
    if (!result.ok) return { ok: false, error: result.error };

    const data = result.data as { sessionId?: string; name?: string; model?: string; forkText?: string } | undefined;

    // The restored fork transcript arrives through the core `messages` channel.
    bumpAgentUsage();
    setTimeout(() => {
      useDynamic.getActions().setDynamicKey(Date.now());
    }, 200);

    // Hand the chosen message back so the user edits and resends it to branch.
    if (data?.forkText) {
      ctx.inputActions.setValue(data.forkText);
    }

    return { ok: true, message: "Forked — edit the message above and resend to branch." };
  },
});
