import { Box, Text } from "ink";

import { useAgentStatus } from "../hooks/use-agent-status.js";
import { COLORS } from "../theme/colors.js";
import { agentBusyLabel, isAgentBusyStatus } from "../utils/agent-status.js";

import type { WorkspaceMode } from "../hooks/use-workspace-panel.js";
import type { WorkspaceDiffStats } from "../utils/workspace-diff-stats.js";
import type { WorkspaceGitInfo } from "../utils/workspace-git-info.js";

/** Lines reserved for the workspace header bar (kept in sync with its height). */
export const HEADER_LINES = 1;

/** Top bar of the workspace view: agent activity, mode, root, git branch state and diff stats. */
export const WorkspaceModeHeader = ({
  mode,
  rootPath,
  gitInfo,
  diffStats,
}: {
  mode: WorkspaceMode;
  rootPath: string;
  gitInfo: WorkspaceGitInfo | null;
  diffStats: WorkspaceDiffStats | null;
}) => {
  // The workspace panel covers the footer while it is open, so the agent's activity moves up here:
  // a user browsing files can still see that the agent is working. Same busy set as the footer.
  const status = useAgentStatus((s) => s.status);
  const isWorking = isAgentBusyStatus(status);

  return (
    <Box flexShrink={0} height={HEADER_LINES} paddingX={1}>
      <Text bold color={COLORS.primary}>
        Workspace
      </Text>
      {isWorking && (
        <>
          <Text color={COLORS.muted} dimColor>
            {" "}
            ·{" "}
          </Text>
          <Text color={COLORS.success}>● {agentBusyLabel(status)}</Text>
        </>
      )}
      <Text color={COLORS.muted} dimColor>
        {" "}
        {mode} · {rootPath || "…"}
      </Text>
      {gitInfo && (
        <>
          <Text color={COLORS.muted} dimColor>
            {" "}
            ·{" "}
          </Text>
          <Text color={COLORS.primary}>
            {gitInfo.branch}
            {gitInfo.dirty ? "*" : ""}
          </Text>
          {gitInfo.shortSha && !gitInfo.branch.includes(gitInfo.shortSha) ? (
            <Text color={COLORS.muted} dimColor>
              {" "}
              {gitInfo.shortSha}
            </Text>
          ) : null}
          {(gitInfo.ahead > 0 || gitInfo.behind > 0) && (
            <Text color={gitInfo.behind > 0 ? COLORS.warning : COLORS.muted} dimColor={gitInfo.behind === 0}>
              {" "}
              {gitInfo.behind > 0 ? `↓${gitInfo.behind}` : ""}
              {gitInfo.ahead > 0 && gitInfo.behind > 0 ? " " : ""}
              {gitInfo.ahead > 0 ? `↑${gitInfo.ahead}` : ""}
            </Text>
          )}
        </>
      )}
      {diffStats && (diffStats.totalAdded > 0 || diffStats.totalDeleted > 0) && (
        <>
          <Text color={COLORS.muted} dimColor>
            {" "}
            ·{" "}
          </Text>
          <Text color={COLORS.muted}>{diffStats.files.size} files</Text>
          <Text color={COLORS.success}> +{diffStats.totalAdded}</Text>
          <Text color={COLORS.danger}>−{diffStats.totalDeleted}</Text>
        </>
      )}
    </Box>
  );
};
