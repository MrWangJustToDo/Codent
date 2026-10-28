import { headDisplayLines } from "../../../utils/display-lines.js";

import type { ModelToolContent, ToModelOutputContext } from "../../tools/runtime/contract.js";

/** Extension/LSP tools that return `{ text: string, ... }` for the model. */
export function lspTextToModelOutput(ctx: ToModelOutputContext): ModelToolContent {
  const output = ctx.output as { text?: string } | undefined;
  if (typeof output?.text === "string") return output.text;
  return JSON.stringify(output ?? {});
}

/** Result-body lines the transcript shows; the model still receives the whole text. */
const LSP_DISPLAY_LINES = 12;

/**
 * Result body for the transcript, for the same `{ text }` tools.
 *
 * Every `lsp_*` / tree-sitter tool returned its result in `text` and declared only a fold
 * category, so nothing rendered a body: `formatToolOutput` has no case for those names and
 * `ToolOutputView` shows a non-detailed tool's block only when it has a renderer. A
 * workspace-wide diagnostics dump is also exactly the result that should not own the transcript,
 * so the head is shown and the drop count is stated.
 */
export function lspTextToDisplay(output: unknown): string | undefined {
  const text = (output as { text?: unknown } | undefined)?.text;
  if (typeof text !== "string" || text.trim().length === 0) return undefined;
  return headDisplayLines(text, LSP_DISPLAY_LINES);
}
