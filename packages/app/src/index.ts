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
export { InputScopeProvider, type InputSurface } from "./context/input-scope-context.js";

// App
export { App } from "./app/App.js";
export { Agent } from "./app/Agent.js";

// Components
export { ExtensionRenderSurface } from "./components/ExtensionRenderSurface.js";
// The workspace image preview owns zoom/pan + decode state, so a host (and the smoke harness) can
// mount it directly instead of going through the whole panel.
export { WorkspaceImagePreview } from "./components/WorkspaceImagePreview.js";
// The ANSI sandbox lives in `utils` because the workspace image preview needs the same rule.
export { sanitizeAnsi } from "./utils/ansi.js";
export { isAlternateScreenActive } from "./utils/alternate-screen.js";
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
// Workspace image previews: the cache is public so the panel's loading rules can be pinned by tests.
export {
  clearImagePreviewCache,
  imagePreviewCacheKey,
  loadImagePreview,
  type ImagePreviewRequest,
} from "./utils/image-preview-cache.js";
// Zoom/pan geometry: pure functions, so the window a zoom level asks for can be pinned by tests.
export {
  IMAGE_PAN_VIEWPORT_FRACTION,
  imagePanStep,
  imagePreviewBudget,
  imageViewRegion,
} from "./utils/image-viewport.js";
export {
  getToolCallColor,
  getInlineSummary,
  buildToolHeader,
  clampHeaderInput,
  CLAMP_MARKER,
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
export {
  planWorkspaceHeader,
  workspaceHeaderWidth,
  type WorkspaceHeaderContent,
  type WorkspaceHeaderPlan,
  type WorkspacePathDetail,
} from "./utils/workspace-header-layout.js";
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
