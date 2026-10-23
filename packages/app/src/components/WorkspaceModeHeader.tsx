import { Box, Text } from "ink";

import { useAgentStatus } from "../hooks/use-agent-status.js";
import { useSize } from "../hooks/use-size.js";
import { COLORS } from "../theme/colors.js";
import { agentBusyLabel, isAgentBusyStatus } from "../utils/agent-status.js";
import { planWorkspaceHeader } from "../utils/workspace-header-layout.js";

import type { WorkspaceMode } from "../hooks/use-workspace-panel.js";
import type { WorkspaceDiffStats } from "../utils/workspace-diff-stats.js";
import type { WorkspaceGitInfo } from "../utils/workspace-git-info.js";

/** Lines reserved for the workspace header bar (kept in sync with its height). */
export const HEADER_LINES = 1;

/** Horizontal padding of the bar, on each side. */
const PADDING_X = 1;

/** Separator between two header groups. */
const SEP = " · ";

/** Last path segment — the informative half of a root path on a narrow terminal. */
function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

/**
 * Top bar of the workspace view: agent activity, mode, root, git branch state and diff stats.
 *
 * Width-aware: `planWorkspaceHeader` drops the least informative groups (sha, ahead/behind, the
 * path's leading directories, the file count, the diff totals) until the rest fits, so a narrow
 * terminal SHORTENS the bar instead of letting Ink's default `flexShrink: 1` shrink every group —
 * which truncated inside each of them (`Worksp · ● … diff · … mai 1 +−1`, i.e. corruption).
 *
 * The segments live in ONE `<Text>`: nested Texts are inline runs, not flex items, so the line has
 * a single item to truncate. That is also why the plan measures plain text — what it measures is
 * exactly what the renderer lays out.
 */
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
  const screenWidth = useSize((s) => s.state.screenWidth);

  const busyLabel = isWorking ? `● ${agentBusyLabel(status)}` : null;
  const branch = gitInfo ? `${gitInfo.branch}${gitInfo.dirty ? "*" : ""}` : null;
  // `…` stands in until the workspace root is known (it is read asynchronously), so the bar does
  // not read as "this workspace has no path".
  const displayPath = rootPath || "…";
  const hasDiffTotals = Boolean(diffStats && (diffStats.totalAdded > 0 || diffStats.totalDeleted > 0));
  const sync = gitInfo
    ? [gitInfo.behind > 0 ? `↓${gitInfo.behind}` : "", gitInfo.ahead > 0 ? `↑${gitInfo.ahead}` : ""]
        .filter(Boolean)
        .join(" ")
    : "";

  const plan = planWorkspaceHeader(
    {
      busy: busyLabel,
      mode,
      path: displayPath,
      branch,
      shortSha: gitInfo?.shortSha ?? null,
      sync: sync || null,
      files: hasDiffTotals ? `${diffStats!.files.size} files` : null,
      added: hasDiffTotals ? `+${diffStats!.totalAdded}` : null,
      deleted: hasDiffTotals ? `−${diffStats!.totalDeleted}` : null,
    },
    // 0 means "not measured yet" (the size store starts empty) — the plan keeps everything then.
    screenWidth > 0 ? screenWidth - PADDING_X * 2 : 0
  );

  const pathText = plan.path === "full" ? displayPath : plan.path === "basename" ? basename(displayPath) : "";
  // The plan already decided whether these fit; the values are `null` when the workspace has none.
  const sha = plan.sha ? gitInfo?.shortSha : undefined;
  const showSha = Boolean(sha && gitInfo && !gitInfo.branch.includes(sha));
  const showSync = plan.sync && Boolean(sync);

  return (
    <Box flexShrink={0} height={HEADER_LINES} paddingX={PADDING_X}>
      <Text wrap="truncate-end">
        <Text bold color={COLORS.primary}>
          Workspace
        </Text>
        {busyLabel ? (
          <Text color={COLORS.success}>
            {SEP}
            {busyLabel}
          </Text>
        ) : null}
        <Text color={COLORS.muted} dimColor>
          {busyLabel ? "" : SEP}
          {pathText ? `${mode}${SEP}${pathText}` : mode}
        </Text>
        {branch ? (
          <>
            <Text color={COLORS.muted} dimColor>
              {SEP}
            </Text>
            <Text color={COLORS.primary}>{branch}</Text>
            {showSha ? (
              <Text color={COLORS.muted} dimColor>
                {" "}
                {sha}
              </Text>
            ) : null}
            {showSync ? (
              <Text color={gitInfo!.behind > 0 ? COLORS.warning : COLORS.muted} dimColor={gitInfo!.behind === 0}>
                {" "}
                {sync}
              </Text>
            ) : null}
          </>
        ) : null}
        {plan.diffs && hasDiffTotals ? (
          <>
            <Text color={COLORS.muted} dimColor>
              {SEP}
            </Text>
            {plan.files ? <Text color={COLORS.muted}>{`${diffStats!.files.size} files `}</Text> : null}
            <Text color={COLORS.success}>+{diffStats!.totalAdded}</Text>
            <Text color={COLORS.danger}> −{diffStats!.totalDeleted}</Text>
          </>
        ) : null}
      </Text>
    </Box>
  );
};
