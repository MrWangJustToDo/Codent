import { registerBuiltinCommand } from "./utils/registry.js";

registerBuiltinCommand("quit", {
  immediate: true,
  execute: (_args, ctx) => {
    if (ctx.exit) {
      ctx.exit();
    }
    return { ok: true };
  },
});
