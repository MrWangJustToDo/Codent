import { bumpAgentUsage } from "../hooks/use-agent-usage.js";

import { registerBuiltinCommand } from "./utils/registry.js";

registerBuiltinCommand("compact", {
  immediate: true,
  execute: async (args, ctx) => {
    const session = ctx.getSession();
    if (!session) {
      return { ok: false, error: "Agent not initialized" };
    }

    const focus = args.trim() || undefined;
    const result = await session.dispatch({ type: "compact", focus });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    const data = result.data as { message?: string } | undefined;
    ctx.setMessages?.(session.getSnapshot().messages);
    bumpAgentUsage();
    return { ok: true, message: data?.message ?? "Compacted" };
  },
});
