/**
 * Search Engine — run compiled patterns against source files and collect matches.
 *
 * Uses a recursive AST matcher: the target file's tree-sitter AST is walked
 * depth-first, and at each node we attempt to match the compiled pattern tree.
 * Metavariable nodes capture any single AST node; variadic nodes capture
 * zero-or-more siblings.
 *
 * Runtime-agnostic: all filesystem access goes through the injected `env`.
 */

import { SKIP_DIRS, MAX_FILE_SIZE, MAX_INDEX_FILES } from "./constants.js";

import type { TreeSitterManager, TreeSitterEnv } from "./parser-manager.js";
import type { CompiledPattern, PatternNode } from "./pattern-compiler.js";
import type { Node as SyntaxNode } from "web-tree-sitter";

/** web-tree-sitter types children as nullable; runtime never returns null. */
function childrenOf(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((c): c is SyntaxNode => c != null);
}

// ── Result types ────────────────────────────────────────────────────────────

export interface SearchMatch {
  /** Absolute file path */
  file: string;
  /** 1-indexed line number */
  line: number;
  /** 1-indexed column */
  column: number;
  /** The matched source text */
  matchedText: string;
  /** Byte offset of match start */
  startIndex: number;
  /** Byte offset of match end */
  endIndex: number;
  /** Metavariable bindings: name → captured text */
  captures: Record<string, string>;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Search files for matches against a compiled pattern.
 */
export async function searchFiles(
  pattern: CompiledPattern,
  rootDir: string,
  treeSitter: TreeSitterManager,
  env: TreeSitterEnv,
  options: {
    path?: string;
    maxResults?: number;
  } = {}
): Promise<SearchMatch[]> {
  const searchRoot = options.path ? env.resolve(rootDir, options.path) : rootDir;
  const maxResults = options.maxResults ?? 50;

  let files: string[];
  // Try to treat searchRoot as a directory; if readdir fails, treat it as a file.
  try {
    await env.readdir(searchRoot);
    files = await collectFilesByLanguage(searchRoot, pattern.languageId, treeSitter, env);
  } catch {
    files = [searchRoot];
  }

  const matches: SearchMatch[] = [];

  for (const file of files) {
    if (matches.length >= maxResults) break;

    try {
      const content = await env.readFile(file);
      const tree = await treeSitter.parseWithLanguage(file, content, pattern.languageId);
      if (!tree) continue;

      const fileMatches = findMatches(tree.rootNode, pattern.root);
      for (const m of fileMatches) {
        if (matches.length >= maxResults) break;
        matches.push({
          file,
          line: m.node.startPosition.row + 1,
          column: m.node.startPosition.column + 1,
          matchedText: m.node.text,
          startIndex: m.node.startIndex,
          endIndex: m.node.endIndex,
          captures: m.captures,
        });
      }
    } catch {
      // Skip unreadable files
    }
  }

  return matches;
}

/**
 * Collect all files matching a given language under a directory.
 */
export async function collectFilesByLanguage(
  dir: string,
  languageId: string,
  treeSitter: TreeSitterManager,
  env: TreeSitterEnv,
  collected: string[] = [],
  maxFiles: number = MAX_INDEX_FILES
): Promise<string[]> {
  if (collected.length >= maxFiles) return collected;

  try {
    const entries = await env.readdir(dir);
    for (const entry of entries) {
      if (collected.length >= maxFiles) break;

      if (entry.isDirectory) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        await collectFilesByLanguage(env.resolve(dir, entry.name), languageId, treeSitter, env, collected, maxFiles);
      } else if (entry.isFile) {
        const fileLang = treeSitter.getLanguageId(entry.name);
        if (fileLang === languageId) {
          const filePath = env.resolve(dir, entry.name);
          try {
            const s = await env.stat(filePath);
            if (s.size <= MAX_FILE_SIZE) {
              collected.push(filePath);
            }
          } catch {
            // ignore unstatable files
          }
        }
      }
    }
  } catch {
    // Permission denied or other IO error — skip
  }

  return collected;
}

// ── Matching engine ─────────────────────────────────────────────────────────

interface RawMatch {
  node: SyntaxNode;
  captures: Record<string, string>;
}

/**
 * Find all non-overlapping matches of the pattern in the target AST.
 * Walks the tree depth-first, attempting to match at each node.
 */
function findMatches(root: SyntaxNode, pattern: PatternNode): RawMatch[] {
  const matches: RawMatch[] = [];
  const visited = new Set<number>();

  function walk(node: SyntaxNode): void {
    if (visited.has(node.id)) return;

    const captures: Record<string, string> = {};
    if (matchNode(node, pattern, captures)) {
      matches.push({ node, captures });
      markDescendants(node, visited);
      return;
    }

    for (const child of childrenOf(node)) {
      walk(child);
    }
  }

  walk(root);
  return matches;
}

function markDescendants(node: SyntaxNode, visited: Set<number>): void {
  visited.add(node.id);
  for (const child of childrenOf(node)) {
    markDescendants(child, visited);
  }
}

/**
 * Try to match a target AST node against a pattern node.
 * Returns true if matched, populating `captures` with metavariable bindings.
 */
function matchNode(target: SyntaxNode, pattern: PatternNode, captures: Record<string, string>): boolean {
  switch (pattern.kind) {
    case "metavar": {
      const name = pattern.name;
      if (name in captures) {
        return captures[name] === target.text;
      }
      captures[name] = target.text;
      return true;
    }

    case "variadic": {
      const name = pattern.name;
      if (name && name in captures) {
        return captures[name] === target.text;
      }
      if (name) captures[name] = target.text;
      return true;
    }

    case "literal": {
      if (target.type !== pattern.nodeType) return false;

      if (pattern.text !== undefined) {
        return target.text === pattern.text;
      }

      return matchChildrenFieldAware(target, pattern.children, captures);
    }
  }
}

/**
 * Match pattern children against target node's children using field-name-aware matching.
 *
 * Strategy:
 * 1. Pattern children WITH field names: find the target child with the same field name and match
 * 2. Pattern children WITHOUT field names: match positionally against unmatched target children
 * 3. Extra target children not mentioned in the pattern are allowed (implicit wildcards)
 */
function matchChildrenFieldAware(
  targetNode: SyntaxNode,
  patternChildren: PatternNode[],
  captures: Record<string, string>
): boolean {
  const fieldPatterns: PatternNode[] = [];
  const positionalPatterns: PatternNode[] = [];

  for (const pc of patternChildren) {
    if (pc.fieldName) {
      fieldPatterns.push(pc);
    } else {
      positionalPatterns.push(pc);
    }
  }

  for (const fp of fieldPatterns) {
    const targetChild = targetNode.childForFieldName(fp.fieldName!);
    if (!targetChild) return false;
    if (!matchNode(targetChild, fp, captures)) return false;
  }

  if (positionalPatterns.length > 0) {
    const matchedFieldNames = new Set(fieldPatterns.map((fp) => fp.fieldName));
    const remainingTargets: SyntaxNode[] = [];
    for (const child of childrenOf(targetNode)) {
      const childField = getChildFieldName(targetNode, child);
      if (!childField || !matchedFieldNames.has(childField)) {
        remainingTargets.push(child);
      }
    }

    return matchChildrenPositional(remainingTargets, 0, positionalPatterns, 0, captures);
  }

  return true;
}

/** Get the field name of a child node within its parent */
function getChildFieldName(parent: SyntaxNode, child: SyntaxNode): string | null {
  for (let i = 0; i < parent.childCount; i++) {
    const c = parent.child(i);
    if (c && c.id === child.id) {
      return parent.fieldNameForChild(i);
    }
  }
  return null;
}

/**
 * Match pattern children positionally against target children.
 * Handles variadic patterns that can match zero or more consecutive children.
 * Extra target children at the end are allowed (pattern doesn't need to cover all children).
 */
function matchChildrenPositional(
  targets: SyntaxNode[],
  ti: number,
  patterns: PatternNode[],
  pi: number,
  captures: Record<string, string>
): boolean {
  if (pi >= patterns.length) return true;

  const pat = patterns[pi];

  if (pat.kind === "variadic") {
    const isLast = pi === patterns.length - 1;

    if (isLast) {
      const remainingText = targets
        .slice(ti)
        .map((t) => t.text)
        .join(", ");
      if (pat.name) {
        if (pat.name in captures && captures[pat.name] !== remainingText) return false;
        captures[pat.name] = remainingText;
      }
      return true;
    }

    for (let take = 0; take <= targets.length - ti; take++) {
      const captureSnapshot = { ...captures };
      const consumedText = targets
        .slice(ti, ti + take)
        .map((t) => t.text)
        .join(", ");

      if (pat.name) {
        if (pat.name in captureSnapshot && captureSnapshot[pat.name] !== consumedText) continue;
        captureSnapshot[pat.name] = consumedText;
      }

      if (matchChildrenPositional(targets, ti + take, patterns, pi + 1, captureSnapshot)) {
        Object.assign(captures, captureSnapshot);
        return true;
      }
    }
    return false;
  }

  if (ti >= targets.length) return false;

  const captureSnapshot = { ...captures };
  if (matchNode(targets[ti], pat, captureSnapshot)) {
    if (matchChildrenPositional(targets, ti + 1, patterns, pi + 1, captureSnapshot)) {
      Object.assign(captures, captureSnapshot);
      return true;
    }
  }

  return false;
}
