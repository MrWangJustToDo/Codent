// ============================================================================
// CoreEnv — register before any core usage
// ============================================================================

export {
  registerCoreEnv,
  clearCoreEnv,
  getEnv,
  hasCoreEnv,
  defaultPath,
  defaultByteLength,
  defaultBase64Encode,
  defaultBase64Decode,
  type CoreEnv,
  type ResolvedCoreEnv,
  type CoreEnvPath,
  type CoreEnvFs,
  type CoreEnvFsStat,
  type CoreEnvExecOptions,
  type CoreEnvExecResult,
  type CoreEnvImageRegion,
  type CoreEnvImageTextResult,
  type CoreEnvImageToTextOptions,
  type McpStdioTransportConfig,
  type McpProcessHandle,
} from "./env";

// ============================================================================
// LSP transport (optional, Node.js only — feature-detected by LSP extension)
// ============================================================================

export type { LspServerConfig, LspConnection, LspMessage, LspRequestOptions } from "./env/lsp";
export type { LspConnectionFactory } from "./env";
export type { LspServerConfigRecord, ServerStatus } from "./agent/lsp/lsp-manager.js";

// ============================================================================
// Model provider plane (orthogonal to CoreEnv)
// ============================================================================

export {
  registerModelProvider,
  clearModelProvider,
  getModelProvider,
  hasModelProvider,
} from "./provider/model-provider-registry.js";

export {
  createDirectModelProvider,
  type ModelProviderMode,
  type ModelProviderConnection,
  type ModelProvider,
} from "./provider/model-provider.js";

export { createRemoteProvider, REMOTE_PROVIDER_API_KEY } from "./provider/remote-model-provider.js";

export {
  resolveModelConfigFromProvider,
  type ResolvedModelConfigFromProvider,
} from "./provider/resolve-from-provider.js";

// ============================================================================
// Runtime — agent manager (host bootstrap; Session-only UI must not import ManagedAgent)
// ============================================================================

export { CodentAgent } from "./runtime/codent-agent.js";
export type { ModelCatalogRead } from "./runtime/codent-agent.js";
export type { CodentAgentOptions } from "./runtime/codent-agent.js";

export { agentManager, AgentManager } from "./managers/agent-manager.js";
export type { AgentEvent, AgentEventListener, AgentEventType, RunAgentStreamInput } from "./managers/agent-manager.js";
export type {
  AgentEventPayloadMap,
  AgentEventPayload,
  EmptyAgentEventPayload,
} from "./runtime-types/agent-event-payloads.js";
export { ManagedAgent, type ManagedAgentConfig, type AgentMode } from "./managers/managed-agent.js";
export { isActiveStatus } from "./runtime-types/agent-status.js";
export type { AgentStatus } from "./runtime-types/agent-status.js";
export type { QueuedMessageContent, QueuedMessagesSnapshot } from "./managers/controllers/agent-chat-controller.js";
export type { PlanModePhase, PlanModeState, BeginPlanExecutionResult } from "./agent/plan/plan-mode-controller.js";
// The footer label is a pure projection of the plan phase (+ todo progress), and the TUI is not its
// only possible consumer: keeping the one definition in core is what stops a host copy drifting from
// the phase machine it describes (the app carried a byte-identical copy that only its tests missed).
export {
  formatPlanModeFooterLabel,
  todoProgressFromItems,
  type PlanTodoProgress,
} from "./agent/plan/plan-footer-label.js";
export type { QueueMode } from "./agent/queue/pending-message-queue.js";

// ============================================================================
// Serializable agent state types (Session-safe)
// ============================================================================

export type { TokenUsage } from "./agent/compaction";
export type { LogEntry, LogCategory, LogLevel } from "./agent/agent-log";
export { installAgentLogProcessGuards } from "./agent/agent-log";
export type { TodoItem, TodoStatus, TodoPriority } from "./agent/todo";
export {
  BUILTIN_COMMAND_CATALOG,
  findBuiltinCommand,
  listAdvertisableCommands,
  type BuiltinCommandInfo,
  type BuiltinCommandScope,
} from "./agent/commands/catalog.js";
export type { SessionMeta, SessionData, ResumeResult, ToolApprovalRecord } from "./agent/persistence";
// A host that supplies MCP servers per session (`AgentSessionCreateOptions.mcpServers`) must be
// able to NAME the config it passes, so the union is public even though the manager is not.
export type { McpServerConfig, McpServerConfigStdio, McpServerConfigHttp } from "./agent/mcp";
export type { McpConfigSourceKind, McpServerStatus } from "./runtime-types/mcp-status.js";
export type { SessionJobSummary, SessionJobsSnapshot } from "./runtime-types/session-payloads.js";
export type { UsageRecord, UsageRecordInput } from "./agent/usage";
export type { DailyUsageBucket, ModelUsageTotal, UsageHistoryResult } from "./agent/usage";

// ============================================================================
// Agent Session API (host-facing transport-agnostic surface)
// ============================================================================

export {
  AGENT_SESSION_CHANNELS,
  DEFAULT_AGENT_SESSION_CHANNELS,
  createLocalAgentSession,
  createLocalAgentSessionHost,
  sessionForSubagent,
  type AgentSession,
  type AgentSessionChannel,
  type AgentSessionCommand,
  type AgentSessionBuiltins,
  type AgentSessionCommandResult,
  type AgentSessionCommandResultData,
  type AgentSessionCommandResultFor,
  type AgentSessionCommandFailure,
  type AgentSessionListRow,
  type AgentSessionCreateOptions,
  type AgentSessionCreateResult,
  type AgentSessionEvent,
  type AgentSessionExtensionsSummary,
  type AgentSessionHost,
  type AgentSessionListEntry,
  type AgentSessionMcpSummary,
  type AgentSessionMessageContent,
  type AgentSessionSnapshot,
  type AgentSessionSubagentSummary,
  type AgentSessionSubscribeOptions,
  type AgentSessionSubscriber,
  type CreateLocalAgentSessionHostOptions,
  type CreateLocalAgentSessionOptions,
  type DiskSessionId,
  type LocalAgentSessionHostManager,
  type LocalAgentSessionManager,
} from "./agent-session";

/**
 * `isContextUIMessage` answers "is this row a synthetic `<ctx kind=…>` context block?" — persisted
 * for the MODEL, never conversation, so any host that renders a transcript to a human must hide it.
 * Exported as the ONE definition of that question (the app's transcript and ACP's `session/load`
 * replay both need it, and neither should re-spell the shell).
 */
export { CONTEXT_OPEN_PREFIX, isContextUIMessage } from "./agent/turn-context";
/**
 * Media helpers for hosts that must put bytes on their own wire: a `media://`-era session stores
 * `source.value` as a data URL after hydration, and a protocol like ACP wants raw base64. Parsing a
 * data URL is one of the shared single-definition helpers, so it is exported rather than re-spelled.
 */
export { buildDataUrl, extractBase64Content } from "./agent/media/media-store.js";
/**
 * `isCompactionSummaryUIMessage` answers the same question for the OTHER synthetic row: the
 * `[CONVERSATION SUMMARY]` message a compaction appends. It is model context, not conversation —
 * a transcript must not render it as if the user had typed it (which is what ACP's `session/load`
 * replay did), and the ACP compaction row wants the body without the markers.
 * Exported so the app and the ACP host share ONE definition of that question instead of each
 * keeping a copy of the markers and predicates (the app had a full copy, marked "must stay in sync").
 */
export {
  CONVERSATION_SUMMARY_END,
  CONVERSATION_SUMMARY_START,
  extractCompactionSummaryBody,
  formatCompactionSummaryContent,
  hasOuterEndMarker,
  isCompactionSummaryModelMessage,
  isCompactionSummaryText,
  isCompactionSummaryUIMessage,
  isLatestDurableMessageCompactionSummary,
} from "./agent/compaction";
export { isUserVisibleTaskRow, type SubagentRowLike } from "./agent-session/subagent-row.js";
export { resolvePendingInteractions } from "./agent/stream/tool-phase-utils.js";
export { isBuiltinToolName } from "./agent/tools/catalog/tool-names.js";
export type { AgentL1State } from "./managers/managed-agent.js";
export type { AgentRetryState, AgentRetryStrategy } from "./runtime-types/agent-retry.js";
export type {
  AgentIterationState,
  PendingApprovalInteraction,
  PendingAskUserInteraction,
  PendingInteractionEntry,
  SessionInteractionsSnapshot,
} from "./runtime-types/session-payloads.js";
export type { TaskRunPhase } from "./agent/subagent/task-run-state.js";
export type { UsageChangeSnapshot, UsageSnapshot } from "./managers/telemetry/usage-tracker.js";

// ============================================================================
// Summary streams (task / compact)
// ============================================================================

export {
  AGENT_STREAM_SNAPSHOT_LINE_CAP,
  applyAppendToAgentStreamWindow,
  applyAgentStreamAppend,
  agentStreamWindowFromSnapshot,
  emptyAgentStreamDisplayWindow,
  emptyAgentStreamLineBuffer,
  renderAgentStreamDisplayRows,
  agentStreamKey,
  type AgentStreamDisplayWindow,
  type AgentStreamLineBuffer,
  type AgentStreamChannel,
  type AgentStreamEvent,
  type AgentStreamListener,
  type AgentStreamResetInput,
  type AgentStreamSnapshot,
  type AgentStreamSource,
  type AgentStreamStatus,
} from "./agent/stream-hub";

// ============================================================================
// Models & agent bootstrap helpers
// ============================================================================

export {
  DEFAULT_BASE_URLS,
  DEFAULT_LOCAL_OPENAI_BASE_URL,
  loadModelEntries,
  loadModels,
  loadModelsConfigFromFile,
  MODELS_CONFIG_DIR,
  MODELS_CONFIG_FILE,
  normalizeGlobalToolConfig,
  normalizeRawGlobalToolConfig,
  parseModelStyle,
  parseModelsConfig,
  readModelsConfigFile,
  registerModelProviderForEntry,
  resolveModelConfig,
  resolveModelConnection,
  resolveModelConnectionFromEnv,
  resolveModelInfoFromModelsDev,
  resolveModelsConfig,
  resolveModelsConfigFromProvider,
  saveModelsConfig,
  selectModel,
  selectableModelIds,
  writeModelsConfigFile,
} from "./models";

/**
 * Every `ModelCapability` as a runtime value — the single source of truth that
 * `ModelCapability` is derived from. Enumerate this instead of keeping a second list.
 */
export { MODEL_CAPABILITIES } from "./models/types.js";

/** Capability → transformer-context flag name; exhaustively keyed by `ModelCapability`. */
export { MODEL_CAPABILITY_FLAGS } from "./agent/extension/types.js";

export type {
  DirectModelsConfigEntry,
  LoadedModelEntry,
  LoadedModelsState,
  ModelCapability,
  ModelInfo,
  ModelPricing,
  ModelStyle,
  ModelConnection,
  ModelSelection,
  ModelSelectionRequest,
  ModelsConfig,
  ModelsConfigActive,
  ModelsConfigEntry,
  ModelsConfigGlobal,
  ModelsConfigSource,
  ProviderInfo,
  RawModelsConfig,
  ReasoningConfig,
  ReasoningEffort,
  RemoteProviderConfigEntry,
  ResolveModelConfigInput,
  ResolvedModelConfig,
} from "./models";
export { mergeModelsConfigToolConfig, websearchToolConfigFromEnv } from "./agent/tools/tool-config.js";
export type { AgentToolConfig, WebsearchToolConfig } from "./agent/tools/tool-config.js";
export {
  isReasoningEffort,
  offerableReasoningEfforts,
  REASONING_EFFORT_VALUES,
  supportedReasoningEfforts,
} from "./models/types.js";
export {
  parseModeCommand,
  parseModelsCommand,
  type ModeCommandIntent,
  type ModelsCommandIntent,
} from "./agent/commands/arguments.js";
export { decodeModelChoice, encodeModelChoice } from "./agent/commands/arguments.js";
export { resolveSessionRef, type SessionRefCandidate } from "./agent-session/session-reference.js";
export { askUserOutputSchema } from "./agent/tools/builtin/interaction/ask-user-tool.js";
export { buildAskUserOutput, type AskUserAnswerInput } from "./agent/tools/builtin/interaction/ask-user-output.js";
export { buildDefaultSystemPrompt } from "./agent/prompt/default-prompt.js";
export { DEFAULT_AGENT_MAX_ITERATIONS, MAX_AGENT_ITERATIONS } from "./managers/agent-types.js";
export { SUBAGENT_NO_TRUNCATE } from "./agent/subagent";
export { resolveSummarizationBudget } from "./agent/compaction";

// ============================================================================
// UI utilities
// ============================================================================

export { previewEdit, type PreviewEditResult } from "./agent/tools/builtin/fs/edit/preview-edit.js";
export { describeToolPresentations, presentationFromInfo } from "./agent/tools/presentation/describe.js";
export { getBuiltinToolPresentation } from "./agent/tools/presentation/builtin.js";
export { keepsCompactRow } from "./agent/tools/presentation/row-rules.js";
export { computeToolDisplay } from "./agent/tools/presentation/compute-display.js";
export { formatDuration } from "./agent/tools/presentation/format/format.js";
export { normalizeOutputNewlines, splitStreamingLines } from "./agent/tools/presentation/format/lines.js";
export {
  buildLineWindow,
  hiddenLinesIndicator,
  padLatestLines,
  takeLatestLines,
  type LineWindow,
  type LineWindowOptions,
} from "./utils/line-window.js";
// Image → text for the workspace preview pane. Public because the decoding hosts (`@codent/node`)
// and the UI both call it: the host decodes, this decides what the cells look like.
export {
  renderRgbaAsTerminalText,
  TERMINAL_ASCII_RAMP,
  type RgbaImage,
  type TerminalImageOptions,
} from "./utils/image-text.js";
export {
  countToolActivity,
  collectOtherToolNames,
  emptyToolActivityCounts,
  extractActivityLabel,
  extractActivityLabelInfo,
  formatExploredActivitySummary,
  formatToolActivitySummary,
  getToolActivityBucket,
  isErrorToolRow,
  shouldFoldToolRow,
  shouldKeepToolRow,
  summarizeToolActivity,
  type ActivityLabel,
  type ToolActivityBucket,
  type ToolActivityCounts,
} from "./agent/tools/presentation/activity-summary.js";
export {
  getUiToolState,
  isCancelledToolCall,
  isImagePart,
  isPendingToolApproval,
  isToolCallPart,
  isToolExecuting,
  parseToolInput,
  type UiToolState,
} from "./agent/tools/presentation/state.js";
export {
  isAbortError,
  isTimeoutError,
  isCancelledOutputMarker,
  isSyntheticCancelOutput,
} from "./runtime-types/abort.js";
export type {
  ToolActivityCategory,
  ToolPresentation,
  ToolPresentationInfo,
  ToolPresentationResolver,
  ToolDisplayPayload,
  DisplayToolCallPart,
} from "./agent/tools/presentation/types.js";
export {
  DURATION_THRESHOLD_MS,
  LIVE_DURATION_THRESHOLD_MS,
  getDurationMs,
  getInlineSummary,
} from "./agent/tools/presentation/format/inline-summary.js";
export { formatToolArgs, formatToolOutput } from "./agent/tools/presentation/format/output-format.js";
export { formatToolInput } from "./agent/tools/presentation/format/input-format.js";
export { BUILTIN_TOOL_NAMES, type BuiltinToolName } from "./agent/tools/catalog/tool-names.js";
export { BEGIN_SUMMARY_TOOL_NAME } from "./agent/subagent/begin-summary-tool.js";

// ============================================================================
// Tool output types (message formatting)
// ============================================================================

export type {
  EditFileOutput,
  GetCommandOutput,
  GlobOutput,
  GrepOutput,
  KillCommandOutput,
  ListFileOutput,
  RunCommandOutput,
  TodoOutput,
  WriteFileOutput,
} from "./agent/tools/shared/schemas.js";
export type { ReadFileOutput } from "./agent/tools/builtin/fs/read-file-tool.js";
export type { TaskOutput } from "./agent/subagent/task-tool.js";

// ============================================================================
// CoreEnv errors & workspace I/O types (node / server adapters)
// ============================================================================

export { FileError, ExecutionError } from "./env/types";
// Typed rejection of an extension model completion: callers branch on `code`, so the class has to be
// reachable from the public entry (same precedent as the adapter errors above).
export { ExtensionLlmError, type ExtensionLlmErrorCode } from "./agent/extension/extension-llm-error.js";
export type { CoreEnvExecFileOptions } from "./env";
export type { CoreEnvShellInfo } from "./env/types";
export type {
  FileEntry,
  FileStat,
  CommandResult,
  RunCommandOptions,
  CommandJobStatus,
  StartCommandOptions,
  StartCommandHandle,
} from "./env/types";

// ============================================================================
// Extension types (Session-safe). Loaders/runners stay package-private / `dev.ts`.
// ============================================================================

export type {
  ExtensionAPI,
  ExtensionFactory,
  ExtensionContext,
  ExtensionContextSectionProvider,
  ExtensionContextUsage,
  ExtensionLlm,
  ExtensionLlmMessage,
  ExtensionLlmRequest,
  ExtensionLlmResult,
  ExtensionRuntimeAccess,
  ExtensionConfig,
  ExtensionInstance,
  ExtensionRegistrations,
  ExtensionToolDefinition,
  ExtensionCommand,
  ExtensionEventBus,
  ExtensionObserverSurface,
  ExtensionObserverOptions,
  ExtensionEventObserver,
  ExtensionEventVisibility,
  ObservableExtensionEvent,
  ExtensionUI,
  ExtensionZod,
  InterceptableEvent,
  EventInterceptor,
  ExtensionLifecycleEvent,
  ToolBeforeEvent,
  ToolBeforePayload,
  ToolAfterEvent,
  ToolAfterPayload,
  ToolErrorEvent,
  ToolErrorPayload,
  ToolLifecycleEvent,
  BeforeAgentStartEvent,
  BeforeAgentStartPayload,
  SessionStartEvent,
  SessionStartPayload,
  SessionShutdownEvent,
  SessionShutdownPayload,
  ExtensionPromptAppends,
  ExtensionTurnContextSection,
  ExtensionContextProvider,
  TurnContextProvider,
  ExtensionInfo,
  ExtensionNotificationLevel,
  ExtensionRenderNode,
  ExtensionRenderPayload,
  ExtensionUiContext,
  ExtensionUiModel,
  ExtensionUiUsage,
  MessageTransformContext,
  MessageTransformPhase,
  MessageTransformer,
  ModelCapabilityFlags,
  MultimodalPartType,
} from "./agent/extension";

/**
 * Every observable extension event, as a runtime value — the single source of
 * truth the `ObservableExtensionEvent` union is derived from. Enumerate this
 * instead of keeping a second list.
 */
export { EXTENSION_EVENT_VISIBILITY, observableExtensionEvents } from "./agent/extension/types.js";

// ============================================================================
// Shared utilities
// ============================================================================

export { generateId } from "./utils/generate-id.js";
export { errorMessage, toError } from "./utils/errors.js";
export { toPosixPath, toPosixPathKey } from "./utils/posix-path.js";
// The runtime data directory (sessions, logs, plans, cache) — hosts need its name to exclude it
// from their own listings/searches, and the name has exactly one definition.
export { AGENT_DATA_DIR } from "./utils/workspace-paths.js";
export type { GenerateIdOptions } from "./utils/generate-id.js";

// ============================================================================
// Network boundary
// ============================================================================

// Bounded body reads are shared with the CoreEnv fetch proxy (a first-party host cannot reach a
// deep path); the SSRF guard stays internal to `webfetch`, the only caller whose URL is model input.
export {
  DEFAULT_MAX_BODY_BYTES,
  readBodyBounded,
  readBodyTextBounded,
} from "./agent/tools/builtin/web/fetch/bounded-body.js";
