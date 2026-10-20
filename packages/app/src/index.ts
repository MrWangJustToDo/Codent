// Adapter
export * from "./adapter/types.js";
export {
  createAgentSessionFromConfig,
  clearAgentStore,
  bindAgentSession,
  type AgentRuntimePort,
  type CreateAgentSessionOptions,
} from "./adapter/session-bootstrap.js";

// Context
export { AdapterProvider, useAdapter } from "./context/adapter-context.js";
export { CoreEnvProvider, useCoreEnv } from "./context/core-env-context.js";

// App
export { App } from "./app/App.js";
export { Agent } from "./app/Agent.js";

// Components
export { ExtensionRenderSurface, sanitizeAnsi } from "./components/ExtensionRenderSurface.js";
export { StreamingOutputView } from "./messages/StreamingOutputView.js";
export {
  ConfigEditor,
  STYLE_OPTIONS,
  type ConfigEditorProps,
  type ConfigEditorMode,
} from "./components/ConfigEditor.js";

// Hooks
export * from "./hooks";

// Commands
export {
  clearExtensionCommands,
  dispatchCommand,
  getAllCommands,
  getCommand,
  registerExtensionCommand,
  splitExtensionCommandArgs,
  syncExtensionCommands,
  COMMAND_FREEFORM_VALUE,
  typedArgsAfterCommand,
  withFreeformOption,
} from "./commands";
export type { Command, CommandContext, CommandOption } from "./commands";

// Utils
export { formatToolInput, formatToolOutput, formatToolArgs, formatDuration } from "./utils/format.js";
export {
  getToolCallColor,
  getInlineSummary,
  getCompactOutput,
  buildToolHeader,
  getDurationMs,
  DURATION_THRESHOLD_MS,
} from "./utils/format.js";
export {
  hasDetailedOutputBlock,
  keepsCompactRow,
  getToolStatusGlyph,
  isBudgetCutoffTaskPhase,
} from "./utils/tool-display.js";
export {
  HINT_ROTATE_INTERVAL_MS,
  INPUT_HINTS,
  currentInputHint,
  nextInputHint,
  resetInputHints,
} from "./utils/input-hints.js";
export {
  dedupeToolCallsInMessages,
  mergeToolCallPart,
  computeMessageRenderSignature,
  computeToolCallsRenderSignature,
  normalizeToolPartsInMessages,
  shouldFlattenPart,
} from "./utils/dedupe-tool-calls.js";
export {
  getUiToolState,
  isPreExecutionToolState,
  isToolCallPart,
  isToolExecuting,
  parseToolInput,
} from "./utils/tool-part.js";
export { resolveSubagentRowDisplay } from "./utils/subagent-status.js";
export { truncateTextToMaxLines, wrapTextToLines, textDisplayWidth } from "./utils/user-message-lines.js";
export { resolveStopDecision, type StopDecision } from "./utils/stop-decision.js";
export { resolveTaskSubagent } from "./utils/task-subagent.js";
export {
  CONVERSATION_SUMMARY_START,
  CONVERSATION_SUMMARY_END,
  extractCompactionSummaryBody,
  formatCompactionSummaryContent,
  hasOuterEndMarker,
  isCompactionSummaryText,
  isCompactionSummaryUIMessage,
} from "./utils/compaction-summary.js";

// Types
export type { Attachment } from "./types/attachment.js";

export {
  ensureLanguage,
  getHighlighter,
  getHighlighterSync,
  initHighlighter,
  type Highlighter,
  type InitHighlighterOptions,
} from "./utils/shared-highlighter.js";
export { configureEnv } from "reactivity-store";

export { mergeModelsConfig, type MergeModelsConfigOptions } from "./utils/merge-models-config.js";
export {
  applyModelsConfigEdit,
  type ApplyModelsConfigEditOptions,
  type ApplyModelsConfigEditResult,
} from "./utils/apply-models-config-edit.js";
