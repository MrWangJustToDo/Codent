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
  refreshToken,
  width,
  height,
  previewRef,
  diffRef,
}: {
  mode: WorkspaceMode;
  rootPath: string;
  selectedPath: string | null;
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
      key={refreshToken}
      ref={diffRef}
      rootPath={rootPath}
      filePath={selectedPath}
      width={width}
      height={height}
    />
  );
};
