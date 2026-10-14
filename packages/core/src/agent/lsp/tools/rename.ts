/**
 * lsp_rename — preview a rename refactoring (returns planned edits, does not apply).
 */

import { errorMessage } from "../../../utils/errors.js";
import { fileUriToPath } from "../shared/format.js";

import { resolvePosition, truncateHead, withResolved } from "./tool-shared.js";

import type { ToolExecutionOptions } from "../../extension/types.js";
import type { LspManager } from "../lsp-manager.js";
import type { WorkspaceEdit, TextEdit } from "vscode-languageserver-protocol";

function formatWorkspaceEdit(
  edit: WorkspaceEdit,
  rootDir: string
): { summary: string; fileCount: number; editCount: number } {
  const lines: string[] = [];
  let totalEdits = 0;
  let fileCount = 0;

  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      if ("textDocument" in change && "edits" in change) {
        fileCount++;
        const relPath = fileUriToPath(change.textDocument.uri, rootDir);
        lines.push(`${relPath}:`);
        for (const textEdit of change.edits as TextEdit[]) {
          const line = textEdit.range.start.line + 1;
          const col = textEdit.range.start.character + 1;
          lines.push(`  ${line}:${col} → "${textEdit.newText}"`);
          totalEdits++;
        }
      }
    }
  }

  const changes = edit.changes ?? {};
  for (const [uri, edits] of Object.entries(changes)) {
    fileCount++;
    const relPath = fileUriToPath(uri, rootDir);
    lines.push(`${relPath}:`);
    for (const textEdit of edits) {
      const line = textEdit.range.start.line + 1;
      const col = textEdit.range.start.character + 1;
      lines.push(`  ${line}:${col} → "${textEdit.newText}"`);
      totalEdits++;
    }
  }

  return { summary: lines.join("\n"), fileCount, editCount: totalEdits };
}

export interface RenameToolDeps {
  manager: LspManager;
}

export function createRenameTool(deps: RenameToolDeps) {
  return {
    name: "lsp_rename",
    present: { category: "edits" as const },
    description:
      "Preview a rename refactoring for a symbol at a position (1-indexed line/character, or query). Returns planned edits across all files; does NOT apply them.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        line: { type: "number", description: "Line number (1-indexed). Required unless query is provided." },
        character: { type: "number", description: "Column number (1-indexed). Required unless query is provided." },
        query: { type: "string", description: "Symbol name to find in the file (alternative to line/character)." },
        newName: { type: "string", description: "New name for the symbol" },
      },
      required: ["path", "newName"],
      additionalProperties: false,
    },
    execute: async (input: unknown, options: ToolExecutionOptions) => {
      const params = input as { path?: string; line?: number; character?: number; query?: string; newName?: string };
      const filePath = (params.path ?? "").replace(/^@/, "");

      const pos = await resolvePosition(deps.manager, filePath, params, { signal: options?.abortSignal });
      if (pos.error) return { text: pos.error, fileCount: 0, editCount: 0 };
      const { line, character, resolvedFrom } = pos;

      const client = await deps.manager.getClientForFile(filePath).catch(() => null);
      if (!client) {
        return { text: deps.manager.getUnavailableReason(filePath), fileCount: 0, editCount: 0 };
      }

      const uri = deps.manager.getFileUri(filePath);
      const position = { line: line - 1, character: character - 1 };

      try {
        const result = await client.connection.sendRequest<WorkspaceEdit | null>(
          "textDocument/rename",
          { textDocument: { uri }, position, newName: params.newName },
          { signal: options?.abortSignal }
        );

        if (!result) {
          return {
            text: withResolved(resolvedFrom, "Rename not possible at this position."),
            fileCount: 0,
            editCount: 0,
          };
        }

        const rootDir = deps.manager.resolvePath(".");
        const { summary, fileCount, editCount } = formatWorkspaceEdit(result, rootDir);

        if (editCount === 0) {
          return { text: withResolved(resolvedFrom, "No edits needed for this rename."), fileCount: 0, editCount: 0 };
        }

        const trunc = truncateHead(summary);
        let text = "";
        if (resolvedFrom) text += `${resolvedFrom}\n\n`;
        text += `Rename "${params.newName}": ${editCount} edit(s) across ${fileCount} file(s)\n\n`;
        text += "NOTE: These changes are NOT applied. Use edit/write tools to make the changes.\n\n";
        text += trunc.content;
        if (trunc.truncated) text += `\n\n[Truncated: showing ${trunc.outputLines} of ${trunc.totalLines} lines]`;

        return { text, fileCount, editCount };
      } catch (err) {
        const msg = errorMessage(err);
        return { text: `LSP rename request failed: ${msg}`, fileCount: 0, editCount: 0 };
      }
    },
  };
}
