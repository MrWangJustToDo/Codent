import { registerBuiltinCommand } from "./utils/registry.js";

registerBuiltinCommand("rename", {
  immediate: false,
  allowCustomInput: true,
  getOptions: () => [
    {
      label: "auto",
      value: "",
      description: "Generate a title from recent conversation",
    },
  ],
  execute: async (args, ctx) => {
    const session = ctx.getSession();
    if (!session) {
      return { ok: false, error: "Agent not initialized" };
    }

    const title = args.trim();
    if (title) {
      const result = await session.dispatch({ type: "rename", name: title });
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, message: `Session renamed: ${title}` };
    }

    ctx.inputActions.setInputFeedback("Generating title...", "info");
    const result = await session.dispatch({ type: "rename.generate" });
    if (!result.ok) return { ok: false, error: result.error };
    const name = (result.data as { name?: string } | undefined)?.name;
    return { ok: true, message: `Session renamed: ${name ?? "(generated)"}` };
  },
});
