import { Box, Text } from "ink";

import { Spinner } from "../components/Spinner";
import { useRetryTicker } from "../hooks/use-retry-ticker";
import { useTask } from "../hooks/use-task";
import { COLORS } from "../theme/colors.js";
import { formatToolInput } from "../utils/format";
import { formatRetryStatus } from "../utils/retry-status";

import type { ToolCallPart } from "@tanstack/ai";

export const TaskToolInputView = ({ part }: { part: ToolCallPart; toolInput: unknown }) => {
  const { allTools, total, agent, retry } = useTask({ taskId: part.id });
  const retryNow = useRetryTicker(retry);

  const currentTool = allTools?.at(-1);
  const toolName = currentTool ? currentTool.toolName : "";

  // Only show formatted arguments when fully received (not streaming partial JSON)
  const isStreaming = currentTool?.state === "input-streaming";
  const currentInput = currentTool && !isStreaming ? formatToolInput(currentTool.input, toolName) : "...";

  if (!agent) {
    return (
      <Box flexDirection="row" height={1} paddingLeft={2}>
        <Spinner />
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
