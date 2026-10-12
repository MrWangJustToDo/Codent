import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { useCoreEnv } from "../context/core-env-context.js";
import { useWorkspaceView } from "../hooks/use-workspace-view.js";
import { BG, COLORS } from "../theme/colors.js";
import { formatIconGlyph, getFileIconStyle } from "../utils/file-icons.js";
import { fetchWorkspaceFileList, fuzzyFilterFiles, type FuzzyFileResult } from "../utils/workspace-file-search.js";
import { joinWorkspacePath } from "../utils/workspace-path.js";
import { ensureIndexVisible } from "../utils/workspace-scroll.js";

const MAX_RESULTS = 50;

/** Path with matched query chars highlighted (fzf style). */
function highlightPath(path: string, indices: readonly number[]): ReactNode {
  if (indices.length === 0) return path;
  const parts: ReactNode[] = [];
  let last = 0;
  for (const idx of indices) {
    if (idx > last) parts.push(path.slice(last, idx));
    parts.push(
      <Text key={idx} color={COLORS.warning} bold>
        {path[idx]}
      </Text>
    );
    last = idx + 1;
  }
  if (last < path.length) parts.push(path.slice(last));
  return parts;
}

// ============================================================================
// WorkspaceQuickOpen — fzf-style fuzzy file finder overlay.
//
// Ctrl+P in the workspace opens it. Owns the keyboard while open (the parent
// WorkspaceFileMode early-returns): typing filters, ↑↓ moves the cursor,
// Enter opens the selected file, Esc / Ctrl+U behave as expected.
// ============================================================================

interface WorkspaceQuickOpenProps {
  rootPath: string;
  width: number;
  height: number;
}

export const WorkspaceQuickOpen = ({ rootPath, width, height }: WorkspaceQuickOpenProps) => {
  const env = useCoreEnv();
  const quickOpen = useWorkspaceView((s) => s.quickOpen);
  const { closeQuickOpen, moveQuickOpenCursor, selectFile, setMode, setQuickOpenCursor, setQuickOpenQuery } =
    useWorkspaceView.getActions();

  const [files, setFiles] = useState<string[] | null>(null);
  const [scrollTop, setScrollTop] = useState(0);

  useEffect(() => {
    if (!rootPath) return;
    let cancelled = false;
    fetchWorkspaceFileList(env, rootPath)
      .then((list) => {
        if (!cancelled) setFiles(list);
      })
      .catch(() => {
        if (!cancelled) setFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [env, rootPath]);

  const query = quickOpen?.query ?? "";
  const cursor = quickOpen?.cursor ?? 0;

  const results = useMemo<FuzzyFileResult[]>(() => {
    if (!files) return [];
    return fuzzyFilterFiles(query, files, MAX_RESULTS);
  }, [files, query]);

  const visibleCount = Math.max(3, height - 4);

  // Clamp the cursor to the result list and keep it visible while typing.
  useEffect(() => {
    if (results.length === 0) return;
    if (cursor >= results.length) setQuickOpenCursor(results.length - 1);
    setScrollTop((prev) => ensureIndexVisible(cursor, prev, visibleCount, results.length));
  }, [cursor, results.length, visibleCount, setQuickOpenCursor]);

  const openSelected = () => {
    const result = results[cursor];
    if (!result) return;
    closeQuickOpen();
    // Picking from search always lands in file (preview) view: search spans all
    // files, so staying in diff mode would show an empty diff for a jump target
    // that has no changes.
    setMode("preview");
    selectFile(joinWorkspacePath(env, rootPath, result.path));
  };

  useInput((inputChar, key) => {
    if (key.escape) {
      closeQuickOpen();
      return;
    }
    if (key.return) {
      openSelected();
      return;
    }
    if (key.upArrow) {
      moveQuickOpenCursor(-1, results.length);
      return;
    }
    if (key.downArrow) {
      moveQuickOpenCursor(1, results.length);
      return;
    }
    if (key.backspace || key.delete) {
      setQuickOpenQuery(query.slice(0, -1));
      return;
    }
    if (key.ctrl && inputChar === "u") {
      setQuickOpenQuery("");
      return;
    }
    if (inputChar) {
      setQuickOpenQuery(query + inputChar);
    }
  });

  const windowResults = results.slice(scrollTop, scrollTop + visibleCount);

  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="single" borderColor={COLORS.primary}>
      <Box flexShrink={0} paddingX={1}>
        <Text bold color={COLORS.primary}>
          ❯{" "}
        </Text>
        <Text color={COLORS.text}>
          {query || (
            <Text color={COLORS.muted} dimColor>
              find file…
            </Text>
          )}
        </Text>
      </Box>
      <Box flexShrink={0} paddingX={1}>
        <Text color={COLORS.muted} dimColor>
          {files === null ? "Loading files…" : results.length === 0 ? "no matches" : `${results.length} matches`}
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} paddingX={1} overflow="hidden">
        {windowResults.map((result, offset) => {
          const index = scrollTop + offset;
          const isCursor = index === cursor;
          const icon = getFileIconStyle(result.path);
          return (
            <Box key={result.path} flexShrink={0} height={1} backgroundColor={isCursor ? BG.rowCursor : undefined}>
              <Text wrap="truncate" color={isCursor ? COLORS.text : COLORS.muted}>
                <Text color={icon.color}>{formatIconGlyph(icon)}</Text> {highlightPath(result.path, result.indices)}
              </Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
};
