/**
 * Shared helpers for position-based LSP tools.
 */

import { truncateToUtf8Bytes, utf8ByteLength } from "../../../utils/bytes.js";
import { splitDisplayLines } from "../../../utils/display-lines.js";
import { resolveSymbolPosition, getSymbolNames } from "../shared/resolve-position.js";

import type { LspRequestOptions } from "../../../env/lsp.js";
import type { LspManager } from "../lsp-manager.js";

/**
 * The `{ path, line, character, query }` input contract shared by every position-based LSP tool.
 *
 * The four descriptions were copy-pasted into six tool files; a wording change (or a new field)
 * had to be made six times, and one tool silently kept the old contract when it was not. `path` is
 * the only required field — `line`/`character` may be replaced by `query`.
 */
export const POSITION_PROPERTIES = {
  path: { type: "string", description: "File path" },
  line: { type: "number", description: "Line number (1-indexed). Required unless query is provided." },
  character: { type: "number", description: "Column number (1-indexed). Required unless query is provided." },
  query: { type: "string", description: "Symbol name to find in the file (alternative to line/character)." },
} as const;

export interface PositionInput {
  path?: string;
  line?: number;
  character?: number;
  query?: string;
}

/** Read a position tool's input, with each tool's own extra fields inferred at the call site. */
export function positionParams<T extends PositionInput = PositionInput>(input: unknown): T {
  return (input ?? {}) as T;
}

/**
 * Normalize the `@`-prefixed path form the model sometimes emits.
 *
 * Every LSP tool did `(params.path ?? "").replace(/^@/, "")` itself (eight copies, and `symbols`
 * used optional chaining with different "missing path" semantics). Undefined stays `undefined`
 * here so the caller can tell "no path" from an empty one.
 */
export function normalizeLspPath(path: string | undefined): string | undefined {
  return path?.replace(/^@/, "");
}

export interface TruncatedLines {
  content: string;
  truncated: boolean;
  totalLines: number;
  outputLines: number;
}

/**
 * Keep the first `maxLines` lines, optionally capped by an approximate byte
 * budget, reporting what was dropped. Shares one implementation across the LSP
 * tools that previously copy-pasted it (`code_overview`, `ast_search`,
 * `code_rewrite`, `lsp_diagnostics`, `lsp_references`, `lsp_rename`,
 * `lsp_symbols`).
 */
export function truncateHead(text: string, maxLines = 200, maxBytes?: number): TruncatedLines {
  // Raw line count: CRLF is not folded and a final newline keeps its trailing empty segment.
  const lines = splitDisplayLines(text, { normalizeCrlf: false, dropTrailingEmpty: false });
  const totalLines = lines.length;
  let out = lines.slice(0, maxLines).join("\n");
  if (maxBytes !== undefined && utf8ByteLength(out) > maxBytes) {
    // True UTF-8 accounting (not `length * 2`) and a character-boundary cut, so a multi-byte
    // character is never split.
    out = truncateToUtf8Bytes(out, maxBytes).text;
  }
  const truncated = totalLines > maxLines || out !== lines.join("\n");
  return { content: out, truncated, totalLines, outputLines: Math.min(totalLines, maxLines) };
}

export interface ResolvedPositionResult {
  line: number;
  character: number;
  resolvedFrom?: string;
  error?: string;
}

/**
 * Resolve a (line, character) pair, allowing a `query` symbol name instead.
 * Returns either a valid position or an error message.
 */
export async function resolvePosition(
  manager: LspManager,
  filePath: string,
  params: { line?: number; character?: number; query?: string },
  requestOptions?: LspRequestOptions
): Promise<ResolvedPositionResult> {
  let { line, character } = params;

  if ((line === undefined || character === undefined) && params.query) {
    const resolved = await resolveSymbolPosition(filePath, params.query, manager, requestOptions);
    if (resolved) {
      line = resolved.line;
      character = resolved.character;
      return {
        line,
        character,
        resolvedFrom: `Resolved "${params.query}" → ${resolved.symbolName} at ${line}:${character} [${resolved.source}]`,
      };
    }
    const names = await getSymbolNames(filePath, manager, requestOptions);
    const hint = names.length > 0 ? `\nAvailable symbols: ${names.slice(0, 20).join(", ")}` : "";
    return { line: 0, character: 0, error: `Could not find symbol "${params.query}" in ${filePath}${hint}` };
  }

  if (line === undefined || character === undefined) {
    return { line: 0, character: 0, error: "Either line/character or query is required." };
  }

  return { line, character };
}

/** Join an optional resolved-from prefix onto a message. */
export function withResolved(resolvedFrom: string | undefined, text: string): string {
  return resolvedFrom ? `${resolvedFrom}\n\n${text}` : text;
}
