import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";

import { useRetryTicker } from "../hooks/use-retry-ticker.js";
import { SubagentPreviewView } from "../messages/SubagentPreviewView.js";
import { formatTaskTurns } from "../messages/task-turns.js";
import { COLORS } from "../theme/colors.js";
import { formatUsageBrief, resolvePromptTokens } from "../utils/format-usage.js";
import { KeyLabel } from "../utils/keyboard-labels.js";
import { formatRetryStatus } from "../utils/retry-status.js";
import { resolveAgentSession } from "../utils/session-resolve.js";
import { isSubagentActiveStatus, resolveSubagentRowDisplay } from "../utils/subagent-status.js";

import { Spinner } from "./Spinner.js";

export const SubagentDetailPanel = ({
  subagentId,
  taskPhase,
  onBack,
}: {
  subagentId: string;
  /**
   * The owning `task` call's phase, from the parent's subagent summary.
   *
   * The live snapshot has the subagent's own status but not this — the phase is parent-owned state
   * keyed by the task call. Taken as a prop rather than derived here so both panels route through
   * `resolveSubagentRowDisplay` and a cutoff reads the same in either view.
   */
  taskPhase?: string;
  onBack: () => void;
}) => {
  const [tick, setTick] = useState(0);

  const childSession = useMemo(() => resolveAgentSession(subagentId), [subagentId]);

  const snap = childSession?.getSnapshot();
  const status = snap?.status ?? "idle";

  useInput((input, key) => {
    if (key.escape) onBack();
    else if (input.toLowerCase() === "x" && isSubagentActiveStatus(status)) {
      void childSession?.dispatch({ type: "stop" }).catch(() => {});
    }
  });

  useEffect(() => {
    if (!childSession) return;
    // No `messages` channel: the transcript lives in SubagentPreviewView
    // (throttled via useSubagentMessages). Re-rendering this whole panel per
    // stream chunk would re-run the preview pipeline for every token.
    return childSession.subscribe(
      () => {
        setTick((n) => n + 1);
      },
      { channels: ["usage", "state", "lifecycle", "iteration"] }
    );
  }, [childSession, subagentId]);

  void tick;

  const retryNow = useRetryTicker(snap?.retry);

  const displayTitle = snap
    ? snap.name.startsWith("subagent-")
      ? snap.name.slice("subagent-".length)
      : snap.name
    : subagentId;

  const usage = snap?.usage.total;

  // Guard on the same cache-aware reading the label prints, so a fully cached run
  // (exclusive upstream → `inputTokens` ~0) still shows its cost-bearing row.
  const usageLabel =
    usage && resolvePromptTokens(usage) + (usage.outputTokens ?? 0) > 0 ? formatUsageBrief(usage) : null;

  // Subagent loop progress, e.g. `3/50`, from the child's retained `iteration`
  // channel. Live only: once the child is gone the frozen pair on the task output takes
  // over in the task row, and this panel has no live session to open at all — so there
  // is nothing to render here that is not already on the row. See `formatTaskTurns`.
  const turns = isSubagentActiveStatus(status) ? formatTaskTurns(snap?.iteration) : null;

  // Same rule as the list row: the phase may only describe a subagent whose own status is the
  // ambiguous `completed` a budget cutoff leaves behind — see `resolveSubagentRowDisplay`.
  const row = resolveSubagentRowDisplay(status, taskPhase);

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1} flexGrow={1}>
      <Box flexDirection="column" marginBottom={1} flexShrink={0}>
        <Box>
          <Text color={row.color} bold>
            {row.icon}{" "}
          </Text>
          <Text bold color={COLORS.primary} wrap="truncate">
            {displayTitle}
          </Text>
        </Box>
        <Box>
          <Text color={COLORS.muted} dimColor>
            {row.label}
          </Text>
          {turns ? (
            <Text color={COLORS.muted} dimColor>
              {" "}
              · {turns} turns
            </Text>
          ) : null}
          {usageLabel ? (
            <Text color={COLORS.muted} dimColor>
              {" "}
              · {usageLabel}
            </Text>
          ) : null}
          <Text color={COLORS.muted} dimColor>
            {" "}
            · ({KeyLabel.esc} back to task list)
          </Text>
          {isSubagentActiveStatus(status) ? (
            <Text color={COLORS.muted} dimColor>
              {" "}
              · {KeyLabel.x} stop
            </Text>
          ) : null}
        </Box>
        {snap?.retry && (
          <Box>
            <Spinner text={formatRetryStatus(snap.retry, retryNow)} />
          </Box>
        )}
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        <SubagentPreviewView subagentId={subagentId} />
      </Box>
    </Box>
  );
};
