/**
 * lsp_code_actions — get available code actions (quick fixes, refactorings) at a position.
 */

import { errorMessage } from "../../../utils/errors.js";
import { truncateText } from "../../../utils/text-truncation.js";
import { fileUriToPath } from "../shared/format.js";

import { resolvePosition, withResolved } from "./tool-shared.js";

import type { ToolExecutionOptions } from "../../extension/types.js";
import type { LspManager } from "../lsp-manager.js";
import type { CodeAction, Command, Diagnostic, TextEdit, WorkspaceEdit } from "vscode-languageserver-protocol";

type CodeActionResponse = (CodeAction | Command)[] | null;

function rangeContainsPosition(
  range: { start: { line: number; character: number }; end: { line: number; character: number } },
  line: number,
  character: number
): boolean {
  if (line < range.start.line || line > range.end.line) return false;
  if (line === range.start.line && character < range.start.character) return false;
  if (line === range.end.line && character > range.end.character) return false;
  return true;
}

function formatEditSummary(edit: WorkspaceEdit, rootDir: string): string[] {
  const lines: string[] = [];
  const collect = (uri: string, edits: TextEdit[]) => {
    const relPath = fileUriToPath(uri, rootDir);
    for (const textEdit of edits.slice(0, 5)) {
      const ln = textEdit.range.start.line + 1;
      const col = textEdit.range.start.character + 1;
      const endLn = textEdit.range.end.line + 1;
      const endCol = textEdit.range.end.character + 1;
      const newText = truncateText(textEdit.newText, 60);
      if (
        textEdit.range.start.line === textEdit.range.end.line &&
        textEdit.range.start.character === textEdit.range.end.character
      ) {
        lines.push(`     ${relPath}:${ln}:${col} insert "${newText.replace(/\n/g, "\\n")}"`);
      } else {
        lines.push(`     ${relPath}:${ln}:${col}-${endLn}:${endCol} → "${newText.replace(/\n/g, "\\n")}"`);
      }
    }
    const remaining = edits.length - 5;
    if (remaining > 0) lines.push(`     ... and ${remaining} more edits in ${relPath}`);
  };

  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      if ("textDocument" in change && "edits" in change) {
        collect(change.textDocument.uri, change.edits as TextEdit[]);
      }
    }
  }
  const changes = edit.changes ?? {};
  for (const [uri, edits] of Object.entries(changes)) {
    collect(uri, edits);
  }
  return lines;
}

function isCodeAction(item: CodeAction | Command): item is CodeAction {
  return "kind" in item || "edit" in item || "diagnostics" in item || "isPreferred" in item;
}

export interface CodeActionsToolDeps {
  manager: LspManager;
}

export function createCodeActionsTool(deps: CodeActionsToolDeps) {
  return {
    name: "lsp_code_actions",
    present: { category: "searches" as const },
    description:
      "Get available code actions (quick fixes, refactorings, source actions) at a position or range. Use after lsp_diagnostics shows errors to find auto-fixes.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        line: { type: "number", description: "Line number (1-indexed). Required unless query is provided." },
        character: { type: "number", description: "Column number (1-indexed). Required unless query is provided." },
        query: { type: "string", description: "Symbol name to find in the file (alternative to line/character)." },
        endLine: { type: "number", description: "End line for range selection (1-indexed). Defaults to line." },
        endCharacter: {
          type: "number",
          description: "End column for range selection (1-indexed). Defaults to character.",
        },
        kind: { type: "string", description: 'Filter by action kind (e.g., "quickfix", "refactor", "source").' },
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
        endLine?: number;
        endCharacter?: number;
        kind?: string;
      };
      const filePath = (params.path ?? "").replace(/^@/, "");

      const pos = await resolvePosition(deps.manager, filePath, params, { signal: options?.abortSignal });
      if (pos.error) return { text: pos.error, count: 0, preferredCount: 0 };
      const { line, character, resolvedFrom } = pos;

      const client = await deps.manager.getClientForFile(filePath).catch(() => null);
      if (!client) {
        return { text: deps.manager.getUnavailableReason(filePath), count: 0, preferredCount: 0 };
      }

      const caps = client.connection.serverCapabilities as { codeActionProvider?: unknown } | null;
      if (caps && !caps.codeActionProvider) {
        return { text: "LSP server for this file does not support code actions.", count: 0, preferredCount: 0 };
      }

      const uri = deps.manager.getFileUri(filePath);
      const startLine = line - 1;
      const startChar = character - 1;
      const endLine = (params.endLine ?? line) - 1;
      const endChar = (params.endCharacter ?? character) - 1;

      const allDiags = deps.manager.getDiagnostics(uri) as Diagnostic[];
      const rangeDiags = allDiags.filter(
        (d) =>
          rangeContainsPosition(d.range, startLine, startChar) ||
          rangeContainsPosition(
            { start: { line: startLine, character: startChar }, end: { line: endLine, character: endChar } },
            d.range.start.line,
            d.range.start.character
          )
      );

      try {
        const response = await client.connection.sendRequest<CodeActionResponse>(
          "textDocument/codeAction",
          {
            textDocument: { uri },
            range: { start: { line: startLine, character: startChar }, end: { line: endLine, character: endChar } },
            context: { diagnostics: rangeDiags, only: params.kind ? [params.kind] : undefined },
          },
          { signal: options?.abortSignal }
        );

        if (!response || response.length === 0) {
          return {
            text: withResolved(resolvedFrom, "No code actions available at this position."),
            count: 0,
            preferredCount: 0,
          };
        }

        const actions: CodeAction[] = [];
        const commands: Command[] = [];
        for (const item of response) {
          if (isCodeAction(item)) actions.push(item);
          else commands.push(item);
        }

        const kindOrder: Record<string, number> = { quickfix: 0, refactor: 1, source: 2 };
        actions.sort((a, b) => {
          if (a.isPreferred && !b.isPreferred) return -1;
          if (!a.isPreferred && b.isPreferred) return 1;
          const aKind = a.kind?.split(".")[0] ?? "zzz";
          const bKind = b.kind?.split(".")[0] ?? "zzz";
          return (kindOrder[aKind] ?? 3) - (kindOrder[bKind] ?? 3);
        });

        const rootDir = deps.manager.resolvePath(".");
        const outputLines: string[] = [];
        let preferredCount = 0;

        for (let i = 0; i < actions.length; i++) {
          const action = actions[i];
          const preferred = action.isPreferred ? "★ " : "";
          if (action.isPreferred) preferredCount++;
          const kindStr = action.kind ? ` [${action.kind}]` : "";
          outputLines.push(`  ${i + 1}. ${preferred}${action.title}${kindStr}`);
          if (action.edit) {
            outputLines.push(...formatEditSummary(action.edit, rootDir));
          } else if (action.command && !action.edit) {
            outputLines.push(`     (command: ${action.command.title || action.command.command})`);
          } else {
            outputLines.push("     (resolve required)");
          }
        }
        for (const cmd of commands) {
          outputLines.push(`  • ${cmd.title} (command-only, requires IDE execution)`);
        }

        const totalCount = actions.length + commands.length;
        const header = `${totalCount} code action(s) at ${filePath}:${line}:${character}`;
        const preferredNote = preferredCount > 0 ? ` (${preferredCount} preferred)` : "";

        let text = `${header}${preferredNote}\n\n${outputLines.join("\n")}`;
        if (resolvedFrom) text = `${resolvedFrom}\n\n${text}`;

        return { text, count: totalCount, preferredCount };
      } catch (err) {
        const msg = errorMessage(err);
        return { text: `LSP code action request failed: ${msg}`, count: 0, preferredCount: 0 };
      }
    },
  };
}
