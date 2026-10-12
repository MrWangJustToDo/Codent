import { bumpAgentUsage } from "../hooks/use-agent-usage.js";
import { useDynamic } from "../hooks/use-dynamic.js";

import { registerBuiltinCommand } from "./utils/registry.js";

registerBuiltinCommand("clone", {
  immediate: false,
  execute: async (args, ctx) => {
    const session = ctx.getSession();
    if (!session) {
      return { ok: false, error: "Agent not initialized" };
    }

    ctx.saveSessionFromChat?.();

    const name = args.trim();
    const result = await session.dispatch({ type: "session.clone", ...(name ? { name } : {}) });
    if (!result.ok) return { ok: false, error: result.error };

    const data = result.data as
      { sessionId?: string; name?: string; model?: string; uiMessages?: unknown[] } | undefined;

    if (ctx.setMessages && Array.isArray(data?.uiMessages)) {
      ctx.setMessages(data.uiMessages as Parameters<NonNullable<typeof ctx.setMessages>>[0]);
      bumpAgentUsage();
      setTimeout(() => {
        useDynamic.getActions().setDynamicKey(Date.now());
      }, 200);
    }

    return { ok: true, message: `Cloned to a new session: ${data?.name ?? data?.sessionId ?? "session"}` };
  },
});
