import { BUILTIN_TOOL_NAMES } from "../../tools/catalog/tool-names.js";

import type { ModelToolContent, ToModelOutputContext } from "../../tools/runtime/contract.js";

/** Extension/LSP tools that return `{ text: string, ... }` for the model. */
export function lspTextToModelOutput(ctx: ToModelOutputContext): ModelToolContent {
  const output = ctx.output as { text?: string } | undefined;
  if (typeof output?.text === "string") return output.text;
  return JSON.stringify(output ?? {});
}

export const LSP_TEXT_TOOL_NAMES = [
  BUILTIN_TOOL_NAMES.lspDiagnostics,
  BUILTIN_TOOL_NAMES.lspHover,
  BUILTIN_TOOL_NAMES.lspDefinition,
  BUILTIN_TOOL_NAMES.lspReferences,
  BUILTIN_TOOL_NAMES.lspSymbols,
  BUILTIN_TOOL_NAMES.lspRename,
  BUILTIN_TOOL_NAMES.lspCompletions,
  BUILTIN_TOOL_NAMES.lspCodeActions,
  BUILTIN_TOOL_NAMES.codeOverview,
  BUILTIN_TOOL_NAMES.astSearch,
  BUILTIN_TOOL_NAMES.codeRewrite,
] as const;
