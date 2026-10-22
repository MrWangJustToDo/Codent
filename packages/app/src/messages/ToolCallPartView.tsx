import { BUILTIN_TOOL_NAMES } from "@codent/core";
import { Box, Text } from "ink";

import { HalfLinePaddedBox } from "../components/HalfLinePaddedBox.js";
import { useTranscriptDisplayMode } from "../context/transcript-display-context.js";
import { useSize } from "../hooks";
import { useSummaryStream } from "../hooks/use-summary-stream.js";
import { useTask } from "../hooks/use-task.js";
import { useToolElapsed } from "../hooks/use-tool-elapsed.js";
import { BG, COLORS } from "../theme/colors.js";
import { formatUsageBrief, resolvePromptTokens } from "../utils/format-usage.js";
import {
  buildToolHeader,
  DURATION_THRESHOLD_MS,
  formatDuration,
  formatToolInput,
  getDurationMs,
  getInlineSummary,
  getToolCallColor,
  isBudgetCutoffTaskPhase,
  LIVE_DURATION_THRESHOLD_MS,
} from "../utils/format.js";
import { getUiToolState, isCancelledToolCall, isToolExecuting, parseToolInput } from "../utils/tool-part.js";

import { StreamingOutputView } from "./StreamingOutputView.js";
import { SummaryStreamView } from "./SummaryStreamView.js";
import { formatTaskTurns } from "./task-turns.js";
import { ToolInputView } from "./ToolInputView.js";
import { ToolOutputView } from "./ToolOutputView.js";
import { ToolStatusIcon } from "./ToolStatusIcon.js";

import type { TaskTurnCounts } from "./task-turns.js";
import type { TokenUsage } from "@codent/core";
import type { ToolCallPart } from "@tanstack/ai";

/**
 * Token fields the task row reads. `billedInputTokens` is the cache-aware prompt a
 * completed task carries on its frozen tool output; the cache fields are only present
 * on the live Session fallback.
 */
type TaskUsageLike = {
  inputTokens?: number;
  outputTokens?: number;
  billedInputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

function extractErrorText(part: ToolCallPart): string | null {
  const uiState = getUiToolState(part);
  if (uiState === "output-denied") {
    const approvalReason = (part.approval as { reason?: string } | undefined)?.reason;
    if (approvalReason) return approvalReason;

    const output = part.output;
    if (output && typeof output === "object" && "message" in output) {
      return String((output as { message?: unknown }).message ?? "Denied");
    }
    if (output && typeof output === "object" && "error" in output) {
      return String((output as { error?: unknown }).error ?? "Denied");
    }
    return "Denied";
  }
  if (uiState === "output-error") {
    const output = part.output;
    if (output && typeof output === "object" && "error" in output) {
      return String((output as { error?: unknown }).error);
    }
    return "Tool error";
  }
  return null;
}

export interface ToolCallPartViewProps {
  part: ToolCallPart;
  readOnly?: boolean;
  /** Throttle for live `run_command` / `task` stream UI updates (ms). Default: 100 for run_command, 0 for task. */
  streamingThrottleMs?: number;
}

const RUN_COMMAND_STREAM_THROTTLE_MS = 100;

/** Render a tool invocation part — unified compact style for all tools */
export const ToolCallPartView = ({ part, streamingThrottleMs }: ToolCallPartViewProps) => {
  const displayMode = useTranscriptDisplayMode();
  const uiState = getUiToolState(part);
  const toolName = part.name;
  const toolCallId = part.id;
  const toolInput = parseToolInput(part);

  const isRunCommand = toolName === BUILTIN_TOOL_NAMES.runCommand;
  const isTask = toolName === BUILTIN_TOOL_NAMES.task;
  const isExecuting = isToolExecuting(part);
  const screenWidth = useSize((s) => s.state.screenWidth);
  // Same box metrics as ToolOutputView: message container paddingX=1 + tool
  // column paddingLeft=2 → width compensates so the right edge aligns with
  // user message boxes (screenWidth - 2).
  const boxWidth = Math.max(screenWidth - 4, 1);
  const liveElapsedMs = useToolElapsed(toolCallId, isExecuting, LIVE_DURATION_THRESHOLD_MS);
  const {
    phase: taskPhase,
    usage: taskUsage,
    agent: taskAgent,
    iteration: taskIteration,
  } = useTask({
    taskId: isTask ? part.id : "",
  });
  // Authoritative per-task phase machine (running → summary | limit): the
  // `begin_summary` call and the progress-summary fallback both transition it, so
  // the panel view no longer depends on message inference.
  const showTaskSummaryStream = isTask && isExecuting && taskPhase === "summary";
  const taskSummary = useSummaryStream({
    source: "task",
    toolCallId: isTask ? toolCallId : undefined,
    enabled: showTaskSummaryStream,
    maxLines: 5,
  });
  // `useTask` collapses core's phase onto tools/summary, but the row still needs
  // the live phase: a budget cutoff is NOT a natural finish, and only the live
  // value can say which one this was (the subagent's own status is `completed`
  // either way). Read it from the summary the parent handed down.
  const stoppedByLimit = isTask && isBudgetCutoffTaskPhase(taskAgent?.taskPhase);
  // Subagent loop progress, e.g. `3/50`. Live while the task runs; after it settles the
  // frozen pair on the output keeps the row readable once the child session is gone
  // (a restore). See `formatTaskTurns`.
  const taskTurns = isTask
    ? formatTaskTurns(taskIteration, (part.output as TaskTurnCounts | undefined) ?? undefined)
    : null;

  const displayInput =
    toolInput === undefined || toolInput === null
      ? null
      : formatToolInput(toolInput, toolName, { compact: displayMode === "compact" }) || null;

  const hasOutput = uiState === "output-available" || uiState === "output-error" || uiState === "output-denied";
  const hasDenied = uiState === "output-denied";
  // A run the user cancelled — either cancel shape (framework `cancelled` marker or the
  // task tool's own `aborted`). Both settle to states that would otherwise read as failure
  // (run_command → output-error) or success (task → output-available); the row must say
  // "stopped" instead. See `isCancelledToolCall`. Only a settled output can carry the
  // marker, which is what `hasOutput` gates.
  const stoppedByCancel = hasOutput && isCancelledToolCall(part);
  const durationMs = hasOutput ? getDurationMs(part.output) : null;
  const showDuration = durationMs !== null && durationMs >= DURATION_THRESHOLD_MS;

  const errorText = extractErrorText(part);
  // The header summary travels with the part (core renders it at completion), so a host
  // without the tool registry still shows it; the local formatter is the fallback for
  // parts written before core started attaching the payload.
  const inlineSummary = errorText
    ? null
    : ((part as { display?: { summary?: string } }).display?.summary ?? getInlineSummary(part, toolName)) || null;
  const outputFailed = (part.output as { success?: boolean } | undefined)?.success === false;
  // Density compact: skip success one-liners; keep failure hints. A cut-off task
  // is treated as a failure hint: it must not read as a clean finish.
  const stateColor = errorText || outputFailed || stoppedByLimit ? COLORS.danger : getToolCallColor(uiState);
  // A user cancel is neither failure nor success: the header keeps its state color but the
  // row's parenthetical already says "cancelled" (via getInlineSummary), and the icon turns
  // the neutral warning glyph.
  const headerColor = stoppedByCancel ? COLORS.warning : stateColor;

  // Compact display: errored/denied tools are handled by the compact projection
  // (errors fold into an activity summary count; denied rows are filtered). This
  // render-layer guard still covers the final (live streaming) message, which the
  // projection layer does not process.
  if (displayMode === "compact" && (uiState === "output-error" || uiState === "output-denied")) {
    return null;
  }

  const outputUsage =
    isTask && hasOutput && part.output && typeof part.output === "object" && "usage" in part.output
      ? (part.output as { usage?: TaskUsageLike }).usage
      : null;
  // Completed tasks: prefer frozen tool-output usage over live Session totals.
  // The frozen output carries the subagent's cache-aware `billedInputTokens`; the live
  // fallback carries the raw cache fields instead, which `formatUsageBrief` reads
  // through the same rule. Merging keeps `displayUsage` uniformly addressable.
  const displayUsage: TaskUsageLike | null =
    outputUsage != null
      ? outputUsage
      : taskUsage != null
        ? {
            inputTokens: taskUsage.inputTokens,
            outputTokens: taskUsage.outputTokens,
            cacheReadTokens: (taskUsage as TokenUsage).cacheReadTokens,
            cacheWriteTokens: (taskUsage as TokenUsage).cacheWriteTokens,
          }
        : null;

  const parenParts: string[] = [];
  if (inlineSummary) parenParts.push(inlineSummary);
  // Budget cutoff: the only signal that separates it from a clean finish while the
  // row is still live. `inlineSummary` carries the same word once core attaches the
  // completed payload — this covers the window before the part settles, and every
  // host that renders without the tool registry.
  if (stoppedByLimit && !inlineSummary) parenParts.push("limit reached");
  if (taskTurns) parenParts.push(`${taskTurns} turns`);
  if (showDuration) {
    parenParts.push(formatDuration(durationMs!));
  } else if (liveElapsedMs != null) {
    parenParts.push(formatDuration(liveElapsedMs));
  }
  // A billing reading is whichever token is non-zero: `billedInputTokens` is the
  // cache-aware prompt, and a run can hold cost with only cache reads (exclusive
  // upstream) or only fresh input (inclusive).
  const hasBillableUsage =
    displayUsage != null &&
    resolvePromptTokens({
      inputTokens: displayUsage.inputTokens ?? 0,
      billedInputTokens: displayUsage.billedInputTokens,
      cacheReadTokens: displayUsage.cacheReadTokens,
      cacheWriteTokens: displayUsage.cacheWriteTokens,
    }) +
      (displayUsage.outputTokens ?? 0) >
      0;
  if (isTask && hasBillableUsage) {
    parenParts.push(
      formatUsageBrief({
        inputTokens: displayUsage.inputTokens ?? 0,
        outputTokens: displayUsage.outputTokens ?? 0,
        billedInputTokens: displayUsage.billedInputTokens,
        cacheReadTokens: displayUsage.cacheReadTokens,
        cacheWriteTokens: displayUsage.cacheWriteTokens,
      })
    );
  }
  const parenText = parenParts.length > 0 ? ` (${parenParts.join(", ")})` : "";
  const headerText = buildToolHeader(toolName, displayInput, parenText, headerColor);

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box flexDirection="row">
        <Box flexShrink={0} width={2}>
          <ToolStatusIcon
            state={uiState}
            toolName={toolName}
            stoppedByLimit={stoppedByLimit}
            stoppedByCancel={stoppedByCancel}
          />
        </Box>
        <Text wrap="wrap">{headerText}</Text>
      </Box>

      <ToolInputView part={part} toolInput={toolInput} uiState={uiState} hasError={Boolean(errorText)} />

      {isRunCommand && isExecuting && (
        <StreamingOutputView
          toolCallId={toolCallId}
          enabled={isRunCommand && isExecuting}
          throttleMs={streamingThrottleMs ?? RUN_COMMAND_STREAM_THROTTLE_MS}
        />
      )}
      {showTaskSummaryStream && taskSummary.rows.length > 0 && (
        <HalfLinePaddedBox backgroundColor={BG.toolResult} width={boxWidth}>
          <SummaryStreamView rows={taskSummary.rows} height={5} />
        </HalfLinePaddedBox>
      )}

      {hasOutput && <ToolOutputView part={part} uiState={uiState} />}

      {hasDenied && errorText && (
        <Box paddingLeft={2}>
          <Text color={COLORS.danger} wrap="truncate-end">
            {errorText}
          </Text>
        </Box>
      )}
    </Box>
  );
};
