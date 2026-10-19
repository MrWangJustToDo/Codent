import { toPosixPath } from "@codent/core";

import { namesAFile } from "./workspace-git-paths.js";
import { joinWorkspacePath } from "./workspace-path.js";

import type { CoreEnv } from "@codent/core";

// ============================================================================
// Diff-only tree preprocessing
//
// In diff mode the sidebar shows only files that actually changed (git status),
// and the tree is preprocessed the way GitHub PR pages do it: directory chains
// that contain exactly one subdirectory are merged into a single row, e.g.
// "app/" + "src/" + "utils/" render as "app/src/utils/". Mirrors the `compress`
// logic of the reference generateDir.ts — only non-leaf single-child chains
// merge, and the first tree level is left untouched to avoid view ambiguity.
// ============================================================================

export interface FlatTreeItem {
  path: string;
  name: string;
  indent: number;
  type: "file" | "directory";
  expanded: boolean;
  /**
   * The chain of directory keys above this row — every one of which can hide it
   * by being collapsed. Set by the diff tree; `undefined` for full-tree rows,
   * which carry their own `expanded` state instead.
   *
   * Needed because the chain is not derivable from the row's path: a merged
   * directory node's `key` is the deepest real dir of the merged chain, so
   * `app/src/utils` is one key and `app/src` is not a row at all.
   */
  ancestorKeys?: string[];
}

interface DiffTreeNode {
  /** Relative path — unique node id (for merged dirs: the deepest real dir). */
  key: string;
  /** Display name — a single segment, or merged segments for compressed dirs. */
  name: string;
  /** Absolute path of the underlying file/dir. */
  path: string;
  type: "file" | "directory";
  children: DiffTreeNode[];
}

/** Build the tree skeleton from changed relative paths only (no fs reads). */
function buildDiffTree(env: CoreEnv, gitStatus: Map<string, string>, rootPath: string): DiffTreeNode[] {
  const roots: DiffTreeNode[] = [];
  const index = new Map<string, DiffTreeNode>();

  const relPaths = new Set<string>();
  for (const rel of gitStatus.keys()) {
    // Last line of defence. The status parse already rejects directory-shaped paths, but this
    // is the only place a nameless `file` row can be created: a trailing `/` splits into an
    // empty last segment, which `isLast` then classifies as a file. Guarded here too so a
    // future caller cannot reintroduce the defect by handing over a raw git path.
    if (!namesAFile(rel)) continue;
    relPaths.add(toPosixPath(rel));
  }

  for (const relPath of relPaths) {
    const segments = relPath.split("/");
    let key = "";
    let siblings = roots;
    for (let i = 0; i < segments.length; i++) {
      const isLast = i === segments.length - 1;
      key = key ? `${key}/${segments[i]}` : segments[i];
      let node = index.get(key);
      if (!node) {
        node = {
          key,
          name: segments[i],
          path: joinWorkspacePath(env, rootPath, key),
          type: isLast ? "file" : "directory",
          children: [],
        };
        index.set(key, node);
        siblings.push(node);
      }
      if (!isLast) siblings = node.children;
    }
  }

  return roots;
}

function sortDiffChildren(nodes: DiffTreeNode[]): DiffTreeNode[] {
  return [...nodes].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

/**
 * Merge single-subdirectory chains into one node (generateDir.ts `compress`):
 * a directory whose only child is another directory collapses into
 * `parentName/childName` with the grandchild children. Files are never merged.
 */
function compressDiffTree(nodes: DiffTreeNode[]): DiffTreeNode[] {
  const result: DiffTreeNode[] = [];
  for (const node of sortDiffChildren(nodes)) {
    if (node.type !== "directory") {
      result.push(node);
      continue;
    }
    const children = compressDiffTree(node.children);
    if (children.length === 1 && children[0].type === "directory") {
      const child = children[0];
      result.push({
        key: child.key,
        name: `${node.name}/${child.name}`,
        path: child.path,
        type: "directory",
        children: child.children,
      });
    } else {
      result.push({ ...node, children });
    }
  }
  return result;
}

function flattenDiffTree(
  nodes: DiffTreeNode[],
  indent: number,
  collapsed: Set<string>,
  out: FlatTreeItem[],
  ancestorKeys: string[]
): void {
  for (const node of nodes) {
    const isDir = node.type === "directory";
    const isExpanded = !collapsed.has(node.key);
    out.push({
      path: node.path,
      name: node.name,
      indent,
      type: isDir ? "directory" : "file",
      expanded: isDir && isExpanded,
      // The chain of directory keys above this row (see `FlatTreeItem.ancestorKeys`
      // for why it cannot be re-derived from the path).
      ancestorKeys,
    });
    if (isDir && isExpanded) {
      flattenDiffTree(node.children, indent + 1, collapsed, out, [...ancestorKeys, node.key]);
    }
  }
}

/**
 * Build the flattened diff-only tree from the git status map.
 *
 * - Only changed paths become rows (untracked, modified, added, deleted,
 *   renamed — whatever `git status --porcelain` reported).
 * - The first tree level is kept unmerged; deeper single-subdirectory chains
 *   are compressed (GitHub PR style).
 * - Directories default to expanded; pass their relative paths in `collapsed`
 *   to hide them.
 *
 * @param gitStatus relative path → status code map (see `parseGitStatusZ`)
 * @param rootPath workspace root
 * @param collapsed relative paths of directories the user collapsed
 */
export function buildDiffTreeItems(
  env: CoreEnv,
  gitStatus: Map<string, string>,
  rootPath: string,
  collapsed: Set<string>
): FlatTreeItem[] {
  if (!rootPath || gitStatus.size === 0) return [];
  const roots = sortDiffChildren(buildDiffTree(env, gitStatus, rootPath)).map((root) =>
    root.type === "directory" ? { ...root, children: compressDiffTree(root.children) } : root
  );
  const out: FlatTreeItem[] = [];
  flattenDiffTree(roots, 0, collapsed, out, []);
  return out;
}

/**
 * Changed file paths in **tree display order** (directories first, then
 * case-insensitive locale order) — the same order the sidebar renders, so `[` /
 * `]` navigation actually moves top-to-bottom through the visible tree. A plain
 * lexicographic sort of the paths (case-sensitive, no directories-first) does
 * not match the rendered order and made jumps look unsorted.
 *
 * Collapse state is NOT taken into account (the tree is built with nothing
 * collapsed), so this walk covers every changed file — including ones hidden
 * inside a collapsed directory, which must stay reachable. The companions below
 * give the caller what it needs to reveal such a target.
 */
export function orderedChangedFiles(env: CoreEnv, gitStatus: Map<string, string>, rootPath: string): string[] {
  return buildDiffTreeItems(env, gitStatus, rootPath, new Set())
    .filter((item) => item.type === "file")
    .map((item) => item.path);
}

/**
 * Where `[` / `]` should jump next, and what must be expanded for it to be
 * visible.
 *
 * Kept here as a pure function (rather than inline in the component) because the
 * wrap-around and the reveal chain are the parts worth pinning, and both are
 * pure decisions over the git status map.
 *
 * The walk covers every changed file, **including** ones hidden inside a
 * collapsed directory — a collapsed dir must not make its files unreachable.
 * `revealKeys` is what makes such a target visible; it comes from an
 * uncollapsed build, since the target's own row is exactly the row the collapse
 * removed.
 *
 * @returns the next target plus the directory keys to expand, or `null` when
 *   there is nothing to do (no changed files, or the walk stays put because
 *   only one file is changed).
 */
export function changedFileJumpTarget(
  env: CoreEnv,
  gitStatus: Map<string, string>,
  rootPath: string,
  selectedPath: string | null,
  direction: 1 | -1
): { target: string; revealKeys: string[] } | null {
  const changed = orderedChangedFiles(env, gitStatus, rootPath);
  if (changed.length === 0) return null;
  const cur = selectedPath ? changed.indexOf(selectedPath) : -1;
  let next: number;
  if (direction > 0) next = cur < 0 ? 0 : cur + 1 >= changed.length ? 0 : cur + 1;
  else next = cur < 0 ? changed.length - 1 : cur - 1 < 0 ? changed.length - 1 : cur - 1;
  const target = changed[next]!;
  if (target === selectedPath) return null;
  // Built with NOTHING collapsed on purpose: a collapsed ancestor removes the
  // target's own row, so the row could not report its own ancestors. Reading the
  // chain off the rendered rows is the trap a first fix fell into (dead code for
  // exactly this case, while every pure formatter test still passed).
  const row = buildDiffTreeItems(env, gitStatus, rootPath, new Set()).find(
    (item) => item.type === "file" && item.path === target
  );
  return { target, revealKeys: row?.ancestorKeys ?? [] };
}
