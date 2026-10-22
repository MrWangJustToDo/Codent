import { bumpAgentUsage } from "../hooks/use-agent-usage.js";
import { useDynamic } from "../hooks/use-dynamic.js";

import { registerBuiltinCommand } from "./utils/registry.js";

registerBuiltinCommand("new", {
  immediate: true,
  execute: async (_args, ctx) => {
    const session = ctx.getSession();
    if (!session) {
      return { ok: false, error: "Agent not initialized" };
    }

    ctx.saveSessionFromChat?.();
    const result = await session.dispatch({ type: "session.new" });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    // Transcript and session-scoped caches are invalidated by the final
    // `state.sessionId` update in useAgentChat; do not write either here a second time.
    bumpAgentUsage();
    setTimeout(() => {
      useDynamic.getActions().setDynamicKey(Date.now());
    }, 100);

    return { ok: true, message: "New session started" };
  },
});
