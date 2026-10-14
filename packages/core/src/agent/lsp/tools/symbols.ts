/**
 * lsp_symbols — list symbols in a file or search workspace symbols.
 */

import { errorMessage } from "../../../utils/errors.js";
import { fileUriToPath } from "../shared/format.js";

import { truncateHead } from "./tool-shared.js";

import type { ToolExecutionOptions } from "../../extension/types.js";
import type { LspManager } from "../lsp-manager.js";
import type { WorkspaceIndex } from "../tree-sitter/workspace-index.js";
import type { DocumentSymbol, SymbolInformation } from "vscode-languageserver-protocol";

const SYMBOL_KIND_NAMES: Record<number, string> = {
  1: "file",
  2: "module",
  3: "namespace",
  4: "package",
  5: "class",
  6: "method",
  7: "property",
  8: "field",
  9: "constructor",
  10: "enum",
  11: "interface",
  12: "function",
  13: "variable",
  14: "constant",
  15: "string",
  16: "number",
  17: "boolean",
  18: "array",
  19: "object",
  20: "key",
  21: "null",
  22: "enum-member",
  23: "struct",
  24: "event",
  25: "operator",
  26: "type-param",
};

function kindName(kind: number | undefined): string {
  return kind != null ? (SYMBOL_KIND_NAMES[kind] ?? `kind(${kind})`) : "unknown";
}

function formatDocumentSymbol(sym: DocumentSymbol, indent = 0): string[] {
  const prefix = "  ".repeat(indent);
  const line = sym.range.start.line + 1;
  const result = [`${prefix}${kindName(sym.kind)} ${sym.name} (line ${line})`];
  if (sym.children) {
    for (const child of sym.children) result.push(...formatDocumentSymbol(child, indent + 1));
  }
  return result;
}

export interface SymbolsToolDeps {
  manager: LspManager;
  /** Workspace symbol fallback via tree-sitter index (optional). */
  workspaceIndex?: WorkspaceIndex | null;
}

export function createSymbolsTool(deps: SymbolsToolDeps) {
  return {
    name: "lsp_symbols",
    present: { category: "reads" as const },
    description: "List symbols in a file (pass path) or search symbols across the workspace (pass query).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path for document symbols." },
        query: { type: "string", description: "Search query for workspace symbols (searches across all files)." },
      },
      additionalProperties: false,
    },
    execute: async (input: unknown, options: ToolExecutionOptions) => {
      const params = input as { path?: string; query?: string };
      const filePath = params.path?.replace(/^@/, "");
      const query = params.query;

      if (!filePath && query === undefined) {
        return {
          text: "Please provide either 'path' for file symbols or 'query' for workspace symbol search.",
          count: 0,
        };
      }

      // Document symbols
      if (filePath) {
        const client = await deps.manager.getClientForFile(filePath).catch(() => null);
        if (client) {
          const uri = deps.manager.getFileUri(filePath);
          try {
            const result = await client.connection.sendRequest<DocumentSymbol[] | SymbolInformation[] | null>(
              "textDocument/documentSymbol",
              { textDocument: { uri } },
              { signal: options?.abortSignal }
            );

            if (!result || result.length === 0) {
              return { text: "No symbols found in this file.", count: 0 };
            }

            const lines =
              "range" in result[0]
                ? (result as DocumentSymbol[]).flatMap((s) => formatDocumentSymbol(s))
                : (result as SymbolInformation[]).map((s) => `${kindName(s.kind)} ${s.name}`);

            const output = lines.join("\n");
            const trunc = truncateHead(output);
            let text = `${lines.length} symbol(s):\n\n${trunc.content}`;
            if (trunc.truncated) text += `\n\n[Truncated: showing ${trunc.outputLines} of ${trunc.totalLines} lines]`;
            return { text, count: lines.length };
          } catch (err) {
            const msg = errorMessage(err);
            return { text: `LSP document symbols request failed: ${msg}`, count: 0 };
          }
        }

        return { text: deps.manager.getUnavailableReason(filePath), count: 0 };
      }

      // Workspace symbol search
      const statuses = deps.manager.getStatus();
      const runningLang = statuses.find((s) => s.running)?.languageId;

      if (runningLang) {
        const client = await deps.manager.getClientForLanguage(runningLang).catch(() => null);
        if (client) {
          try {
            const result = await client.connection.sendRequest<SymbolInformation[] | null>(
              "workspace/symbol",
              { query: query ?? "" },
              { signal: options?.abortSignal }
            );
            if (!result || result.length === 0) {
              return { text: `No workspace symbols found for query: "${query}"`, count: 0 };
            }
            const rootDir = deps.manager.resolvePath(".");
            const lines = result.map((s) => {
              let location = "";
              if (s.location) {
                const absPath = fileUriToPath(s.location.uri, rootDir);
                const line = (s.location as unknown as { range?: { start?: { line?: number } } }).range?.start?.line;
                location = ` ${absPath}:${line != null ? line + 1 : "?"}`;
              }
              return `${kindName(s.kind)} ${s.name}${location}`;
            });
            const output = lines.join("\n");
            const trunc = truncateHead(output);
            let text = `${result.length} symbol(s) found:\n\n${trunc.content}`;
            if (trunc.truncated) text += `\n\n[Truncated: showing ${trunc.outputLines} of ${trunc.totalLines} lines]`;
            return { text, count: result.length };
          } catch (err) {
            const msg = errorMessage(err);
            return { text: `LSP workspace symbols request failed: ${msg}`, count: 0 };
          }
        }
      }

      // Tree-sitter workspace fallback
      if (deps.workspaceIndex && query) {
        await deps.workspaceIndex.build();
        const results = deps.workspaceIndex.search(query);
        if (results.length > 0) {
          const rootDir = deps.manager.resolvePath(".");
          const lines = results.slice(0, 50).map((e) => {
            const rel = e.file.startsWith(rootDir) ? e.file.slice(rootDir.length).replace(/^[/\\]/, "") || "." : e.file;
            return `${e.kind} ${e.name} ${rel}:${e.line}`;
          });
          const output = lines.join("\n");
          const trunc = truncateHead(output);
          let text = `${results.length} symbol(s) found [tree-sitter]:\n\n${trunc.content}`;
          if (trunc.truncated) text += `\n\n[Truncated: showing ${trunc.outputLines} of ${trunc.totalLines} lines]`;
          return { text, count: results.length, source: "fallback" };
        }
        return { text: `No workspace symbols found for query: "${query}" [tree-sitter]`, count: 0, source: "fallback" };
      }

      return {
        text: "No LSP servers are currently running and no workspace index is available. Use lsp_diagnostics or lsp_hover on a file first to start a server.",
        count: 0,
      };
    },
  };
}
