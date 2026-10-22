/**
 * Pattern Compiler — parse metavariable patterns into matchable pattern trees.
 *
 * User-facing patterns use `$NAME` for single-node wildcards and `$$$NAME` for
 * variadic (zero-or-more) wildcards. The pattern string is parsed as code using
 * tree-sitter, then the AST is walked to build a PatternNode tree where
 * metavariable identifiers are replaced with wildcard matchers.
 */

import type { TreeSitterManager } from "./parser-manager.js";
import type { Node as SyntaxNode } from "web-tree-sitter";

/** web-tree-sitter types children as nullable; runtime never returns null. */
function childrenOf(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((c): c is SyntaxNode => c != null);
}

/** First named child (runtime never null when namedChildCount > 0). */
function firstNamed(node: SyntaxNode): SyntaxNode {
  return node.namedChildren[0] as SyntaxNode;
}

// ── Pattern node types ──────────────────────────────────────────────────────

export type PatternNode = LiteralPatternNode | MetavarPatternNode | VariadicPatternNode;

/** Matches a concrete AST node — type must match, and either text (leaf) or children (branch) */
export interface LiteralPatternNode {
  kind: "literal";
  /** tree-sitter node type to match (e.g., "identifier", "call_expression") */
  nodeType: string;
  /** For leaf nodes: exact text that must match */
  text?: string;
  /** For branch nodes: child patterns to match (named children only) */
  children: PatternNode[];
  /** Field name this node occupies in its parent (e.g., "function", "arguments") */
  fieldName?: string;
}

/** Matches any single AST node and captures its text */
export interface MetavarPatternNode {
  kind: "metavar";
  /** Capture name (e.g., "ARG" from "$ARG") */
  name: string;
  /** Field name this node occupies in its parent */
  fieldName?: string;
}

/** Matches zero or more consecutive sibling nodes */
export interface VariadicPatternNode {
  kind: "variadic";
  /** Capture name (e.g., "PARAMS" from "$$$PARAMS", or "" for anonymous "$$$") */
  name: string;
  /** Field name context */
  fieldName?: string;
}

export interface CompiledPattern {
  /** The root pattern node (unwrapped from program/expression_statement wrappers) */
  root: PatternNode;
  /** All metavariable names found in the pattern */
  metavars: string[];
  /** The language this pattern was compiled for */
  languageId: string;
}

// ── Metavariable detection ──────────────────────────────────────────────────

const VARIADIC_RE = /^\$\$\$([A-Z_][A-Z0-9_]*)?$/;
const METAVAR_RE = /^\$([A-Z_][A-Z0-9_]*)$/;

function isVariadic(text: string): string | null {
  const m = VARIADIC_RE.exec(text);
  return m ? (m[1] ?? "") : null;
}

function isMetavar(text: string): string | null {
  const m = METAVAR_RE.exec(text);
  return m ? m[1] : null;
}

// ── Metavar placeholder encoding ────────────────────────────────────────────

const META_PREFIX = "__META_";
const VMETA_PREFIX = "__VMETA_";
const META_SUFFIX = "__";

/**
 * Replace `$$$NAME` and `$NAME` with placeholder identifiers valid in any language.
 * Returns the preprocessed source and a map from placeholder to {kind, name}.
 */
function preprocessMetavars(source: string): {
  preprocessed: string;
  placeholders: Map<string, { kind: "metavar" | "variadic"; name: string }>;
} {
  const placeholders = new Map<string, { kind: "metavar" | "variadic"; name: string }>();

  let preprocessed = source.replace(/\$\$\$([A-Z_][A-Z0-9_]*)?/g, (_match, name) => {
    const n = name ?? "";
    const placeholder = `${VMETA_PREFIX}${n || "ANON"}${META_SUFFIX}`;
    placeholders.set(placeholder, { kind: "variadic", name: n });
    return placeholder;
  });

  preprocessed = preprocessed.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_match, name) => {
    const placeholder = `${META_PREFIX}${name}${META_SUFFIX}`;
    placeholders.set(placeholder, { kind: "metavar", name });
    return placeholder;
  });

  return { preprocessed, placeholders };
}

/** Check if a text is a metavar placeholder */
function decodePlaceholder(
  text: string,
  placeholders: Map<string, { kind: "metavar" | "variadic"; name: string }>
): { kind: "metavar" | "variadic"; name: string } | null {
  return placeholders.get(text) ?? null;
}

// ── Compile ─────────────────────────────────────────────────────────────────

/**
 * Compile a user-facing pattern string into a matchable PatternNode tree.
 *
 * Metavariables ($NAME, $$$NAME) are replaced with placeholder identifiers
 * before parsing, so patterns work in any language regardless of whether `$`
 * is a valid identifier character.
 *
 * Tries parsing the pattern as-is first, then with wrapper contexts if it
 * contains syntax errors (e.g., an expression fragment that isn't a valid program).
 */
export async function compilePattern(
  source: string,
  languageId: string,
  treeSitter: TreeSitterManager
): Promise<CompiledPattern> {
  await treeSitter.init();

  const { preprocessed, placeholders } = preprocessMetavars(source);

  const wrappers = getWrappersForLanguage(languageId);

  for (const { wrap, unwrap } of wrappers) {
    const wrapped = wrap(preprocessed);
    const tree = await treeSitter.parseWithLanguage(`__pattern__${Date.now()}`, wrapped, languageId);
    if (!tree) continue;

    const root = tree.rootNode;
    if (hasErrors(root)) continue;

    const unwrapped = unwrap(root);
    if (!unwrapped) continue;

    const metavars: string[] = [];
    const patternNode = buildPatternNode(unwrapped, metavars, undefined, placeholders);
    return { root: patternNode, metavars: [...new Set(metavars)], languageId };
  }

  throw new Error(
    `Failed to parse pattern as ${languageId}. The pattern may have syntax errors ` +
      `or may not be a valid code fragment in this language.`
  );
}

/** Get wrapper strategies appropriate for a language */
function getWrappersForLanguage(languageId: string): Array<{
  wrap: (s: string) => string;
  unwrap: (root: SyntaxNode) => SyntaxNode | null;
}> {
  const common = [
    { wrap: (s: string) => s, unwrap: unwrapProgram },
    { wrap: (s: string) => `${s};`, unwrap: unwrapProgram },
    { wrap: (s: string) => `(${s})`, unwrap: unwrapExpression },
  ];

  switch (languageId) {
    case "python":
      return [
        { wrap: (s: string) => s, unwrap: unwrapModule },
        { wrap: (s: string) => `(${s})`, unwrap: unwrapExpression },
        { wrap: (s: string) => `def _():\n  ${s}`, unwrap: unwrapPythonFunctionBody },
      ];
    default:
      return [...common, { wrap: (s: string) => `function _() { ${s} }`, unwrap: unwrapFunctionBody }];
  }
}

// ── AST → PatternNode conversion ────────────────────────────────────────────

function buildPatternNode(
  node: SyntaxNode,
  metavars: string[],
  fieldName: string | undefined,
  placeholders: Map<string, { kind: "metavar" | "variadic"; name: string }>
): PatternNode {
  const text = node.text;

  // Check for placeholder-based metavar/variadic (language-agnostic)
  if (node.namedChildCount === 0) {
    const decoded = decodePlaceholder(text, placeholders);
    if (decoded) {
      if (decoded.name) metavars.push(decoded.name);
      if (decoded.kind === "variadic") {
        return { kind: "variadic", name: decoded.name, fieldName };
      }
      return { kind: "metavar", name: decoded.name, fieldName };
    }
  }

  // Legacy $-prefixed metavars (for languages where $ is valid)
  if (node.namedChildCount === 0) {
    const variadicName = isVariadic(text);
    if (variadicName !== null) {
      if (variadicName) metavars.push(variadicName);
      return { kind: "variadic", name: variadicName, fieldName };
    }
    const metavarName = isMetavar(text);
    if (metavarName !== null) {
      metavars.push(metavarName);
      return { kind: "metavar", name: metavarName, fieldName };
    }
  }

  // Branch node with a single child that is a placeholder → unwrap
  if (node.namedChildCount === 1) {
    const onlyChild = firstNamed(node);
    if (onlyChild.namedChildCount === 0) {
      const decoded = decodePlaceholder(onlyChild.text, placeholders);
      if (decoded) {
        if (decoded.name) metavars.push(decoded.name);
        if (decoded.kind === "variadic") {
          return { kind: "variadic", name: decoded.name, fieldName };
        }
        return { kind: "metavar", name: decoded.name, fieldName };
      }
      const childMeta = isMetavar(onlyChild.text);
      if (childMeta !== null) {
        metavars.push(childMeta);
        return { kind: "metavar", name: childMeta, fieldName };
      }
      const childVariadic = isVariadic(onlyChild.text);
      if (childVariadic !== null) {
        if (childVariadic) metavars.push(childVariadic);
        return { kind: "variadic", name: childVariadic, fieldName };
      }
    }
  }

  // Leaf node — literal match
  if (node.namedChildCount === 0) {
    return { kind: "literal", nodeType: node.type, text, children: [], fieldName };
  }

  // Branch node — recurse into named children
  const children: PatternNode[] = [];
  for (const child of childrenOf(node)) {
    const childFieldName = getFieldName(node, child);
    children.push(buildPatternNode(child, metavars, childFieldName, placeholders));
  }

  return { kind: "literal", nodeType: node.type, children, fieldName };
}

/** Get the field name for a child node relative to its parent */
function getFieldName(parent: SyntaxNode, child: SyntaxNode): string | undefined {
  for (let i = 0; i < parent.childCount; i++) {
    const c = parent.child(i);
    if (c && c.id === child.id) {
      return parent.fieldNameForChild(i) ?? undefined;
    }
  }
  return undefined;
}

// ── Unwrap helpers ──────────────────────────────────────────────────────────

function unwrapProgram(root: SyntaxNode): SyntaxNode | null {
  if (root.type !== "program" || root.namedChildCount === 0) return null;
  const child = firstNamed(root);
  if (child.type === "expression_statement" && child.namedChildCount === 1) {
    return firstNamed(child);
  }
  return child;
}

function unwrapModule(root: SyntaxNode): SyntaxNode | null {
  if (root.type !== "module" || root.namedChildCount === 0) return null;
  const child = firstNamed(root);
  if (child.type === "expression_statement" && child.namedChildCount === 1) {
    return firstNamed(child);
  }
  return child;
}

function unwrapExpression(root: SyntaxNode): SyntaxNode | null {
  if (root.type !== "program" || root.namedChildCount === 0) return null;
  let node = firstNamed(root);
  if (node.type === "expression_statement") node = firstNamed(node);
  if (node.type === "parenthesized_expression" && node.namedChildCount === 1) {
    return firstNamed(node);
  }
  return node;
}

function unwrapFunctionBody(root: SyntaxNode): SyntaxNode | null {
  if (root.type !== "program" || root.namedChildCount === 0) return null;
  const fn = firstNamed(root);
  if (!fn.type.includes("function")) return null;
  const body = fn.childForFieldName("body");
  if (!body || body.namedChildCount === 0) return null;
  const stmt = firstNamed(body);
  if (stmt.type === "expression_statement" && stmt.namedChildCount === 1) {
    return firstNamed(stmt);
  }
  return stmt;
}

function unwrapPythonFunctionBody(root: SyntaxNode): SyntaxNode | null {
  if (root.type !== "module" || root.namedChildCount === 0) return null;
  const fn = firstNamed(root);
  if (fn.type !== "function_definition") return null;
  const body = fn.childForFieldName("body");
  if (!body || body.namedChildCount === 0) return null;
  const stmt = firstNamed(body);
  if (stmt.type === "expression_statement" && stmt.namedChildCount === 1) {
    return firstNamed(stmt);
  }
  return stmt;
}

/** Check if an AST node contains any ERROR nodes */
function hasErrors(node: SyntaxNode): boolean {
  if (node.type === "ERROR" || node.isMissing) return true;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && hasErrors(child)) return true;
  }
  return false;
}
