import type { ModelToolContent, ToModelOutputContext } from "../../tools/runtime/contract.js";

/** Extension/LSP tools that return `{ text: string, ... }` for the model. */
export function lspTextToModelOutput(ctx: ToModelOutputContext): ModelToolContent {
  const output = ctx.output as { text?: string } | undefined;
  if (typeof output?.text === "string") return output.text;
  return JSON.stringify(output ?? {});
}
