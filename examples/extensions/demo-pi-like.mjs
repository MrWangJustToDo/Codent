/**
 * Demo: pi-like extension capabilities.
 *
 * Exercises the extension-system enhancements:
 *   - `session:bootstrap` / `session:shutdown` lifecycle events (per-agent ExtensionEventBus)
 *   - `ctx.ui.render(surface, key, payload)` surface slots + `ctx.ui.notify(message, level)`
 *   - Plain JSON Schema tool (non-Zod) via the widened `inputSchema` type
 *   - `modifiedResult` to rewrite a tool result (here: append a marker to `ext_echo`)
 *
 * Try:
 *   - Ask the agent: "use ext_json_echo to say hi"        (JSON Schema tool)
 *   - Ask the agent: "use ext_echo to say hello"          (result rewritten via modifiedResult)
 */
export default {
  id: "demo-pi-like",
  name: "Demo Pi-like",
  version: "1.0.0",
  description: "Exercises lifecycle events, render surface, JSON Schema tool, modifiedResult",
  activate(ctx) {
    // --- Lifecycle events ---------------------------------------------------
    ctx.registerInterceptor("session:bootstrap", (event) => {
      ctx.logger.info(`[demo-pi-like] session:bootstrap cwd=${event.payload.cwd}`);
      ctx.ui.render("footer", "demo", "LSP-like: idle");
    });

    ctx.registerInterceptor("session:shutdown", (event) => {
      ctx.logger.info(`[demo-pi-like] session:shutdown sessionId=${event.payload.sessionId}`);
      ctx.ui.render("footer", "demo", null);
    });

    // --- Plain JSON Schema tool (non-Zod) -----------------------------------
    ctx.registerTool({
      name: "ext_json_echo",
      description: "Echo a message back using a plain JSON Schema (non-Zod) input schema.",
      // JSON Schema object — accepted via the widened SchemaInput union (no Zod needed).
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "Text to echo" },
        },
        required: ["message"],
        additionalProperties: false,
      },
      execute: async (input) => {
        const message = typeof input?.message === "string" ? input.message : String(input ?? "");
        ctx.logger.info(`[demo-pi-like] ext_json_echo called with: ${message}`);
        return { echoed: `[json-schema] ${message}` };
      },
      present: { text: (result) => `json echo → ${result?.echoed ?? ""}` },
    });

    // --- CoreEnv access ------------------------------------------------------
    ctx.registerCommand({
      name: "ext-root",
      description: "Extension demo — print the CoreEnv rootPath and platform",
      async execute() {
        const platform = await ctx.coreEnv.getPlatform();
        const rootPath = ctx.coreEnv.rootPath;
        const msg = `ext coreEnv: rootPath=${rootPath} platform=${platform}`;
        ctx.logger.info(msg);
        ctx.ui.notify(msg, "info");
        return msg;
      },
    });

    // --- Result modification ------------------------------------------------
    ctx.registerInterceptor("tool:after:ext_echo", (event) => {
      const original = event.payload.result;
      // Append a marker to demonstrate that modifiedResult replaces the model-facing result.
      if (original && typeof original === "object") {
        const rewritten = { ...original, note: "rewritten-by-demo-pi-like" };
        event.payload.modifiedResult = rewritten;
        ctx.logger.info("[demo-pi-like] rewrote ext_echo result via modifiedResult");
      }
    });

    ctx.logger.info("registered /demo-pi-like capabilities");
  },
};
