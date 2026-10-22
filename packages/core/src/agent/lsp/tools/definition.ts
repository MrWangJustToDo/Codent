/**
 * lsp_definition — go to the definition of a symbol.
 */

import { errorMessage } from "../../../utils/errors.js";
import { findDefinition, getNodeAtPosition } from "../../tree-sitter/symbol-extractor.js";
import { formatLocation, formatLocationLink } from "../shared/format.js";

import { resolvePosition, withResolved } from "./tool-shared.js";

import type { ToolExecutionOptions } from "../../extension/types.js";
import type { TreeSitterManager } from "../../tree-sitter/parser-manager.js";
import type { WorkspaceIndex } from "../../tree-sitter/workspace-index.js";
import type { LspManager } from "../lsp-manager.js";
import type { Location, LocationLink } from "vscode-languageserver-protocol";

type DefinitionResult = Location | Location[] | LocationLink[] | null;

export interface DefinitionToolDeps {
  manager: LspManager;
  treeSitter?: TreeSitterManager | null;
  workspaceIndex?: WorkspaceIndex | null;
  readFile?: (absPath: string) => Promise<string>;
}

async function treeSitterDefinitionFallback(
  deps: DefinitionToolDeps,
  filePath: string,
  line: number,
  character: number,
  resolvedFrom?: string
): Promise<{ text: string; count: number; source?: string } | null> {
  if (!deps.treeSitter?.available()) return null;

  const absPath = deps.manager.resolvePath(filePath);
  const readFile = deps.readFile ?? ((p) => deps.manager.readFileIfPossible(p).then((c) => c ?? ""));
  const languageId = deps.manager.getLanguageId(filePath);
  if (!languageId) return null;

  try {
    const content = await readFile(absPath);
    if (!content) return null;
    const tree = await deps.treeSitter.parse(absPath, content);
    if (!tree) return null;

    const node = getNodeAtPosition(tree, line - 1, character - 1);
    if (!node) return null;

    const symbolName = node.text;
    const relPath = deps.manager.pathRelative(filePath);

    const localDefs = findDefinition(tree, symbolName, languageId);
    if (localDefs.length > 0) {
      const locs = localDefs.map((d) => `${relPath}:${d.line}:1`);
      const body =
        locs.length === 1
          ? `Definition [tree-sitter]: ${locs[0]}`
          : `Definitions [tree-sitter]:\n${locs.map((l) => `  ${l}`).join("\n")}`;
      return { text: withResolved(resolvedFrom, body), count: locs.length, source: "fallback" };
    }

    if (deps.workspaceIndex) {
      await deps.workspaceIndex.build();
      const entries = deps.workspaceIndex.search(symbolName);
      const exact = entries.filter((e) => e.name === symbolName);
      if (exact.length > 0) {
        const rootDir = deps.manager.resolvePath(".");
        const locs = exact.slice(0, 10).map((e) => {
          const rel = e.file.startsWith(rootDir) ? e.file.slice(rootDir.length).replace(/^[/\\]/, "") || "." : e.file;
          return `${rel}:${e.line}:1`;
        });
        const body =
          locs.length === 1
            ? `Definition [tree-sitter]: ${locs[0]}`
            : `Definitions [tree-sitter]:\n${locs.map((l) => `  ${l}`).join("\n")}`;
        return { text: withResolved(resolvedFrom, body), count: locs.length, source: "fallback" };
      }
    }

    const msg = `No definition found for "${symbolName}" [tree-sitter]`;
    return { text: withResolved(resolvedFrom, msg), count: 0, source: "fallback" };
  } catch {
    return null;
  }
}

export function createDefinitionTool(deps: DefinitionToolDeps) {
  return {
    name: "lsp_definition",
    present: { category: "reads" as const },
    description:
      "Go to the definition of a symbol at a position (1-indexed line/character, or a query symbol name). Returns the file path and location of the definition.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        line: { type: "number", description: "Line number (1-indexed). Required unless query is provided." },
        character: { type: "number", description: "Column number (1-indexed). Required unless query is provided." },
        query: { type: "string", description: "Symbol name to find in the file (alternative to line/character)." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    execute: async (input: unknown, options: ToolExecutionOptions) => {
      const params = input as { path?: string; line?: number; character?: number; query?: string };
      const filePath = (params.path ?? "").replace(/^@/, "");

      const pos = await resolvePosition(deps.manager, filePath, params, { signal: options?.abortSignal });
      if (pos.error) return { text: pos.error, count: 0 };
      const { line, character, resolvedFrom } = pos;

      const client = await deps.manager.getClientForFile(filePath).catch(() => null);

      if (client) {
        const uri = deps.manager.getFileUri(filePath);
        const position = { line: line - 1, character: character - 1 };
        try {
          const result = await client.connection.sendRequest<DefinitionResult>(
            "textDocument/definition",
            { textDocument: { uri }, position },
            { signal: options?.abortSignal }
          );

          if (!result || (Array.isArray(result) && result.length === 0)) {
            const fallback = await treeSitterDefinitionFallback(deps, filePath, line, character, resolvedFrom);
            if (fallback) return fallback;
            return { text: withResolved(resolvedFrom, "No definition found."), count: 0 };
          }

          const rootDir = deps.manager.resolvePath(".");
          let locations: string[];

          if (Array.isArray(result)) {
            if ("targetUri" in result[0]) {
              locations = (result as LocationLink[]).map((l) => formatLocationLink(l, rootDir));
            } else {
              locations = (result as Location[]).map((l) => formatLocation(l, rootDir));
            }
          } else {
            locations = [formatLocation(result as Location, rootDir)];
          }

          const text =
            locations.length === 1
              ? `Definition: ${locations[0]}`
              : `Definitions:\n${locations.map((l) => `  ${l}`).join("\n")}`;
          return { text: withResolved(resolvedFrom, text), count: locations.length };
        } catch (err) {
          const msg = errorMessage(err);
          return { text: `LSP definition request failed: ${msg}`, count: 0 };
        }
      }

      const fallback = await treeSitterDefinitionFallback(deps, filePath, line, character, resolvedFrom);
      if (fallback) return fallback;

      return { text: deps.manager.getUnavailableReason(filePath), count: 0 };
    },
  };
}
