import { DiffModeEnum, DiffView, type DiffViewRef, type ScrollState } from "@git-diff-view/cli";
import { generateDiffFile } from "@git-diff-view/file";
import { Box, Text } from "ink";
import { forwardRef, useEffect, useMemo, useState } from "react";

import { useCoreEnv } from "../context/core-env-context.js";
import { COLORS } from "../theme/colors.js";
import { MIN_SPLIT_DIFF_WIDTH } from "../utils/diff-layout.js";
import { isLikelyBinaryPath } from "../utils/file-icons.js";
import { fetchWorkspaceFileDiff } from "../utils/workspace-git-diff.js";

type DiffPreviewState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; fileName: string; hasChanges: boolean; diffId: string };

interface FileDiffContentProps {
  rootPath: string;
  filePath: string;
  width: number;
  /** Viewport height in terminal rows, including the header line. */
  height?: number;
  onScrollChange?: (state: ScrollState) => void;
}

export const FileDiffContent = forwardRef<DiffViewRef, FileDiffContentProps>(function FileDiffContent(
  { rootPath, filePath, width, height, onScrollChange },
  ref
) {
  const env = useCoreEnv();
  const [state, setState] = useState<DiffPreviewState>({ status: "loading" });
  const [scrollState, setScrollState] = useState<ScrollState | null>(null);
  const [diffPayload, setDiffPayload] = useState<Awaited<ReturnType<typeof fetchWorkspaceFileDiff>> | null>(null);
  const diffHeight = height ? Math.max(1, height - 1) : undefined;

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    setScrollState(null);
    setDiffPayload(null);

    if (isLikelyBinaryPath(filePath)) {
      setState({ status: "error", message: "Binary file — diff preview not available in workspace." });
      return;
    }

    fetchWorkspaceFileDiff(env, rootPath, filePath)
      .then((payload) => {
        if (cancelled) return;
        setDiffPayload(payload);
        setState({
          status: "ready",
          fileName: payload.fileName,
          hasChanges: payload.hasChanges,
          diffId: `${rootPath}\0${filePath}`,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : "Failed to load git diff";
        setState({ status: "error", message });
      });

    return () => {
      cancelled = true;
    };
  }, [env, filePath, rootPath]);

  const diffFile = useMemo(() => {
    if (!diffPayload) return null;
    const file = generateDiffFile(
      diffPayload.relativePath,
      diffPayload.oldContent,
      diffPayload.relativePath,
      diffPayload.newContent,
      "",
      ""
    );
    file.initTheme("dark");
    file.init();
    return file;
  }, [diffPayload]);

  const handleScrollChange = (next: ScrollState) => {
    setScrollState(next);
    onScrollChange?.(next);
  };

  if (state.status === "loading") {
    return (
      <Box paddingY={1}>
        <Text color={COLORS.muted}>Loading diff...</Text>
      </Box>
    );
  }

  if (state.status === "error") {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text bold color={COLORS.danger}>
          Cannot show diff
        </Text>
        <Text color={COLORS.danger}>{state.message}</Text>
      </Box>
    );
  }

  if (!diffFile) return null;

  const diffMode = width >= MIN_SPLIT_DIFF_WIDTH && diffPayload?.oldContent ? DiffModeEnum.Split : DiffModeEnum.Unified;

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box flexShrink={0} paddingY={0} borderBottom>
        <Text bold color={COLORS.primary}>
          {state.fileName}
        </Text>
        <Text color={COLORS.muted} dimColor>
          {" "}
          — {state.hasChanges ? "changes vs HEAD" : "no changes vs HEAD"}
          {scrollState && scrollState.startLine > 1 ? ` · L${scrollState.startLine}+` : ""}
        </Text>
      </Box>

      <Box flexShrink={0} paddingY={0}>
        <DiffView
          ref={ref}
          key={state.diffId}
          diffFile={diffFile}
          width={width}
          height={diffHeight}
          diffViewMode={diffMode}
          diffViewHideOperator
          diffViewHighlight
          diffViewNoBG
          diffViewTheme="dark"
          onScrollChange={handleScrollChange}
        />
      </Box>
    </Box>
  );
});
