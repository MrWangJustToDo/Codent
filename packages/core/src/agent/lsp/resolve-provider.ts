/**
 * Resolve Provider — determines whether to use LSP or tree-sitter for a file.
 *
 * LSP takes priority when available. Tree-sitter is the fallback.
 */

import type { LspManager } from "./lsp-manager.js";
import type { TreeSitterManager } from "../tree-sitter/parser-manager.js";

export type ProviderResult =
  { type: "lsp" } | { type: "tree-sitter"; languageId: string } | { type: "none"; reason: string };

/**
 * Determine the best intelligence provider for a file.
 *
 * 1. If an LSP server is running and initialized → "lsp"
 * 2. If tree-sitter has a grammar for the language → "tree-sitter"
 * 3. Otherwise → "none" with a human-readable reason
 */
export function resolveProvider(
  filePath: string,
  manager: LspManager,
  treeSitter: TreeSitterManager | null
): ProviderResult {
  const languageId = manager.getLanguageId(filePath);

  if (languageId) {
    // Check if LSP is running for this language
    const client = manager.getRunningClient(languageId);
    if (client) return { type: "lsp" };

    // Check if LSP is starting (server will be ready soon)
    if (manager.isServerStarting(languageId)) {
      // Still prefer tree-sitter for now since LSP isn't ready yet
      if (treeSitter?.hasGrammar(languageId)) {
        return { type: "tree-sitter", languageId };
      }
      return { type: "none", reason: `LSP server for ${languageId} is still starting up. Try again in a moment.` };
    }
  }

  // No LSP — try tree-sitter
  if (treeSitter) {
    const tsLang = treeSitter.getLanguageId(filePath);
    if (tsLang && treeSitter.hasGrammar(tsLang)) {
      return { type: "tree-sitter", languageId: tsLang };
    }
  }

  // No intelligence available
  const ext = filePath.match(/\.[^.]+$/)?.[0] ?? "";
  return {
    type: "none",
    reason: `No code intelligence available for ${ext || "this file type"}. No LSP server is running and no tree-sitter grammar is available.`,
  };
}

/**
 * Check if an LSP server is available and running for a language.
 * Does NOT start a server — just checks if one is already running.
 */
export function hasLspServer(manager: LspManager, languageId: string): boolean {
  return manager.getRunningClient(languageId) !== null;
}
