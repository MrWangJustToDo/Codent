/**
 * lsp_references — find all references to a symbol.
 */

import { errorMessage } from "../../../utils/errors.js";
import { formatLocation } from "../shared/format.js";

import { resolvePosition, truncateHead, withResolved } from "./tool-shared.js";

import type { ToolExecutionOptions } from "../../extension/types.js";
import type { LspManager } from "../lsp-manager.js";
import type { Location } from "vscode-languageserver-protocol";

export interface ReferencesToolDeps {
  manager: LspManager;
}

export function createReferencesTool(deps: ReferencesToolDeps) {
  return {
    name: "lsp_references",
    present: { category: "reads" as const },
    description:
      "Find all references to a symbol at a position (1-indexed line/character, or a query symbol name). Returns a list of file locations.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        line: { type: "number", description: "Line number (1-indexed). Required unless query is provided." },
        character: { type: "number", description: "Column number (1-indexed). Required unless query is provided." },
        query: { type: "string", description: "Symbol name to find in the file (alternative to line/character)." },
        includeDeclaration: { type: "boolean", description: "Include the declaration in results (default: true)." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    execute: async (input: unknown, options: ToolExecutionOptions) => {
      const params = input as {
        path?: string;
        line?: number;
        character?: number;
        query?: string;
        includeDeclaration?: boolean;
      };
      const filePath = (params.path ?? "").replace(/^@/, "");

      const pos = await resolvePosition(deps.manager, filePath, params, { signal: options?.abortSignal });
      if (pos.error) return { text: pos.error, count: 0 };
      const { line, character, resolvedFrom } = pos;

      const client = await deps.manager.getClientForFile(filePath).catch(() => null);
      if (!client) {
        return { text: deps.manager.getUnavailableReason(filePath), count: 0 };
      }

      const uri = deps.manager.getFileUri(filePath);
      const position = { line: line - 1, character: character - 1 };

      try {
        const locations = await client.connection.sendRequest<Location[] | null>(
          "textDocument/references",
          {
            textDocument: { uri },
            position,
            context: { includeDeclaration: params.includeDeclaration ?? true },
          },
          { signal: options?.abortSignal }
        );

        if (!locations || locations.length === 0) {
          return { text: withResolved(resolvedFrom, "No references found."), count: 0 };
        }

        const rootDir = deps.manager.resolvePath(".");
        const formatted = locations.map((l) => formatLocation(l, rootDir));
        const output = formatted.join("\n");

        const trunc = truncateHead(output);
        let resultText = `${locations.length} reference(s) found:\n\n${trunc.content}`;
        if (trunc.truncated) {
          resultText += `\n\n[Output truncated: showing ${trunc.outputLines} of ${trunc.totalLines} references]`;
        }
        return { text: withResolved(resolvedFrom, resultText), count: locations.length };
      } catch (err) {
        const msg = errorMessage(err);
        return { text: `LSP references request failed: ${msg}`, count: 0 };
      }
    },
  };
}
