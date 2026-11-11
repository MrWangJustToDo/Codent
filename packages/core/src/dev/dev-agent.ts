/**
 * Internal validation exports — agent domain modules.
 * Aggregated by `dev.ts`; not part of the public API.
 */

export {
  computeSessionSyncSnapshot,
  createSessionSyncTracker,
  fingerprintUIMessage,
  isUIMessageStable,
  shouldPersistUIMessages,
} from "../agent/persistence/session-sync-tracker.js";
export { AgentLog, MAX_PENDING_LOG_ENTRIES } from "../agent/agent-log/agent-log.js";
export { logEntrySchema, logCategorySchema } from "../agent/log/schemas.js";
export { AgentUIChannel } from "../agent/ui/ui-channel.js";
export { findToolCallPart, shouldSuppressReplayedToolChunk } from "../agent/stream/suppress-replayed-tool-chunks.js";
export { shouldSuppressStaleTextChunk } from "../agent/stream/suppress-stale-text-chunks.js";
export { shouldSuppressMessagesSnapshot } from "../agent/stream/suppress-messages-snapshot.js";
export { PendingMessageQueue } from "../agent/queue/pending-message-queue.js";
export { SessionStore } from "../agent/persistence/session-store.js";
export { autoCompact } from "../agent/compaction/auto-compact.js";
export { applyCompactionResult, findOrphanedToolCut } from "../agent/compaction/apply-compaction-result.js";
export { compactionAbortError, isCompactionCancel } from "../agent/compaction/abort-classification.js";
export { CONTEXT_OVERFLOW_CODES, isPromptTooLongError, reactiveCompact } from "../agent/compaction/reactive-compact.js";
export {
  attachRunErrorCode,
  attachRunErrorRetryAfterMs,
  extractRunErrorMessage,
  throwOnRunError,
} from "../agent/stream/stream-errors.js";
export { AgentConfigSchema } from "../managers/agent-config.js";
export { DEFAULT_AGENT_MAX_ITERATIONS, MAX_AGENT_ITERATIONS } from "../runtime-types/agent-limits.js";
export { mergeModelsConfigToolConfig, websearchToolConfigFromEnv } from "../agent/tools/tool-config.js";
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
  applyEdits,
  applyEditsToText,
  detectLineEnding,
  expandMatchVariants,
  findEditMatch,
  formatNotFoundHint,
  splitBom,
  toLF,
  unescapeCommonEscapes,
} from "../agent/tools/builtin/fs/edit/find-edit-match.js";
export { BEGIN_SUMMARY_TOOL_NAME } from "../agent/subagent/begin-summary-tool.js";
export { buildExploreSystemPrompt } from "../agent/subagent/explore-prompt.js";
export {
  mcpContentHasMultimodal,
  mcpContentToTanstack,
  resolveMcpModelOutput,
  resolveMcpToolExecuteResult,
} from "../agent/mcp/prefer-multimodal-content.js";
export { extractAssistantText } from "../agent/stream/extract-assistant-text.js";
export { countSubagentIterations, deriveSubagentRunStats, hasBeginSummaryCall } from "../agent/subagent/run-stats.js";
// The task tool itself, so a validation can assert what the model-facing projection actually
// contains (the iteration numbers must not be in it).
export { createTaskTool, taskOutputSchema } from "../agent/subagent/task-tool.js";
export { subagentResultToTaskOutput } from "../agent/subagent/run-subagent.js";
// The three tools that settle their own abort, so the cancellation contract can be driven
// through their real factories (their `toModelOutput` must tell the model, not only the UI).
export {
  cancelInterruptedBackgroundCommands,
  runningBackgroundCommandLogPaths,
  createRunCommandTool,
  buildTimedOutCommandResult,
  commandTimeoutNotice,
  resolveDefaultCommandTimeout,
} from "../agent/tools/builtin/shell/run-command-tool.js";
export { createWebfetchTool } from "../agent/tools/builtin/web/fetch/tool.js";
export { createWebsearchTool } from "../agent/tools/builtin/web/search/tool.js";
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
} from "../agent/subagent/subagent-stop-reason.js";
export {
  buildProgressSummaryPrompt,
  isProgressSummaryEligible,
  PROGRESS_SUMMARY_MARKER,
  summarizeProgress,
} from "../agent/subagent/progress-summary.js";
export { SUBAGENT_NO_TRUNCATE } from "../agent/subagent/types.js";
export { AGENT_PROFILE_IDS } from "../runtime-types/agent-profile.js";
export { runManagedSpan } from "../agent/run/run-span.js";
export {
  MAX_ACTIVE_TASK_PREFORKS,
  resolveMaxConcurrentTasks,
  TaskPreforkCoordinator,
} from "../agent/subagent/task-prefork.js";
export {
  countSubagentRuns,
  discardRegisteredPrefork,
  getTaskPreforkCoordinator,
  peekTaskPreforkCoordinator,
} from "../agent/subagent/subagent-runs.js";
// `createTaskPreforkMiddleware` and `RunCoordinator` (the middleware factory, and the run's abort
// surface the pre-fork registers its controller on) already reach validators through the
// `dev-managers` re-export — do not add a second export of either here.
export {
  beginTaskRun,
  clearTaskRuns,
  enterTaskLimitPhase,
  enterTaskSummaryPhase,
  getTaskRunState,
  readTaskRunPhase,
  readTaskRunSpawnId,
} from "../agent/subagent/subagent-runs.js";
export { TaskRunState } from "../agent/subagent/task-run-state.js";
export { consumeAgentStream, ensureUIChannel, runAgentOnce } from "../agent/run/run-agent-skeleton.js";
export { extractFileOpsFromMessages, formatFileOperations } from "../agent/compaction/file-ops-tracker.js";
export { buildDefaultSystemPrompt } from "../agent/prompt/default-prompt.js";
export { AgentRuntime } from "../runtime/agent-runtime.js";
export { CodentAgent } from "../runtime/codent-agent.js";
export { createListFileTool } from "../agent/tools/builtin/fs/list-file-tool.js";
export { createTreeTool } from "../agent/tools/builtin/fs/tree-tool.js";
export { PR_SUMMARY_SYSTEM_PROMPT, TITLE_SYSTEM_PROMPT } from "../agent/prompt/session-summary-prompts.js";
export { applyToolCompact, ToolCompactCache, toolCompactCacheKey } from "../agent/compaction";
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
export { extractTextFromContent } from "../utils/message-content.js";
export { createConfiguredProviderManager } from "../agent/tools/builtin/web/search/provider-manager.js";
export { ProviderManager, hashToIndex } from "../agent/tools/builtin/web/search/provider.js";
export { filterResultsByDomain } from "../agent/tools/builtin/web/search/domain-filter.js";
export { PROVIDER_KEY_FIELDS } from "../agent/tools/builtin/web/search/key-fields.js";
export { PROVIDER_REGISTRY } from "../agent/tools/builtin/web/search/registry.js";
export { createTimeoutAbort, withTimeoutAbort } from "../agent/tools/shared/abort-timeout.js";
export { braveProvider } from "../agent/tools/builtin/web/search/providers/brave.js";
export { tavilyProvider } from "../agent/tools/builtin/web/search/providers/tavily.js";
export { parseParallelResults } from "../agent/tools/builtin/web/search/providers/parallel.js";
export { parseMcpResponse } from "../agent/tools/builtin/web/search/providers/mcp-client.js";
// models.json global.toolConfig normalization (internal validation exports).
export { normalizeRawGlobalToolConfig, parseModelsConfig } from "../models/config/models-config.js";
export { resolveSelectedMemoryFilename } from "../agent/memory/memory-retrieval.js";
export { MemoryManager } from "../agent/memory/memory-manager.js";
export { extractMemories, consolidateMemories } from "../agent/memory/memory-extractor.js";
export { findRelevantMemories, formatRelevantMemories } from "../agent/memory/memory-retrieval.js";
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
  REMINDER_TAGS,
  formatSectionTag,
  hashTurnContextPayload,
  formatContextSectionUserContent,
  contextAttributesFromText,
  contextKindFromText,
  isContextModelMessage,
  isContextUIMessage,
  isGenuineUserMessage,
  lastGenuineUserText,
  syntheticKindFromId,
  extractContextSection,
  hashTurnContextSection,
  findLatestContextSectionsFromWire,
  findLatestTurnContextSectionHashesFromWire,
} from "../agent/turn-context";
export {
  buildCounterReminderSection,
  findCounterReminder,
  buildRepeatReminderBody,
  buildTodoReminderBody,
  canonicalizeRepeatArguments,
  DEFAULT_REPEAT_THRESHOLDS,
  previewRepeatArguments,
  readRepeatReminderWindowState,
  readTodoReminderWindowState,
  readTrailingRepeatChain,
  resolveRepeatReminder,
  resolveTodoReminder,
} from "../agent/turn-context";
export {
  INSTRUCTION_MAX_BYTES,
  diffInstructionStates,
  formatInstructionContextSection,
  instructionStateChanged,
  loadLatestInstructionContent,
  readInstructionContextState,
} from "../agent/turn-context";
export { TURN_CONTEXT_KINDS } from "../agent/turn-context";
export { captureSessionStaleness } from "../agent/turn-context";
export { collectRunCommandToolCallIds, formatBackgroundJobsSection } from "../agent/turn-context";
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
} from "../agent/prompt/instruction-files.js";
export { loadAgentDoc } from "../agent/prompt/agent-doc-loader.js";
export { toolsToArray } from "../agent/tools/catalog/tool-set.js";
export { defineServerTool, getToolMetadata } from "../agent/tools/runtime/define-tool.js";
export { createSessionSearchTool } from "../agent/tools/builtin/session/search-tool.js";
export { createSessionReadTool } from "../agent/tools/builtin/session/read-tool.js";
export {
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
export { applyToolDenialReason } from "../agent/stream/apply-tool-denial-reason.js";
export {
  findLastMeaningfulAssistant,
  isEmptyAssistantShell,
  stripEmptyAssistantShells,
} from "../agent/stream/empty-assistant-shell.js";
export {
  EMPTY_MODEL_STREAM_MESSAGE,
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
  chatMessagesHaveMultimodal,
  isMultimodalUnsupportedError,
  sanitizeMessagesForCapabilities,
  stripMultimodalFromChatMessages,
  trySanitizeForMultimodalRetry,
  unsupportedMultimodalPartTypes,
} from "../models/adapter/capability-message-utils.js";
export type { CapabilityProbe } from "../models/adapter/capability-message-utils.js";
export {
  hasDeferredToolExecution,
  hasApprovedToolsPendingExecution,
  hasPendingRunContinuation,
  needsAgentResponseAfterTools,
  needsToolPhaseContinue,
  shouldContinueAgentPump,
  isToolContinuationPrepare,
  countPendingToolApprovals,
  collectPendingApprovals,
  collectPendingAskUser,
  collectPendingInteractions,
  firstPendingInteraction,
  resolvePendingInteractions,
} from "../agent/stream/tool-phase-utils.js";
export { shouldDeferMidRunQueue } from "../agent/queue/defer-mid-run-queue.js";
export { BUILTIN_TOOL_NAMES } from "../agent/tools/catalog/tool-names.js";
export {
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
// The background-work trunk: the facade, its two sources, and the task output shapes. Validators
// drive the real objects (`validate:background-task`), so they must be reachable from here rather
// than re-implemented against a replica.
export { BackgroundWorkService } from "../managers/services/background-work-service.js";
export type { BackgroundWorkCompletion } from "../agent/jobs/background-work.js";
export { SESSION_END_CANCELLED_MESSAGE } from "../agent/jobs/background-work.js";
export { SubagentRuns, subagentRuns } from "../agent/subagent/subagent-runs.js";
export {
  failedTaskOutput,
  formatTaskModelText,
  isRunningTaskOutput,
  runningTaskOutput,
} from "../agent/subagent/task-output.js";
export {
  cancelInterruptedBackgroundTasks,
  reconcileSettledTaskParts,
  startBackgroundTask,
} from "../agent/subagent/task-background.js";
export { formatNotifications } from "../managers/middleware/background-middleware.js";
export { CommandJobRegistry } from "../agent/tools/builtin/shell/jobs/registry.js";
export { sweepStaleJobLogs } from "../agent/tools/builtin/shell/jobs/output-log.js";
export { sweepStaleJobRecords } from "../agent/tools/builtin/shell/jobs/store.js";
export {
  COMMAND_JOB_CACHE_DIR,
  MAX_JOB_LOG_AGE_MS,
  MAX_JOB_RECORD_AGE_MS,
  WORKSPACE_CACHE_RETENTION,
  resetWorkspaceCacheSweeps,
  sweepWorkspaceCaches,
} from "../agent/tools/shared/cache/workspace-cache.js";
export { AGENT_LOG_DIR, LOG_MAX_AGE_MS, resetAgentLogSweep, sweepAgentLogs } from "../agent/log/log-retention.js";
export {
  CACHE_THRESHOLD,
  TOOL_OUTPUT_CACHE_DIR,
  TOOL_OUTPUT_MAX_AGE_MS,
  TOOL_OUTPUT_ORPHAN_GRACE_MS,
  cacheToolOutput,
  cleanupOrphanedToolCache,
  maybeCacheOutput,
  resetToolOutputSweepForTesting,
  sweepStaleToolOutput,
} from "../agent/tools/shared/cache/tool-output-cache.js";
export { PlanModeController, PLAN_TODO_TITLE, isActivePlanPhase } from "../agent/plan/plan-mode-controller.js";
export { cleanStepText, extractDoneSteps, extractPlan } from "../agent/plan/extract-plan.js";
export {
  getPlanModeToolExcludeSet,
  getPlanModeToolBlockReason,
  isPlanModeForbiddenTool,
  isWorkspaceEditingTool,
  PLAN_AUTHORING_TOOL_NAMES,
  PLAN_COMPLETION_TOOL_NAMES,
  PLAN_MODE_EXCLUDED_NON_EDIT_TOOL_NAMES,
} from "../agent/plan/plan-tools.js";
export { PLAN_STORE_DIR, slugifyPlanName, planFilePath } from "../agent/plan/plan-store.js";
export { formatPlanModeFooterLabel, todoProgressFromItems } from "../agent/plan/plan-footer-label.js";
export { formatStructuredPlanMarkdown, stripLeadingStepNumber } from "../agent/plan/plan-format.js";
export { formatPlanSummary, extractGoalFromPlanMarkdown } from "../agent/plan/plan-summary.js";
export {
  buildModeInactivePrompt,
  buildPlanModePlanningPrompt,
  buildPlanModeReadyPrompt,
  buildPlanModeRetroPrompt,
} from "../agent/plan/plan-prompts.js";
export {
  gateCompletePlanVerification,
  isUsableVerification,
  parseVerificationItemsFromPlanMarkdown,
  parseVerificationItemsFromText,
} from "../agent/plan/plan-verification.js";
export { TodoManager } from "../agent/todo";
export { createTodoTool } from "../agent/todo/todo-tool.js";
export { extractBase64Content, buildDataUrl } from "../agent/media/media-store.js";
export { MediaStore } from "../agent/media/media-store.js";
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
export { LspManager } from "../agent/lsp/lsp-manager.js";
export { findLombokJar } from "../agent/lsp/lombok.js";
export { applyDiagnosticsToToolAfterPayload } from "../agent/lsp/shared/apply-tool-diagnostics.js";
export { extractToolPath, parseToolCallArgs } from "../agent/lsp/shared/parse-tool-args.js";
export { insertDot, shouldSyntheticTrigger } from "../agent/lsp/shared/synthetic-dot.js";
export {
  DIAGNOSTIC_SETTLE_DELAY_MS,
  RESTART_INITIAL_BACKOFF_MS,
  SYNTHETIC_DOT_SETTLE_DELAY_MS,
} from "../agent/lsp/shared/timing.js";
export { lspTextToModelOutput } from "../agent/lsp/shared/tool-output.js";
export { truncateHead } from "../agent/lsp/tools/tool-shared.js";
export { createMemoryExtension, type MemoryExtensionConfig } from "../agent/memory";
export {
  SkillRegistry,
  SkillLoader,
  BUILTIN_SKILLS,
  skillSchema,
  createSkillsExtension,
  type SkillsExtensionConfig,
} from "../agent/skills";
export { createMcpExtension } from "../agent/mcp";
export { mcpConfigFromServers } from "../agent/mcp/options.js";
export { McpManager } from "../agent/mcp/manager.js";
