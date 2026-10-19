import { Box, Text } from "ink";

import { COLORS } from "../theme/colors.js";

import { FileContent } from "./FileContent.js";
import { FileDiffContent } from "./FileDiffContent.js";

import type { WorkspaceMode } from "../hooks/use-workspace-panel.js";
import type { CodeViewRef, DiffViewRef } from "@git-diff-view/cli";
import type { Ref } from "react";

/**
 * Right pane content: the selected file's preview / diff, or a placeholder when
 * nothing is selected. Ref forwarding keeps the parent's scroll controls wired.
 */
export const WorkspacePreviewPane = ({
  mode,
  rootPath,
  selectedPath,
  renamedFrom,
  refreshToken,
  width,
  height,
  previewRef,
  diffRef,
}: {
  mode: WorkspaceMode;
  rootPath: string;
  selectedPath: string | null;
  /** Selection's rename source, when that row is a rename (see `useWorkspaceGit`). */
  renamedFrom?: string;
  refreshToken: number;
  width: number;
  height: number;
  previewRef: Ref<CodeViewRef>;
  diffRef: Ref<DiffViewRef>;
}) => {
  if (!selectedPath) {
    return (
      <Box height={height} alignItems="center" justifyContent="center">
        <Text color={COLORS.muted} dimColor>
          Select a file (→) to preview
        </Text>
      </Box>
    );
  }

  if (mode === "preview") {
    return <FileContent key={refreshToken} ref={previewRef} filePath={selectedPath} width={width} height={height} />;
  }

  return (
    <FileDiffContent
      // Keyed by the refresh token ONLY. `renamedFrom` deliberately is not part of it: the inner
      // `DiffView` is keyed by `state.diffId`, which already carries the parsed pairing, so the
      // content resets when a move appears or disappears. Adding it here would remount this
      // component too — discarding the header (and its label) during the re-fetch, which is the
      // one thing that should stay stable while only the pairing changed.
      key={refreshToken}
      ref={diffRef}
      rootPath={rootPath}
      filePath={selectedPath}
      width={width}
      height={height}
      {...(renamedFrom !== undefined ? { renamedFrom } : {})}
    />
  );
};
