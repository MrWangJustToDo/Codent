/**
 * Shared position resolver — resolves a symbol name to a file position.
 *
 * Used by position-based tools (hover, definition, references, rename, completions)
 * to allow the LLM to pass a symbol name instead of exact line/character.
 *
 * LSP-first (documentSymbol request). When no LSP server is running, falls back
 * to a lightweight text-scan for the symbol name (whole-word, first occurrence).
 */

import type { LspRequestOptions } from "../../../env/lsp.js";
import type { LspManager } from "../lsp-manager.js";

export interface ResolvedPosition {
  line: number; // 1-indexed (tool convention)
  character: number; // 1-indexed
  symbolName: string;
  source: "lsp" | "text";
}

type DocumentSymbolResponse = unknown[] | null;

/**
 * Resolve a symbol name to a position in a file.
 *
 * 1. LSP document symbols (most accurate)
 * 2. Text scan fallback (whole-word first occurrence)
 */
export async function resolveSymbolPosition(
  filePath: string,
  query: string,
  manager: LspManager,
  requestOptions?: LspRequestOptions
): Promise<ResolvedPosition | null> {
  // Try LSP document symbols first
  const client = await manager.getClientForFile(filePath).catch(() => null);
  if (client) {
    const uri = manager.getFileUri(filePath);
    try {
      const symbols = await client.connection.sendRequest<DocumentSymbolResponse>(
        "textDocument/documentSymbol",
        { textDocument: { uri } },
        requestOptions
      );
      if (symbols && symbols.length > 0) {
        const match = findInSymbols(symbols, query);
        if (match) return match;
      }
    } catch {
      // fall through to text scan
    }
  }

  // Text-scan fallback: find the first whole-word occurrence of the query.
  const content = await manager.readFileIfPossible(filePath).catch(() => null);
  if (content != null) {
    const found = findInText(content, query);
    if (found) return found;
  }

  return null;
}

/**
 * Get top-level symbol names from a file (for error hints).
 */
export async function getSymbolNames(
  filePath: string,
  manager: LspManager,
  requestOptions?: LspRequestOptions
): Promise<string[]> {
  const client = await manager.getClientForFile(filePath).catch(() => null);
  if (client) {
    const uri = manager.getFileUri(filePath);
    try {
      const symbols = await client.connection.sendRequest<DocumentSymbolResponse>(
        "textDocument/documentSymbol",
        { textDocument: { uri } },
        requestOptions
      );
      if (symbols && symbols.length > 0) {
        return symbols.map((s) => (s as { name?: string }).name ?? "");
      }
    } catch {
      // fall through
    }
  }
  return [];
}

// --- LSP DocumentSymbol matching ---

function findInSymbols(symbols: unknown[], query: string): ResolvedPosition | null {
  for (const sym of symbols) {
    const s = sym as {
      name?: string;
      selectionRange?: { start?: { line?: number; character?: number } };
      range?: { start?: { line?: number; character?: number } };
      children?: unknown[];
    };
    const name = s.name ?? "";
    if (name === query) {
      const sel = s.selectionRange?.start ?? s.range?.start;
      if (sel && sel.line != null && sel.character != null) {
        return {
          line: sel.line + 1,
          character: sel.character + 1,
          symbolName: name,
          source: "lsp",
        };
      }
    }
    if (s.children?.length) {
      const child = findInSymbols(s.children, query);
      if (child) return child;
    }
  }
  return null;
}

// --- Text scan fallback ---

function findInText(content: string, query: string): ResolvedPosition | null {
  const lines = content.split("\n");
  const re = new RegExp(`\\b${escapeRegExp(query)}\\b`);
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(re);
    if (match && match.index != null) {
      return {
        line: i + 1,
        character: match.index + 1,
        symbolName: query,
        source: "text",
      };
    }
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
