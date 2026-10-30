import { BUILTIN_TOOL_NAMES } from "@codent/core";

import { useTranscriptDisplayMode } from "../context/transcript-display-context.js";
import { useSize } from "../hooks";
import { useTask } from "../hooks/use-task.js";
import { isPreExecutionToolState, isToolExecuting } from "../utils/tool-part.js";
import { isBuiltinTool } from "../utils/tool-presentation.js";

import { EditFilePreview } from "./EditFilePreview.js";
import { MessageDiffView } from "./MessageDiffView.js";
import { TaskToolInputView } from "./TaskToolInputView.js";

import type { UiToolState } from "../utils/tool-part.js";
import type { ToolCallPart } from "@tanstack/ai";

export const ToolInputView = ({
  part,
  toolInput,
  uiState,
  hasError,
}: {
  part: ToolCallPart;
  toolInput: unknown;
  uiState: UiToolState;
  hasError: boolean;
}) => {
  const mode = useTranscriptDisplayMode();
  const toolName = part.name;
  const width = useSize((s) => s.state.screenWidth);
  // Align diff boxes with the tool-output halfbox: both sit directly in
  // ToolCallPartView's padded column (x=3) and span to the shared right edge.
  const bodyWidth = width - 4;
  const isExecuting = isToolExecuting(part);
  // Built-in-only previews read the built-in's input schema; a shadowing extension tool may not
  // have those fields, so it keeps the generic input rendering.
  const isTask = isBuiltinTool(toolName) && toolName === BUILTIN_TOOL_NAMES.task;
  const taskInput = toolInput as { prompt?: string; description?: string };
  const { phase: taskPhase, retry: taskRetry } = useTask({ taskId: isTask ? part.id : "" });

  // Compact: hide bulky diffs unless the user must review for approval.
  const showFileDiffs = mode === "full" || uiState === "approval-requested";

  if (isTask) {
    if (!taskInput?.prompt || taskPhase === "summary") return null;
    // Keep the row visible while a transient retry is in flight (the tool-call
    // is briefly not executing) so the retry state has somewhere to render.
    if (!isExecuting && !taskRetry) return null;
    return <TaskToolInputView part={part} toolInput={toolInput} />;
  }

  if (hasError) return null;

  if (isBuiltinTool(toolName) && toolName === BUILTIN_TOOL_NAMES.writeFile) {
    if (!showFileDiffs) return null;
    const content = toolInput as { content?: string; path?: string };
    if (!content || uiState === "input-streaming") return null;

    return (
      <MessageDiffView
        width={bodyWidth}
        oldPath=""
        oldFile=""
        newPath={content.path || ""}
        newFile={content.content || ""}
      />
    );
  }

  if (isBuiltinTool(toolName) && toolName === BUILTIN_TOOL_NAMES.editFile) {
    if (!showFileDiffs) return null;
    const content = toolInput as {
      path?: string;
      edits?: Array<{ oldString: string; newString: string; startLine?: number; replaceAll?: boolean }>;
    };

    if (!content || uiState === "input-streaming") return null;

    if (content.edits?.length && content.path) {
      return (
        <EditFilePreview
          toolCallId={part.id}
          path={content.path}
          edits={content.edits}
          bodyWidth={bodyWidth}
          // Pre-execution only: after the write, the full-file view is the tool's own output (when
          // the part has it) and a recomputed preview would report a refusal for work already done.
          canPreview={isPreExecutionToolState(uiState)}
          // Passed whenever it exists, not only in `output-available`: the output IS the datum, and
          // gating it on the state is what let a completed call fall through to the preview.
          output={part.output as { oldFile?: string; newFile?: string } | undefined}
        />
      );
    }

    return null;
  }

  return null;
};
