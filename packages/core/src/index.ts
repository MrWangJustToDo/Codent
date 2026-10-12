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
  type McpStdioTransportConfig,
  type McpProcessHandle,
} from "./env";

// ============================================================================
// LSP transport (optional, Node.js only — feature-detected by LSP extension)
// ============================================================================

export type { LspServerConfig, LspConnection, LspMessage } from "./env/lsp";
export type { LspConnectionFactory } from "./env";
export {
  LspManager,
  type LspServerConfigRecord,
  type ServerStatus,
  type LspClient,
  type LspManagerCallbacks,
} from "./agent/lsp/lsp-manager.js";

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
export type { CodentAgentOptions, CodentAgentDefaults } from "./runtime/codent-agent.js";

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
  type AgentSessionCommandResult,
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
  type LocalAgentSessionHostManager,
  type LocalAgentSessionManager,
} from "./agent-session";
export { isUserVisibleTaskRow, type SubagentRowLike } from "./agent-session/subagent-row.js";
export type { AgentL1State } from "./managers/managed-agent.js";
export type { AgentRetryState, AgentRetryStrategy } from "./runtime-types/agent-retry.js";
export type {
  AgentIterationState,
  PendingApprovalInteraction,
  PendingAskUserInteraction,
  SessionInteractionsSnapshot,
} from "./runtime-types/session-payloads.js";
export { TaskRunState, type TaskRunPhase } from "./agent/subagent/task-run-state.js";
export type { UsageChangeSnapshot, UsageSnapshot } from "./managers/telemetry/usage-tracker.js";

// ============================================================================
// Summary streams (task / compact)
// ============================================================================

export {
  SUMMARY_STREAM_SNAPSHOT_LINE_CAP,
  SummaryStreamHub,
  applyAppendToDisplayWindow,
  applySummaryStreamAppend,
  displayWindowFromSnapshot,
  emptySummaryDisplayWindow,
  emptySummaryLineBuffer,
  renderSummaryDisplayRows,
  summaryStreamKey,
  compactSummaryStreamId,
  type SummaryDisplayWindow,
  type SummaryLineBuffer,
  type SummaryStreamEvent,
  type SummaryStreamListener,
  type SummaryStreamResetInput,
  type SummaryStreamSnapshot,
  type SummaryStreamSource,
  type SummaryStreamStatus,
} from "./agent/summary-stream";

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
  resolveModelInfoFromModelsDev,
  resolveModelsConfig,
  resolveModelsConfigFromProvider,
  saveModelsConfig,
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
  ResolvedModelConfig,
} from "./models";
export type { AgentToolConfig, WebsearchToolConfig } from "./agent/tools/tool-config.js";
export { buildDefaultSystemPrompt } from "./agent/prompt/default-prompt.js";
export { DEFAULT_AGENT_MAX_ITERATIONS } from "./managers/agent-types.js";
export { SUBAGENT_NO_TRUNCATE } from "./agent/subagent";
export { resolveSummarizationBudget } from "./agent/compaction";

// ============================================================================
// UI utilities
// ============================================================================

export { previewEdit, type PreviewEditResult } from "./agent/tools/util/preview-edit.js";
export {
  declareToolPresentation,
  registerToolPresentation,
  getToolPresentation,
  describeToolPresentations,
  clearToolPresentation,
} from "./agent/tools/presentation/registry.js";
export { forgetToolPresentation, hydrateToolPresentations } from "./agent/tools/presentation/registry.js";
export { keepsCompactRow } from "./agent/tools/presentation/row-rules.js";
export { computeToolDisplay } from "./agent/tools/presentation/compute-display.js";
export { formatDuration } from "./agent/tools/presentation/format.js";
export { normalizeOutputNewlines, splitStreamingLines } from "./agent/tools/presentation/lines.js";
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
} from "./agent/tools/presentation/tool-state.js";
export { isAbortError, isCancelledOutputMarker, isSyntheticCancelOutput } from "./runtime-types/abort.js";
export type {
  ToolActivityCategory,
  ToolPresentation,
  ToolPresentationInfo,
  ToolDisplayPayload,
  DisplayToolCallPart,
} from "./agent/tools/presentation/types.js";
export {
  DURATION_THRESHOLD_MS,
  LIVE_DURATION_THRESHOLD_MS,
  getCompactOutput,
  getDurationMs,
  getInlineSummary,
} from "./agent/tools/presentation/inline-summary.js";
export { formatToolArgs, formatToolOutput } from "./agent/tools/presentation/output-format.js";
export { formatToolInput } from "./agent/tools/presentation/input-format.js";
export { BUILTIN_TOOL_NAMES, type BuiltinToolName } from "./agent/tools/tool-names.js";
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
} from "./agent/tools/util/types.js";
export type { ReadFileOutput } from "./agent/tools/read-file-tool.js";
export type { TaskOutput } from "./agent/subagent/task-tool.js";

// ============================================================================
// CoreEnv errors & workspace I/O types (node / server adapters)
// ============================================================================

export { FileError, ExecutionError } from "./env/types";
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
  ExtensionConfig,
  ExtensionInstance,
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
  BeforeAgentStartEvent,
  BeforeAgentStartPayload,
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
export { toPosixPath, toPosixPathKey } from "./utils/posix-path.js";
export type { GenerateIdOptions } from "./utils/generate-id.js";
export { destroyAllCommandJobs } from "./agent/tools/util/command-job-registry.js";
