import { toPosixPath } from "@codent/core";
import { Box, Text } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useCoreEnv } from "../context/core-env-context.js";
import { BG, COLORS } from "../theme/colors.js";
import { formatFolderGlyph, formatIconGlyph, getFileIconStyle, getFolderIconStyle } from "../utils/file-icons.js";
import { buildDiffTreeItems, type FlatTreeItem } from "../utils/workspace-diff-tree.js";
import { type DirStatusSummary } from "../utils/workspace-dir-status.js";
import { classifyGitStatus } from "../utils/workspace-git-status.js";
import { joinWorkspacePath, workspaceRelativePath } from "../utils/workspace-path.js";
import { visibleWindow } from "../utils/workspace-scroll.js";

import type { WorkspaceFileDiffStat } from "../utils/workspace-diff-stats.js";
import type { CoreEnv, FileEntry } from "@codent/core";

// ============================================================================
// Dir Cache
// ============================================================================

const dirCache = new Map<string, FileEntry[]>();

export function clearDirCache(): void {
  dirCache.clear();
}

function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "directory" ? -1 : 1;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

// ============================================================================
// Git Status
// ============================================================================

export function lookupGitStatus(
  gitStatus: Map<string, string>,
  rootPath: string,
  fullPath: string
): string | undefined {
  const relative = workspaceRelativePath(rootPath, fullPath);
  return gitStatus.get(relative) ?? gitStatus.get(toPosixPath(relative));
}

// ============================================================================
// Status Style
// ============================================================================

interface StatusStyle {
  label: string;
  color: string;
}

function getStatusStyle(status: string): StatusStyle | null {
  // Delegated to `classifyGitStatus` so the badge cannot disagree with the directory counts.
  // The badge LETTER comes from the kind, not from re-reading the raw status here — that would
  // be re-deciding what `classifyGitStatus` already decided (see its doc).
  switch (classifyGitStatus(status)) {
    case "renamed":
      return { label: "R", color: COLORS.primary };
    case "copied":
      return { label: "C", color: COLORS.primary };
    case "modified":
      return { label: "M", color: COLORS.warning };
    case "untracked":
      return { label: "?", color: COLORS.success };
    case "added":
      return { label: "A", color: COLORS.success };
    case "deleted":
      return { label: "D", color: COLORS.danger };
    default:
      return null;
  }
}

// ============================================================================
// Directory Status Aggregation
// ============================================================================

function formatDirStatus(summary: DirStatusSummary | undefined): string | null {
  if (!summary || summary.total === 0) return null;
  const parts: string[] = [];
  if (summary.modified > 0) parts.push(`${summary.modified}M`);
  if (summary.added > 0) parts.push(`${summary.added}A`);
  if (summary.deleted > 0) parts.push(`${summary.deleted}D`);
  if (summary.untracked > 0) parts.push(`${summary.untracked}?`);
  if (summary.renamed > 0) parts.push(`${summary.renamed}R`);
  return parts.length > 0 ? parts.join(" ") : null;
}

// ============================================================================
// useFileTree
// ============================================================================

/**
 * Ancestor directories of `path` within the workspace, root first.
 *
 * Excludes the file itself: expanding a tree means expanding its directories.
 * Returns `[]` for the root or a path outside the workspace.
 */
function ancestorDirs(env: CoreEnv, rootPath: string, path: string): string[] {
  if (!rootPath) return [];
  const rel = workspaceRelativePath(rootPath, path);
  if (!rel || rel === ".") return [];
  const parts = rel.split("/");
  const dirs: string[] = [rootPath];
  let cur = rootPath;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = joinWorkspacePath(env, cur, parts[i]!);
    dirs.push(cur);
  }
  return dirs;
}

export function useFileTree(
  rootPath: string,
  /** Bumped by the git refresh on every read attempt, changed or not. See the effect below. */
  statusVersion = 0
): {
  items: FlatTreeItem[];
  loading: boolean;
  toggleDir: (path: string) => Promise<void>;
  reload: () => void;
  revealPath: (path: string) => Promise<void>;
  /** Path with an outstanding reveal request, or null. See `consumePendingReveal`. */
  pendingReveal: string | null;
  consumePendingReveal: (path: string) => void;
} {
  const env = useCoreEnv();
  const [dirData, setDirData] = useState<Map<string, FileEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);
  const [pendingReveal, setPendingReveal] = useState<string | null>(null);
  /** Last `statusVersion` this hook has already reconciled `dirData` against. */
  const reconciledVersionRef = useRef(statusVersion);

  const loadDir = useCallback(
    async (path: string, options?: { force?: boolean }): Promise<void> => {
      if (!options?.force && dirCache.has(path)) {
        setDirData((prev) => new Map(prev).set(path, dirCache.get(path)!));
        return;
      }
      try {
        const entries = sortEntries(await env.fs.readdir(path));
        dirCache.set(path, entries);
        setDirData((prev) => new Map(prev).set(path, entries));
      } catch {
        dirCache.set(path, []);
        setDirData((prev) => new Map(prev).set(path, []));
      }
    },
    [env]
  );

  /**
   * Re-list every directory whose entries are already in hand (`dirCache`), keeping `expanded`.
   *
   * This is what makes a file the agent just created inside an already-listed directory a ROW.
   * The tree's rows are not derived from git status: the status only decorates rows that exist, so
   * `src/ [3M]` could raise its count while the new file had no row at all — and `[` / `]` would
   * still *select* it, so the jump changed the preview while the cursor had nowhere to land and the
   * scroll did not move. That read as the key being broken until `r`, which clears the whole cache.
   *
   * Driven by the git refresh's version rather than by a change in the status, deliberately: a new
   * file in an ignored directory leaves the status untouched, and it should still appear.
   */
  const refreshLoadedDirs = useCallback(async (): Promise<void> => {
    const loaded = [...dirCache.keys()];
    await Promise.all(loaded.map((dir) => loadDir(dir, { force: true })));
  }, [loadDir]);

  const toggleDir = useCallback(
    async (path: string): Promise<void> => {
      if (expanded.has(path)) {
        setExpanded((prev) => {
          const next = new Set(prev);
          next.delete(path);
          return next;
        });
        return;
      }
      await loadDir(path);
      setExpanded((prev) => new Set(prev).add(path));
    },
    [expanded, loadDir]
  );

  const reload = useCallback(() => {
    clearDirCache();
    setDirData(new Map());
    setExpanded(new Set());
    setPendingReveal(null);
    setReloadToken((token) => token + 1);
  }, []);

  /**
   * Load a path's ancestor directories and request that its chain be expanded.
   *
   * The expansion itself is deliberately NOT done here — it happens in
   * {@link consumePendingReveal}, applied by whichever view owns the expand
   * policy. That split exists because "this file was just selected, show it" and
   * "this file's row is absent" are not the same condition: only the caller can
   * tell a selection from a directory the user collapsed themselves, and doing it
   * here made a collapse impossible to keep (see `WorkspaceFileMode`).
   */
  const revealPath = useCallback(
    async (path: string): Promise<void> => {
      const dirs = ancestorDirs(env, rootPath, path);
      if (dirs.length === 0) return;
      await Promise.all(dirs.map((dir) => loadDir(dir)));
      setPendingReveal(path);
    },
    [env, rootPath, loadDir]
  );

  /**
   * Apply the outstanding reveal request for `path`: expand its ancestor chain
   * and clear the request.
   *
   * Idempotent — a chain that is already expanded leaves `expanded` untouched (the
   * same Set reference is returned), so calling it for a row that turned out to be
   * already visible costs nothing.
   */
  const consumePendingReveal = useCallback(
    (path: string): void => {
      const dirs = ancestorDirs(env, rootPath, path);
      setExpanded((prev) => {
        if (dirs.length === 0 || dirs.every((dir) => prev.has(dir))) return prev;
        const next = new Set(prev);
        for (const dir of dirs) next.add(dir);
        return next;
      });
      setPendingReveal(null);
    },
    [env, rootPath]
  );

  useEffect(() => {
    if (!rootPath) return;
    let cancelled = false;
    setLoading(true);
    setPendingReveal(null);
    loadDir(rootPath).then(() => {
      if (cancelled) return;
      setExpanded(new Set([rootPath]));
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [rootPath, reloadToken, loadDir]);

  // Reconcile the listed rows with the worktree on each git refresh. `reconciledVersionRef` starts
  // at the version the hook mounted with, so the mount itself is not double-read (the effect above
  // loads the root) and only LATER refreshes trigger the re-list.
  useEffect(() => {
    if (!rootPath) return;
    if (reconciledVersionRef.current === statusVersion) return;
    reconciledVersionRef.current = statusVersion;
    void refreshLoadedDirs();
  }, [rootPath, statusVersion, refreshLoadedDirs]);

  const items = useMemo(() => {
    const result: FlatTreeItem[] = [];

    function buildFlat(dirPath: string, indent: number): void {
      const entries = dirData.get(dirPath);
      if (!entries) return;
      for (const entry of entries) {
        const fullPath = joinWorkspacePath(env, dirPath, entry.name);
        if (entry.type === "directory") {
          const isExpanded = expanded.has(fullPath);
          result.push({ path: fullPath, name: entry.name, indent, type: "directory", expanded: isExpanded });
          if (isExpanded) buildFlat(fullPath, indent + 1);
        } else {
          result.push({ path: fullPath, name: entry.name, indent, type: "file", expanded: false });
        }
      }
    }

    if (rootPath && dirData.has(rootPath)) {
      buildFlat(rootPath, 0);
    }

    return result;
  }, [env, dirData, expanded, rootPath]);

  return { items, loading, toggleDir, reload, revealPath, pendingReveal, consumePendingReveal };
}

// ============================================================================
// useDiffFileTree (diff mode: only changed files, merged prefixes)
// ============================================================================

/**
 * Diff-mode tree: rows are built purely from the git status map (no fs reads),
 * so the sidebar lists only changed files. Directory chains with a single
 * subdirectory are merged into one row (GitHub PR style); all directories start
 * expanded and can be collapsed via `toggleDir`.
 */
export function useDiffFileTree(
  gitStatus: Map<string, string>,
  rootPath: string
): {
  items: FlatTreeItem[];
  toggleDir: (path: string) => void;
  revealDiffDirs: (keys: readonly string[]) => void;
  resetDiffCollapsed: () => void;
} {
  const env = useCoreEnv();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const items = useMemo(
    () => buildDiffTreeItems(env, gitStatus, rootPath, collapsed),
    [env, gitStatus, rootPath, collapsed]
  );

  const toggleDir = useCallback(
    (path: string) => {
      const key = workspaceRelativePath(rootPath, path);
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    },
    [rootPath]
  );

  /**
   * Expand directories by their diff-tree KEYS (relative paths).
   *
   * The mirror of `useFileTree`'s `revealPath` for the diff tree, and the reason
   * keys are passed in rather than derived here: a merged directory node's key is
   * the deepest real dir of the merged chain, so `app/src/utils` is one key and
   * `app/src` is not a row at all. Splitting the file's path would produce keys
   * that hide nothing.
   *
   * Callers get the chain from `changedFileJumpTarget`, which builds it with
   * nothing collapsed — reading it off the rendered rows cannot work, since a
   * collapsed ancestor removes the target row itself.
   */
  const revealDiffDirs = useCallback((keys: readonly string[]) => {
    if (keys.length === 0) return;
    setCollapsed((prev) => {
      if (keys.every((key) => !prev.has(key))) return prev;
      const next = new Set(prev);
      for (const key of keys) next.delete(key);
      return next;
    });
  }, []);

  /**
   * Drop every collapse choice, restoring the diff tree to its initial all-expanded
   * shape. Used by the panel's manual refresh so `r` resets BOTH trees — the
   * full-tree view's `expanded` is already cleared there, and leaving the diff
   * pane collapsed would make the same key mean different things per mode.
   */
  const resetDiffCollapsed = useCallback(() => {
    setCollapsed((prev) => (prev.size === 0 ? prev : new Set()));
  }, []);

  return { items, toggleDir, revealDiffDirs, resetDiffCollapsed };
}

// ============================================================================
// FileTree
// ============================================================================

interface FileTreeProps {
  items: FlatTreeItem[];
  gitStatus: Map<string, string>;
  dirStatuses: Map<string, DirStatusSummary>;
  rootPath: string;
  cursorIndex: number;
  selectedPath: string | null;
  scrollTop: number;
  visibleCount: number;
  loading: boolean;
  /** Shown instead of "(empty directory)" when the item list is empty. */
  emptyLabel?: string;
  /** Per-file +/− line counts vs HEAD (GitHub PR style labels). */
  diffStats?: Map<string, WorkspaceFileDiffStat> | null;
}

export const FileTree = ({
  items,
  gitStatus,
  dirStatuses,
  rootPath,
  cursorIndex,
  selectedPath,
  scrollTop,
  visibleCount,
  loading,
  emptyLabel,
  diffStats,
}: FileTreeProps) => {
  if (loading) return <Text color={COLORS.muted}>Loading tree...</Text>;
  if (items.length === 0)
    return (
      <Text color={COLORS.muted} dimColor>
        {emptyLabel ?? "(empty directory)"}
      </Text>
    );

  // Clamp the window at render. The owner resets the offset on a mode switch and keeps it valid
  // as rows/height change, but a stale prop must never draw an empty window. Row indices follow
  // the clamped `start`, not the raw offset — see `visibleWindow`.
  const { start, slice: windowItems } = visibleWindow(items, scrollTop, visibleCount);

  return (
    <Box flexDirection="column">
      {windowItems.map((item, offset) => {
        const index = start + offset;
        const isCursor = index === cursorIndex;
        const isSelected = item.type === "file" && selectedPath === item.path;
        const rowBg = isCursor ? BG.rowCursor : isSelected ? BG.rowSelected : undefined;
        const status = lookupGitStatus(gitStatus, rootPath, item.path);
        const style = status ? getStatusStyle(status) : null;
        const indent = "  ".repeat(item.indent);
        const rowColor = isCursor || isSelected ? COLORS.text : COLORS.muted;

        if (item.type === "directory") {
          const folderIcon = getFolderIconStyle(item.expanded, item.name);
          const dirSummary = dirStatuses.get(item.path);
          const dirLabel = formatDirStatus(dirSummary);
          return (
            <Box key={item.path} flexShrink={0} height={1} width="100%" backgroundColor={rowBg}>
              <Text wrap="truncate">
                {indent}
                <Text color={rowColor}>{folderIcon.chevron}</Text>
                <Text color={folderIcon.color}>{formatFolderGlyph(folderIcon)}</Text>
                <Text color={rowColor}>{item.name}/</Text>
                {dirLabel && (
                  <Text color={COLORS.warning} bold>
                    {" "}
                    [{dirLabel}]
                  </Text>
                )}
              </Text>
            </Box>
          );
        }

        const icon = getFileIconStyle(item.path);
        const stats = diffStats?.get(workspaceRelativePath(rootPath, item.path));
        return (
          <Box key={item.path} flexShrink={0} height={1} width="100%" backgroundColor={rowBg}>
            <Text wrap="truncate">
              {indent}
              <Text color={icon.color}>{formatIconGlyph(icon)}</Text>
              <Text color={rowColor}>{item.name}</Text>
              {style && (
                <Text color={style.color} bold>
                  {" "}
                  {style.label}
                </Text>
              )}
              {stats && (stats.added > 0 || stats.deleted > 0) && (
                <>
                  <Text color={COLORS.success}> +{stats.added}</Text>
                  <Text color={COLORS.danger}>−{stats.deleted}</Text>
                </>
              )}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
};
