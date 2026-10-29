import type { Node } from "web-tree-sitter";

/**
 * Named child elements of a tree-sitter node, without the nullable entries its array type allows.
 *
 * One definition: the pattern compiler, the search engine and the symbol extractor all walk the
 * same tree, and three copies is how one of them starts skipping different children.
 */
export function childrenOf(node: Node): Node[] {
  return node.namedChildren.filter((c): c is Node => c != null);
}
