/**
 * lsp_hover — type info and docs at a position.
 */

import { errorMessage } from "../../../utils/errors.js";

import { POSITION_PROPERTIES, normalizeLspPath, positionParams, resolvePosition, withResolved } from "./tool-shared.js";

import type { ToolExecutionOptions } from "../../extension/types.js";
import type { LspManager } from "../lsp-manager.js";
import type { Hover, MarkupContent } from "vscode-languageserver-protocol";

function formatHoverContent(hover: Hover): string {
  const contents = hover.contents;
  if (typeof contents === "string") return contents;
  if ("kind" in contents && "value" in contents) return (contents as MarkupContent).value;
  if ("language" in contents && "value" in contents) {
    return `\`\`\`${(contents as { language: string; value: string }).language}\n${(contents as { language: string; value: string }).value}\n\`\`\``;
  }
  if (Array.isArray(contents)) {
    return contents
      .map((c) => {
        if (typeof c === "string") return c;
        if ("language" in c && "value" in c) return `\`\`\`${c.language}\n${c.value}\n\`\`\``;
        return String(c);
      })
      .join("\n\n");
  }
  return String(contents);
}

export interface HoverToolDeps {
  manager: LspManager;
  /** Tree-sitter fallback (optional). */
  fallback?: (filePath: string, line: number, character: number) => Promise<string | null>;
}

export function createHoverTool(deps: HoverToolDeps) {
  return {
    name: "lsp_hover",
    present: { category: "reads" as const },
    description:
      "Get type information and documentation for a symbol at a position (1-indexed line/character, or a query symbol name).",
    inputSchema: {
      type: "object",
      properties: { ...POSITION_PROPERTIES },
      required: ["path"],
      additionalProperties: false,
    },
    execute: async (input: unknown, options: ToolExecutionOptions) => {
      const params = positionParams(input);
      const filePath = normalizeLspPath(params.path) ?? "";

      const pos = await resolvePosition(deps.manager, filePath, params, { signal: options?.abortSignal });
      if (pos.error) return { text: pos.error, hasResult: false };
      const { line, character, resolvedFrom } = pos;

      const client = await deps.manager.getClientForFile(filePath).catch(() => null);

      if (client) {
        const uri = deps.manager.getFileUri(filePath);
        const position = { line: line - 1, character: character - 1 };
        try {
          const hover = await client.connection.sendRequest<Hover | null>(
            "textDocument/hover",
            { textDocument: { uri }, position },
            { signal: options?.abortSignal }
          );
          if (!hover) {
            return {
              text: withResolved(resolvedFrom, "No hover information available at this position."),
              hasResult: false,
            };
          }
          return { text: withResolved(resolvedFrom, formatHoverContent(hover)), hasResult: true };
        } catch (err) {
          const msg = errorMessage(err);
          return { text: `LSP hover request failed: ${msg}`, hasResult: false };
        }
      }

      if (deps.fallback) {
        const fallbackText = await deps.fallback(filePath, line, character);
        if (fallbackText != null) {
          return { text: withResolved(resolvedFrom, fallbackText), hasResult: true, source: "fallback" };
        }
      }

      return { text: deps.manager.getUnavailableReason(filePath), hasResult: false };
    },
  };
}
