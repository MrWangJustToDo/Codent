/**
 * Rewrite Engine — apply structural replacements using matched patterns.
 *
 * Takes search matches and a replacement template with metavariable references,
 * substitutes captured values, and applies the text changes.
 *
 * Runtime-agnostic: filesystem access goes through the injected `env`.
 */

import type { TreeSitterEnv } from "./parser-manager.js";
import type { SearchMatch } from "./search-engine.js";

// ── Result types ────────────────────────────────────────────────────────────

export interface RewriteChange {
  file: string;
  line: number;
  column: number;
  before: string;
  after: string;
}

export interface RewriteResult {
  changes: RewriteChange[];
  filesModified: number;
}

// ── Replacement template substitution ───────────────────────────────────────

const METAVAR_REF_RE = /\$\$\$([A-Z_][A-Z0-9_]*)|(?<!\$)\$([A-Z_][A-Z0-9_]*)/g;

/**
 * Substitute metavariable references in a replacement template with captured values.
 */
export function substituteCaptures(template: string, captures: Record<string, string>): string {
  return template.replace(METAVAR_REF_RE, (_match, variadicName, singleName) => {
    const name = variadicName ?? singleName;
    if (name && name in captures) return captures[name];
    return _match;
  });
}

/**
 * If the original matched text ends with a semicolon (possibly preceded by whitespace)
 * and the replacement doesn't, append the semicolon. This preserves statement terminators
 * that are part of the AST node but not part of the pattern/replacement.
 */
function preserveTrailingSemicolon(original: string, replacement: string): string {
  const trailingMatch = original.match(/(\s*;)\s*$/);
  if (trailingMatch && !replacement.trimEnd().endsWith(";")) {
    return replacement + trailingMatch[1];
  }
  return replacement;
}

// ── Rewrite application ─────────────────────────────────────────────────────

/**
 * Compute rewrite changes from matches and a replacement template.
 * Returns the list of changes without applying them.
 */
export function computeRewrites(matches: SearchMatch[], replacementTemplate: string): RewriteChange[] {
  return matches.map((m) => {
    const raw = substituteCaptures(replacementTemplate, m.captures);
    const after = preserveTrailingSemicolon(m.matchedText, raw);
    return {
      file: m.file,
      line: m.line,
      column: m.column,
      before: m.matchedText,
      after,
    };
  });
}

/**
 * Apply rewrite changes to files. Modifies files in-place.
 * Applies changes bottom-up (last offset first) within each file to preserve byte offsets.
 */
export async function applyRewrites(
  matches: SearchMatch[],
  replacementTemplate: string,
  env: TreeSitterEnv
): Promise<RewriteResult> {
  const byFile = new Map<string, SearchMatch[]>();
  for (const m of matches) {
    const existing = byFile.get(m.file);
    if (existing) {
      existing.push(m);
    } else {
      byFile.set(m.file, [m]);
    }
  }

  const changes: RewriteChange[] = [];
  let filesModified = 0;

  for (const [file, fileMatches] of byFile) {
    const sorted = [...fileMatches].sort((a, b) => b.startIndex - a.startIndex);

    let content = await env.readFile(file);
    let modified = false;

    for (const m of sorted) {
      const raw = substituteCaptures(replacementTemplate, m.captures);
      const replacement = preserveTrailingSemicolon(m.matchedText, raw);
      if (replacement !== m.matchedText) {
        content = content.slice(0, m.startIndex) + replacement + content.slice(m.endIndex);
        modified = true;
      }
      changes.push({
        file,
        line: m.line,
        column: m.column,
        before: m.matchedText,
        after: replacement,
      });
    }

    if (modified) {
      await env.writeFile(file, content);
      filesModified++;
    }
  }

  changes.reverse();

  return { changes, filesModified };
}
