/**
 * Internal validation exports — agent domain modules.
 * Aggregated by `dev.ts`; not part of the public API.
 */

export {
  areAllUIMessagesStable,
  computeSessionSyncSnapshot,
  createSessionSyncTracker,
  fingerprintUIMessage,
  isUIMessageStable,
  shouldPersistUIMessages,
} from "../agent/persistence/session-sync-tracker.js";
export type { SessionSaveReason, SessionSyncSnapshot } from "../agent/persistence/session-sync-tracker.js";
export { AgentLog, MAX_PENDING_LOG_ENTRIES } from "../agent/agent-log/agent-log.js";
export { logEntrySchema, logCategorySchema } from "../agent/log/schemas.js";
export { AgentUIChannel } from "../agent/ui/ui-channel.js";
export {
  findToolCallPart,
  shouldSuppressReplayedToolChunk,
} from "../agent/stream/suppress-replayed-tool-chunks.js";
export { shouldSuppressStaleTextChunk } from "../agent/stream/suppress-stale-text-chunks.js";
export { shouldSuppressMessagesSnapshot } from "../agent/stream/suppress-messages-snapshot.js";
export { PendingMessageQueue } from "../agent/queue/pending-message-queue.js";
export type { QueueMode } from "../agent/queue/pending-message-queue.js";
export { SessionStore } from "../agent/persistence/session-store.js";
export { autoCompact } from "../agent/compaction/auto-compact.js";
export { applyCompactionResult } from "../agent/compaction/apply-compaction-result.js";
export {
  CONTEXT_OVERFLOW_CODES,
  isPromptTooLongError,
  reactiveCompact,
} from "../agent/compaction/reactive-compact.js";
export {
  attachRunErrorCode,
  attachRunErrorRetryAfterMs,
  extractRunErrorMessage,
  throwOnRunError,
  type RunErrorSignals,
} from "../agent/stream/stream-errors.js";
export { AgentConfigSchema } from "../managers/agent-types.js";
export { formatReadFileToolResult } from "../agent/tools/builtin/fs/read/format-result.js";
// Code-mode's `execute_typescript` projection: a script that returns a media result from an
// `external_*` binding must reach the model as multimodal parts, not base64 text.
export { projectCodeModeModelOutput } from "../agent/code-mode/model-output.js";
export {
  estimateImageInputTokens,
  estimateImageTokensFromDimensions,
  tryReadImageDimensions,
} from "../models/estimate-image-tokens.js";
export {
  applyResolvedEdit,
  expandMatchVariants,
  formatNotFoundHint,
  resolveEditMatch,
  START_LINE_TOLERANCE,
  unescapeCommonEscapes,
} from "../agent/tools/builtin/fs/edit/find-edit-match.js";
export { BEGIN_SUMMARY_TOOL_NAME } from "../agent/subagent/begin-summary-tool.js";
export { buildExploreSystemPrompt, SUBAGENT_EXPLORE_SYSTEM_PROMPT } from "../agent/subagent/explore-prompt.js";
export {
  mcpContentHasMultimodal,
  mcpContentToTanstack,
  resolveMcpModelOutput,
  resolveMcpToolExecuteResult,
  wrapMcpToolForMultimodalContent,
} from "../agent/mcp/prefer-multimodal-content.js";
export {
  extractAssistantText,
  getSummaryStreamText,
  resolveTaskRunPhase,
  shouldStreamTaskSummary,
} from "../agent/stream/extract-assistant-text.js";
export { countSubagentIterations, deriveSubagentRunStats, hasBeginSummaryCall } from "../agent/subagent/run-stats.js";
// The task tool itself, so a validation can assert what the model-facing projection actually
// contains (the iteration numbers must not be in it).
export { createTaskTool, taskOutputSchema } from "../agent/subagent/task-tool.js";
export { subagentResultToTaskOutput } from "../agent/subagent/run-subagent.js";
// The three tools that settle their own abort, so the cancellation contract can be driven
// through their real factories (their `toModelOutput` must tell the model, not only the UI).
export {
  createRunCommandTool,
  buildTimedOutCommandResult,
  commandTimeoutNotice,
  resolveDefaultCommandTimeout,
} from "../agent/tools/builtin/shell/run-command-tool.js";
export { createWebfetchTool } from "../agent/tools/builtin/web/fetch/tool.js";
export { createWebsearchTool } from "../agent/tools/builtin/web/search/tool.js";
export { truncateSummary } from "../agent/subagent/subagent-output.js";
export {
  applySubagentFailureNotice,
  applySubagentStopNotice,
  resolveSubagentStopReason,
  subagentStopNotice,
  SUBAGENT_ABORT_REASONS,
  SUBAGENT_ABORTED_NOTICE,
  SUBAGENT_CANCELLED_NOTICE,
  SUBAGENT_FAILURE_NOTICE_PREFIX,
  SUBAGENT_PARENT_RUN_NOTICE,
  SUBAGENT_PARENT_STOP_NOTICE,
  SUBAGENT_RUN_RESTART_REASONS,
  SUBAGENT_STOP_NOTICES,
  SUBAGENT_STOP_REASONS,
} from "../agent/subagent/subagent-stop-reason.js";
export {
  logSubagentLifecycle,
  subagentLifecycleLogLine,
} from "../agent/log/subagent-log-mirror.js";
export type {
  SubagentLifecyclePhase,
  SubagentLogDetails,
} from "../agent/log/subagent-log-mirror.js";
export {
  buildProgressSummaryPrompt,
  isProgressSummaryEligible,
  PROGRESS_SUMMARY_MARKER,
  summarizeProgress,
} from "../agent/subagent/progress-summary.js";
export { AGENT_PROFILE_IDS } from "../runtime-types/agent-profile.js";
export { runManagedSpan } from "../agent/run/managed-span.js";
export {
  discardRegisteredPrefork,
  getTaskPreforkCoordinator,
  MAX_ACTIVE_TASK_PREFORKS,
  peekTaskPreforkCoordinator,
  resolveMaxConcurrentTasks,
  TaskPreforkCoordinator,
} from "../agent/subagent/task-prefork.js";
// `createTaskPreforkMiddleware` and `RunCoordinator` (the middleware factory, and the run's abort
// surface the pre-fork registers its controller on) already reach validators through the
// `dev-managers` re-export — do not add a second export of either here.
export {
  beginTaskRun,
  clearTaskRuns,
  enterTaskLimitPhase,
  enterTaskPhase,
  enterTaskSummaryPhase,
  getTaskRunState,
  readTaskRunPhase,
  TaskRunState,
} from "../agent/subagent/task-run-state.js";
export {
  consumeAgentStream,
  ensureUIChannel,
  runAgentOnce,
  type RunAgentOnceOutcome,
} from "../agent/run/run-agent-skeleton.js";
export { extractFileOpsFromMessages, formatFileOperations } from "../agent/compaction/file-ops-tracker.js";
export { buildDefaultSystemPrompt } from "../agent/prompt/default-prompt.js";
export { AgentRuntime } from "../runtime/agent-runtime.js";
export { CodentAgent } from "../runtime/codent-agent.js";
export { createListFileTool } from "../agent/tools/builtin/fs/list-file-tool.js";
export { PR_SUMMARY_SYSTEM_PROMPT, TITLE_SYSTEM_PROMPT } from "../agent-session/session-summary-prompt.js";
export { assertNotCompactionSummaryInput, applyToolCompact, ToolCompactCache } from "../agent/compaction";
export {
  buildCompactionPrompt,
  buildSegmentedConversationText,
  buildSummarizationUserPrompt,
  COMPACTION_PROMPT,
  COMPACTION_SYSTEM_PROMPT,
  deriveKeepRecentTokens,
  findCutPointByBudget,
  createCompactionSummaryUIMessage,
  createCompactionConfig,
  findLatestSummaryIndex,
  formatCompactionSummaryContent,
  extractCompactionSummaryBody,
  getModelVisibleMessages,
  isCompactionSummaryModelMessage,
  isCompactionSummaryText,
  isCompactionSummaryUIMessage,
  isLatestDurableMessageCompactionSummary,
  keepPolicyProjectionOptions,
  lastMessageContentLen,
  policyKeyFromOptions,
  resolveAutoCompactTrigger,
  resolveKeepPolicy,
  serializeConversation,
  STILL_IN_CONTEXT_RULES,
  TURN_PREFIX_INSTRUCTION,
  UPDATE_COMPACTION_PROMPT,
  WireProjectionCache,
  wireSourceFingerprint,
} from "../agent/compaction";
export { extractTextFromContent } from "../agent/compaction/message-utils.js";
export {
  createConfiguredProviderManager,
  ProviderManager,
  createTimeoutAbort,
  filterResultsByDomain,
  hashToIndex,
  PROVIDER_KEY_FIELDS,
  PROVIDER_REGISTRY,
  withTimeoutAbort,
} from "../agent/tools/builtin/web/search/index.js";
export { braveProvider } from "../agent/tools/builtin/web/search/providers/brave.js";
export { tavilyProvider } from "../agent/tools/builtin/web/search/providers/tavily.js";
export { parseParallelResults } from "../agent/tools/builtin/web/search/providers/parallel.js";
export { parseExaResults } from "../agent/tools/builtin/web/search/providers/exa.js";
export { parseMcpResponse } from "../agent/tools/builtin/web/search/providers/mcp-client.js";
// models.json global.toolConfig normalization (internal validation exports).
export {
  normalizeGlobalToolConfig,
  normalizeRawGlobalToolConfig,
  parseModelsConfig,
} from "../models/config/models-config.js";
export { resolveSelectedMemoryFilename } from "../agent/memory/memory-retrieval.js";
export { MemoryManager } from "../agent/memory/memory-manager.js";
export { extractMemories, consolidateMemories } from "../agent/memory/memory-extractor.js";
export { findRelevantMemories, formatRelevantMemories } from "../agent/memory/memory-retrieval.js";
export type { RelevantMemory } from "../agent/memory/memory-retrieval.js";
export {
  DEFAULT_SUMMARIZATION_CONTEXT_WINDOW,
  SUMMARY_OUTPUT_CAP,
  measureSerializedTokens,
  resolveSummarizationBudget,
  resolveSummarizationInputBudget,
  splitMessagesByTokenBudget,
} from "../agent/compaction/summarization-budget.js";
export { measureSerializedConversationChars } from "../agent/compaction/serialize-conversation.js";
export { estimateTokens } from "../agent/compaction/token-estimator.js";
export {
  ToolApprovalTable,
  approvalsToResumeMap,
  backfillApprovalsFromUIMessages,
  normalizeSessionApprovals,
} from "../agent/approval/tool-approval-table.js";
export {
  ExtensionLoader,
  ExtensionRunner,
  normalizeExtensionExport,
  isExtensionModuleFile,
  pathToFileUrl,
  DEFAULT_EXTENSION_DIR,
  getDefaultExtensionDirs,
  EXTENSION_EVENT_VISIBILITY,
  observableExtensionEvents,
} from "../agent/extension";
export { buildAutoModePrompt } from "../agent/approval/auto-mode-prompt.js";
export {
  CONTEXT_OPEN_PREFIX,
  CONTEXT_CLOSE,
  hashTurnContextPayload,
  formatContextSectionUserContent,
  isContextText,
  contextAttributesFromText,
  contextKindFromText,
  isContextModelMessage,
  isContextUIMessage,
  syntheticKindFromId,
  extractContextSection,
  hashTurnContextSection,
  findLatestContextSectionsFromWire,
  findLatestTurnContextSectionHashesFromWire,
} from "../agent/turn-context";
export {
  buildCounterReminderSection,
  buildRepeatReminderBody,
  buildTodoReminderContent,
  canonicalizeRepeatArguments,
  DEFAULT_ARGUMENTS_PREVIEW_CHARS,
  DEFAULT_REPEAT_EXCLUDED_TOOLS,
  DEFAULT_REPEAT_THRESHOLDS,
  isGenuineUserMessage,
  previewRepeatArguments,
  readCounterReminderState,
  readRepeatReminderWindowState,
  readTodoReminderWindowState,
  readTrailingRepeatChain,
  REPEAT_REMINDER_KIND,
  resolveRepeatReminder,
  resolveTodoReminder,
} from "../agent/turn-context";
export {
  INSTRUCTION_FILENAMES,
  INSTRUCTION_MAX_BYTES,
  diffInstructionStates,
  formatInstructionContextSection,
  instructionStateChanged,
  loadLatestInstructionContent,
  readInstructionContextState,
} from "../agent/turn-context";
export { TURN_CONTEXT_KINDS } from "../agent/turn-context";
export { collectRunCommandToolCallIds, formatBackgroundJobsSection } from "../agent/turn-context";
export type { BackgroundJobContextRow } from "../agent/turn-context";
export type { TurnContextKind } from "../agent/turn-context";
export type { InstructionContextState, InstructionFile, LoadedInstructionContent } from "../agent/turn-context";
export {
  SESSION_RETRIEVAL_KIND,
  formatSessionRetrievalSection,
  renderStaticRetrievalBody,
  hasSessionHistory,
} from "../agent/turn-context";
export {
  MAX_INSTRUCTION_IMPORT_DEPTH,
  expandInstructionImports,
  findCodeRegions,
  overrideFilenameFor,
  resolveOverrideInstruction,
  resolvePrimaryInstruction,
  truncateToBudget,
} from "../agent/prompt/instruction-files.js";
export type {
  InstructionDiscoveryOptions,
  ResolvedInstructionFile,
} from "../agent/prompt/instruction-files.js";
export { loadAgentDoc, formatAgentDocResult } from "../agent/prompt/agent-doc-loader.js";
export type { AgentDocLoadResult, AgentDocLoaderConfig } from "../agent/prompt/agent-doc-loader.js";
export { toolsToArray } from "../agent/tools/catalog/tool-set.js";
export { defineServerTool, getToolMetadata } from "../agent/tools/runtime/define-tool.js";
export { createSessionSearchTool, sessionSearchOutputSchema } from "../agent/tools/builtin/session/search-tool.js";
export { createSessionReadTool, sessionReadOutputSchema } from "../agent/tools/builtin/session/read-tool.js";
export {
  DEFAULT_SEARCH_ROLES,
  MAX_MATCHES_COLLECTED,
  listSessionIds,
  makeSnippet,
  messageText,
  readSessionMessages,
  readSessionMessageWindow,
  searchHistory,
  sessionExists,
} from "../agent/tools/builtin/session/reader.js";
export { SUBAGENT_ALLOWED_KINDS } from "../managers/middleware/turn-context-middleware.js";
export { injectSyntheticMessages, syntheticMessageId } from "../agent/turn-context/synthetic-injection.js";
export { AgentRunner } from "../agent/runner/agent-runner.js";
export { assertAsyncIterable, formatAgentStreamError } from "../agent/stream/assert-async-iterable.js";
export {
  applyToolDenialReason,
  buildToolDenialResultContent,
  DEFAULT_TOOL_DENIAL_MESSAGE,
} from "../agent/stream/apply-tool-denial-reason.js";
export {
  findLastMeaningfulAssistant,
  isEmptyAssistantShell,
  stripEmptyAssistantShells,
} from "../agent/stream/empty-assistant-shell.js";
export {
  EMPTY_MODEL_STREAM_MESSAGE,
  assistantProgressSignature,
  didStreamProduceModelOutput,
  shouldFlagEmptyModelStream,
} from "../agent/stream/empty-model-stream.js";
export {
  TOOL_CANCELLED_MESSAGE,
  INTERRUPTED_RUN_MESSAGE,
  cancelIncompleteToolCalls,
  cancelInFlightToolCalls,
  settleToolCalls,
  settleInterruptedToolCalls,
  hasCancellableIncompleteToolCalls,
  hasInFlightToolCalls,
  hasValidToolArguments,
  isCancellableIncompleteToolCall,
  isInFlightToolCall,
} from "../agent/stream/incomplete-tool-calls.js";
export {
  MULTIMODAL_OMITTED_PLACEHOLDER,
  MULTIMODAL_PART_CAPABILITY,
  chatMessagesHaveMultimodal,
  isMultimodalUnsupportedError,
  sanitizeMessagesForCapabilities,
  stripMultimodalFromChatMessages,
  trySanitizeForMultimodalRetry,
  unsupportedMultimodalPartTypes,
} from "../models/adapter/capability-message-utils.js";
export type { CapabilityProbe, MultimodalPartType } from "../models/adapter/capability-message-utils.js";
export {
  hasDeferredToolExecution,
  hasApprovedToolsPendingExecution,
  hasApprovalRespondedToolsPendingExecution,
  hasPendingRunContinuation,
  needsAgentResponseAfterTools,
  needsToolPhaseContinue,
  shouldContinueAgentPump,
  isToolContinuationPrepare,
  countPendingToolApprovals,
  collectPendingApprovals,
  collectPendingAskUser,
} from "../agent/stream/tool-phase-utils.js";
export { isStaleActiveRunStatus, shouldDeferMidRunQueue } from "../agent/queue/defer-mid-run-queue.js";
export { getReadOnlyTanStackToolNames } from "../agent/tools/runtime/tool-sets.js";
export { BUILTIN_TOOL_NAMES, type BuiltinToolName } from "../agent/tools/catalog/tool-names.js";
export {
  AGENT_STREAM_SNAPSHOT_LINE_CAP,
  AgentStreamHub,
  applyAppendToAgentStreamWindow,
  applyAgentStreamAppend,
  agentStreamWindowFromSnapshot,
  emptyAgentStreamDisplayWindow,
  emptyAgentStreamLineBuffer,
  renderAgentStreamDisplayRows,
  agentStreamKey,
} from "../agent/stream-hub";
export { createJobsExtension, summarizeJobs } from "../agent/jobs/extension.js";
export { CommandJobRegistry } from "../agent/tools/builtin/shell/jobs/registry.js";
export type {
  CommandJobChangeListener,
  CommandJobRecord,
  CommandJobPollResult,
  CommandJobSummary,
} from "../agent/tools/builtin/shell/jobs/registry.js";
export {
  COMMAND_JOB_LOG_DIR,
  MAX_JOB_LOG_AGE_MS,
  sweepStaleJobLogs,
} from "../agent/tools/builtin/shell/jobs/output-log.js";
export {
  CACHE_THRESHOLD,
  TOOL_OUTPUT_CACHE_DIR,
  TOOL_OUTPUT_MAX_AGE_MS,
  cacheToolOutput,
  cleanupOrphanedToolCache,
  maybeCacheOutput,
  resetToolOutputSweepForTesting,
  sweepStaleToolOutput,
} from "../agent/tools/shared/cache/tool-output-cache.js";
export {
  PlanModeController,
  cleanStepText,
  extractDoneSteps,
  extractPlan,
  getPlanModeToolExcludeSet,
  getPlanModeToolBlockReason,
  isMcpToolName,
  isPlanModeForbiddenTool,
  isWorkspaceEditingTool,
  PLAN_AUTHORING_TOOL_NAMES,
  PLAN_COMPLETION_TOOL_NAMES,
  PLAN_MODE_EXCLUDED_NON_EDIT_TOOL_NAMES,
  PLAN_STORE_DIR,
  PLAN_TODO_TITLE,
  formatPlanModeFooterLabel,
  todoProgressFromItems,
  formatStructuredPlanMarkdown,
  formatPlanSummary,
  extractGoalFromPlanMarkdown,
  slugifyPlanName,
  planFilePath,
  stepsFromTexts,
  stripLeadingStepNumber,
  buildModeInactivePrompt,
  buildPlanModePrompt,
  buildPlanModePlanningPrompt,
  buildPlanModeReadyPrompt,
  buildPlanModeRetroPrompt,
  gateCompletePlanVerification,
  isUsableVerification,
  parseVerificationItemsFromPlanMarkdown,
  parseVerificationItemsFromText,
} from "../agent/plan";
export type {
  BeginPlanExecutionResult,
  ApplyPlanResult,
  PlanModePhase,
  PlanModeState,
  PlanStep,
  ExtractedPlan,
  StructuredPlanInput,
  VerificationResultItem,
} from "../agent/plan";
export { TodoManager } from "../agent/todo";
export { createTodoTool } from "../agent/todo/todo-tool.js";
export { extractBase64Content, buildDataUrl, sha256Stable } from "../agent/media/media-store.js";
export { MediaStore } from "../agent/media/media-store.js";
export type { MediaRef } from "../agent/media/types.js";
export { MEDIA_DIR, mimeToExtension, parseMediaRefPath, buildMediaRefPath } from "../agent/media/types.js";
export { dehydrateUIMessages, hydrateUIMessages } from "../agent/media/media-utils.js";
export {
  repairMessagesSnapshotChunk,
  repairStringifiedMultimodalUIMessages,
  parseStringifiedMultimodalContent,
  isStringifiedMultimodalContentParts,
} from "../agent/media/repair-stringified-multimodal.js";
export { createLspExtension } from "../agent/lsp";
export { DEFAULT_DISABLED_LSP_TOOLS } from "../agent/lsp";
export type { LspExtensionConfig } from "../agent/lsp";
export { EXT_TO_LANGUAGE, getLanguageIdFromPath } from "../agent/lsp/language-map.js";
export {
  LspManager,
  type LspServerConfigRecord,
  type ServerStatus,
  type LspClient,
  type LspManagerCallbacks,
} from "../agent/lsp/lsp-manager.js";
export { findLombokJar } from "../agent/lsp/lombok.js";
export { applyDiagnosticsToToolAfterPayload } from "../agent/lsp/shared/apply-tool-diagnostics.js";
export { extractToolPath, parseToolCallArgs } from "../agent/lsp/shared/parse-tool-args.js";
export { insertDot, shouldSyntheticTrigger, syntheticDotLocks } from "../agent/lsp/shared/synthetic-dot.js";
export {
  DIAGNOSTIC_SETTLE_DELAY_MS,
  RESTART_INITIAL_BACKOFF_MS,
  SYNTHETIC_DOT_SETTLE_DELAY_MS,
} from "../agent/lsp/shared/timing.js";
export { lspTextToModelOutput } from "../agent/lsp/shared/tool-output.js";
export { truncateHead } from "../agent/lsp/tools/tool-shared.js";
export { createMemoryExtension, type MemoryExtensionConfig, type CreateMemoryExtensionOptions } from "../agent/memory";
export {
  SkillRegistry,
  SkillLoader,
  BUILTIN_SKILLS,
  skillSchema,
  createSkillsExtension,
  type SkillSource,
  type SkillDirectory,
  type SkillsExtensionConfig,
  type CreateSkillsExtensionOptions,
} from "../agent/skills";
export { createMcpExtension, type McpExtensionConfig, type CreateMcpExtensionOptions } from "../agent/mcp";
export { mcpConfigFromServers, type McpConfigSourceKind } from "../agent/mcp/options.js";
// The owner every MCP registration carries, so a validator can assert the removal matches.
export { MCP_TOOL_OWNER, McpManager } from "../agent/mcp/manager.js";
