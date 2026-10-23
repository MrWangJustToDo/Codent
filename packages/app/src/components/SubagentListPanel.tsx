import { Box, Text } from "ink";
import { useEffect, useMemo, useState } from "react";

import { useTaskPanelInput } from "../hooks/input";
import { useSubagentPanel } from "../hooks/use-subagent-panel.js";
import { COLORS } from "../theme/colors.js";
import { listNavHint, pressEscToReturnHint } from "../utils/keyboard-labels.js";
import { resolveAgentSession } from "../utils/session-resolve.js";
import { getTaskLabel, isSubagentActiveStatus, resolveSubagentRowDisplay } from "../utils/subagent-status.js";

import type { AgentSessionSubagentSummary } from "@codent/core";

/**
 * One row in the subagent task list.
 *
 * Subscribes to the child session (via Host.connect) for live `state`/`lifecycle`
 * so the row's status stays current without waiting on root lifecycle events.
 * Falls back to the snapshot summary when the child session can't be resolved.
 */
const SubagentTaskRow = ({ task }: { task: AgentSessionSubagentSummary }) => {
  const [tick, setTick] = useState(0);

  const childSession = useMemo(() => resolveAgentSession(task.id), [task.id]);

  useEffect(() => {
    if (!childSession) return;
    return childSession.subscribe(
      () => {
        setTick((n) => n + 1);
      },
      { channels: ["state", "lifecycle"] }
    );
  }, [childSession, task.id]);

  void tick;

  // A budget cutoff leaves the subagent's own status at `completed` (the run did
  // not error or get cancelled), so the row label has to carry the distinction or
  // it reads as a clean finish. The phase is per task CALL though, and one call can
  // own several subagents (a discarded pre-fork and its respawn), so only the row
  // whose own status is that ambiguous `completed` may take its label from it —
  // see `resolveSubagentRowDisplay`.
  const status = childSession?.getSnapshot().status ?? task.status;
  const row = resolveSubagentRowDisplay(status, task.taskPhase);

  return (
    <>
      <Text color={row.color} bold={isSubagentActiveStatus(status)}>
        {row.icon} {getTaskLabel(task)}
      </Text>
      <Text color={COLORS.muted} dimColor>
        {" "}
        ({row.label})
      </Text>
    </>
  );
};

export const SubagentListPanel = ({
  tasks,
  onSelect,
  onClose,
}: {
  tasks: AgentSessionSubagentSummary[];
  onSelect: (id: string) => void;
  onClose: () => void;
}) => {
  const storedIndex = useSubagentPanel((s) => s.selectedIndex);
  const setStoredIndex = useSubagentPanel.getActions().setSelectedIndex;
  const view = useSubagentPanel((s) => s.view);

  // Clamped on read, not on write: rows can disappear while the cursor sits in the detail view,
  // and only the list knows the count. Deriving it here (rather than storing a corrected value)
  // keeps Enter and the arrow keys in agreement even in the render where the list just shrank.
  // The stored value is left as-is on purpose — it costs nothing, and if the list grows back the
  // cursor lands near where the user left it instead of snapping to the top.
  const selectedIndex = Math.min(storedIndex, Math.max(0, tasks.length - 1));

  useTaskPanelInput(
    (input, key) => {
      if (key.upArrow) {
        setStoredIndex(Math.max(0, selectedIndex - 1));
        return;
      }
      if (key.downArrow) {
        setStoredIndex(Math.min(tasks.length - 1, selectedIndex + 1));
        return;
      }
      if (key.return && tasks[selectedIndex]) {
        onSelect(tasks[selectedIndex]!.id);
        return;
      }
      if (key.escape) {
        onClose();
        return;
      }
      if (key.ctrl && input === "t") {
        // Ctrl+T opened this panel; while it is up, the same chord closes it.
        onClose();
      }
    },
    // `SubagentPanel` renders the list unless it is showing the detail view, so the gate has to be
    // the same predicate — `view === "list"` would leave the list on screen with dead keys in the
    // transient `detail` state that has no selected id.
    { when: view !== "detail" }
  );

  if (tasks.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Text bold color={COLORS.primary}>
          Tasks
        </Text>
        <Text color={COLORS.muted} dimColor>
          No subagent tasks yet.
        </Text>
        <Text color={COLORS.muted} dimColor>
          {pressEscToReturnHint()}
        </Text>
      </Box>
    );
  }

  const activeCount = tasks.filter((t) => isSubagentActiveStatus(t.status)).length;

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box marginBottom={1}>
        <Text bold color={COLORS.primary}>
          Tasks
        </Text>
        <Text dimColor>
          {" "}
          ({tasks.length} total{activeCount > 0 ? `, ${activeCount} active` : ""})
        </Text>
        <Text dimColor> {listNavHint("open")}</Text>
      </Box>
      {tasks.map((task, i) => {
        const isSelected = i === selectedIndex;
        return (
          <Box key={task.id}>
            <Text color={isSelected ? COLORS.primary : undefined} bold={isSelected}>
              {isSelected ? "❯ " : "  "}
            </Text>
            <SubagentTaskRow task={task} />
          </Box>
        );
      })}
    </Box>
  );
};
