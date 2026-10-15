import { Box, Text } from "ink";

import { Spinner } from "../components/Spinner";
import { useRetryTicker } from "../hooks/use-retry-ticker";
import { useTask } from "../hooks/use-task";
import { useTaskQueue } from "../hooks/use-task-queue";
import { COLORS } from "../theme/colors.js";
import { formatToolInput } from "../utils/format";
import { formatRetryStatus } from "../utils/retry-status";

import type { ToolCallPart } from "@tanstack/ai";

export const TaskToolInputView = ({ part, toolInput }: { part: ToolCallPart; toolInput: unknown }) => {
  const { allTools, total, agent, retry } = useTask({ taskId: part.id });
  const { queued, active, max } = useTaskQueue();
  const retryNow = useRetryTicker(retry);

  const currentTool = allTools?.at(-1);
  const toolName = currentTool ? currentTool.toolName : "";

  // Only show formatted arguments when fully received (not streaming partial JSON)
  const isStreaming = currentTool?.state === "input-streaming";
  const currentInput = currentTool && !isStreaming ? formatToolInput(currentTool.input, toolName) : "...";

  if (!agent) {
    // No subagent yet, but the row still has to say WHICH task it is — and, when core says so,
    // that it is waiting for a slot.
    //
    // A turn's `task` calls are admitted by the pre-fork coordinator a few at a time
    // (`maxConcurrentTasks`, default 4); the rest wait and — by design — emit no
    // `agent:tool-start` until they are admitted. A bare spinner there made every waiting task an
    // anonymous row that could not be told apart from the others, or from a task with nothing to
    // show yet. The label comes from the tool input this row already carries; the `queued` entry
    // comes from `subagent:queue` and is what makes the wait itself visible.
    const waiting = queued.find((entry) => entry.toolCallId === part.id);
    return (
      <Box flexDirection="row" height={1} paddingLeft={2} flexWrap="nowrap">
        <Box flexShrink={0} flexGrow={0}>
          <Text color={COLORS.muted}>↳ </Text>
        </Box>
        <Text color={COLORS.muted} italic wrap="truncate">
          {waiting?.description ?? readTaskLabel(toolInput)}
        </Text>
        {waiting ? (
          <Box flexShrink={0} flexGrow={0} paddingLeft={1}>
            <Text color={COLORS.muted} dimColor>
              queued{max > 0 ? ` (${active}/${max} running)` : ""}
            </Text>
          </Box>
        ) : (
          <Box flexShrink={0} flexGrow={0} paddingLeft={1}>
            <Spinner />
          </Box>
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="row" height={1} paddingLeft={2} flexWrap="nowrap">
      <Box flexShrink={0} flexGrow={0}>
        <Text color={COLORS.muted}>↳ </Text>
      </Box>
      {currentTool ? (
        <>
          <Box flexShrink={0} flexGrow={0}>
            <Text color={COLORS.muted} italic>
              {toolName}
              {total && total > 1 ? ` (+${total}) ` : " "}
            </Text>
          </Box>
          <Text color={COLORS.muted} italic dimColor wrap="truncate">
            {currentInput}
          </Text>
        </>
      ) : (
        <Spinner />
      )}
      {retry && (
        <Box flexShrink={0} flexGrow={0} paddingLeft={1}>
          <Text color={COLORS.danger} wrap="truncate">
            {formatRetryStatus(retry, retryNow)}
          </Text>
        </Box>
      )}
    </Box>
  );
};

/**
 * A one-line label for a task whose subagent has not started yet.
 *
 * `description` is what the model was asked to do and is meant to be short; the prompt is the
 * fallback, first line only, because a prompt is multi-line and this is a single-height row.
 */
function readTaskLabel(toolInput: unknown): string {
  const input = toolInput as { description?: string; prompt?: string } | undefined;
  const description = input?.description?.trim();
  if (description) return description;
  const firstLine = input?.prompt?.trim().split("\n")[0]?.trim();
  return firstLine || "task";
}
