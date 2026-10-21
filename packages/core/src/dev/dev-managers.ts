/**
 * Internal validation exports — manager / runtime orchestration modules.
 * Aggregated by `dev.ts`; not part of the public API.
 */

export {
  ACTIVE_STATUSES,
  isActiveStatus,
  isTerminalStatus,
  resolveFinishStatus,
} from "../runtime-types/agent-status.js";
export {
  DefaultAgentEventBus,
  createAgentEventBus,
  AGENT_EVENT_META,
  INTERCEPTOR_EVENT_PATTERNS,
} from "../agent/agent-event-bus/index.js";
export type {
  AgentEvent,
  AgentEventBus,
  AgentEventListener,
  AgentEventMeta,
  AgentEvents,
  AgentEventType,
  AgentEventPayloadMap,
} from "../agent/agent-event-bus/index.js";
export { bridgeTelemetryToAgentLog, summarizePayload } from "../agent/log/event-log-bridge.js";
export { DEFAULT_EVENT_LOG_RULES } from "../agent/log/event-log-rules.js";
export { statusTransitionLogLevel } from "../agent/log/status-transition-log.js";
export { createJsonlFileSink } from "../agent/log/jsonl-file-sink.js";
export { createLogExtension } from "../agent/log/extension.js";
export type { LogExtension, LogExtensionOptions, EventLogPolicy } from "../agent/log/extension.js";
export { emitAgentTelemetry } from "../managers/telemetry/emit-agent-telemetry.js";
export { UsageTracker } from "../managers/telemetry/usage-tracker.js";
export { UsageStore } from "../agent/usage/index.js";
// The one convention-aware reading of prompt/total tokens, so a validation can assert a
// display surface against the rule rather than against a formatted string.
export { promptTokensOf, totalTokensOf } from "../runtime-types/token-usage.js";
export { AgentChatController } from "../managers/controllers/agent-chat-controller.js";
export { TurnContextController } from "../managers/controllers/turn-context-controller.js";
export { abortManagedAgentRun, finalizeManagedAgentRun } from "../managers/managed-agent-run-lifecycle.js";
export { ManagedAgent } from "../managers/managed-agent.js";
export { RunnerWiring } from "../managers/managed-agent-runner-wiring.js";
export { RunCoordinator, type RunToken } from "../managers/run-coordinator.js";
export { CompactionService } from "../managers/services/compaction-service.js";
export { SessionService } from "../managers/services/session-service.js";
export { MemoryService } from "../managers/services/memory-service.js";
export { ExtensionRegistryService } from "../managers/services/extension-registry-service.js";
export { BackgroundWorkService } from "../managers/services/background-work-service.js";
export { resolveTextAdapterForManaged } from "../managers/run-agent.js";
export {
  armCapabilityStrip,
  extractRetryAfterSeconds,
  isTransientRetryableError,
  retryDelayMs,
  runStreamWithRecovery,
  tryCapabilitySanitizeRetry,
  tryReactiveCompactRetry,
} from "../managers/run-stream-recovery.js";
export { createTaskPreforkMiddleware } from "../managers/middleware/task-prefork-middleware.js";
export {
  createEarlyToolResultUiMiddleware,
  createExtensionsMiddleware,
  createLifecycleMiddleware,
  instrumentMiddlewareLog,
} from "../managers/middleware";
export { createStatusMiddleware } from "../managers/middleware/status-middleware.js";
export { createApprovalResumeMiddleware } from "../managers/middleware/approval-resume-middleware.js";
export {
  buildSystemPromptWithTurnContext,
  buildTurnContextSections,
  buildProjectInstructionsSection,
  buildFrozenSystemPrompt,
} from "../managers/managed-agent-prompt.js";
export { createPromptCacheMiddleware } from "../managers/middleware/prompt-cache-middleware.js";
// Exported for `validate:middleware-order`, which drives the real pipeline assembly
// instead of duplicating the factory list (see that script's section 1).
export { buildAgentRunner } from "../managers/run-agent.js";

export { deriveCapabilities, MODELS_DEV_COST_FIELDS, MODELS_DEV_MODEL_FIELDS } from "../provider/models-dev.js";
export {
  fetchModelsDev,
  lookupModelFromModelsDev,
  parseModelsDevModel,
  resolveReasoningEchoField,
  shouldEchoReasoning,
} from "../provider/models-dev.js";
export { MODEL_CAPABILITIES } from "../models/types.js";

// Drives `validate:capability-unknown-vs-none`: the `undefined` (unknown) vs `[]` (declared
// none) distinction has to survive the metadata merge, and that merge is only reachable here.
export { resolveModelConfig } from "../models/config/model-config.js";
export { MODEL_CAPABILITY_FLAGS } from "../agent/extension/types.js";

export {
  assertCanonicalMiddlewareOrder,
  CANONICAL_MIDDLEWARE_ORDER,
  createBackgroundNotificationMiddleware,
  createCompactionMiddleware,
  buildRepeatReminderContent,
  canonicalizeRepeatArguments,
  createRepeatReminderMiddleware,
  DEFAULT_REPEAT_THRESHOLDS,
  isGenuineUserMessage,
  previewRepeatArguments,
  REPEAT_REMINDER_KIND,
  createMessageTransformMiddleware,
  createWireRecoveryMiddleware,
  createPlanModeMiddleware,
  createToolCompactMiddleware,
  createTurnContextMiddleware,
  defineMiddleware,
  sortMiddlewaresByPhase,
  MIDDLEWARE_PHASE_RANK,
} from "../managers/middleware/index.js";
export type { MiddlewarePhase } from "../managers/middleware";
export {
  CONTINUATION_PROMPT,
  MAX_TRUNCATION_CONTINUATIONS,
} from "../managers/stream-recovery/max-tokens-continue.js";
export {
  createTruncationState,
  handleMaxTokensTruncation,
  readTruncationProgress,
} from "../managers/stream-recovery/max-tokens-continue.js";
export { createAgentStatusController, AgentStatusController } from "../managers/controllers/agent-status-controller.js";
// The `ManagedAgent` end of the reactive path (gates, retry budget, event pair, status
// unwind). `validate:reactive-compact` drives this against a fake host, because the
// helper-only coverage it had before could not see a broken gate or a stuck status.
export { handleManagedReactiveCompact } from "../managers/managed-agent-compact.js";
export type { ReactiveCompactHost } from "../managers/managed-agent-compact.js";

// Tool presentation registry (internal validation exports — the live descriptor for a tool name,
// which the public entry only exposes as an event payload).
export {
  declareToolPresentation,
  declaredStackDepth,
  describeToolPresentations,
  forgetToolPresentation,
  forgetToolPresentationOwner,
  getToolPresentation,
  hydrateToolPresentations,
} from "../agent/tools/presentation/registry.js";
// The row rule a host branches on — asserted alongside the MCP descriptor it consumes.
export { keepsCompactRow } from "../agent/tools/presentation/row-rules.js";
export type {
  AgentRunOutcome,
  AgentRunOutcomeKind,
  AgentRunPath,
  StatusReconcilePolicy,
} from "../managers/agent-run-outcome.js";
export { whenClearForReconcilePolicy } from "../managers/agent-run-outcome.js";
export { applyRestoredSessionChatState, getSessionPersistInput, restoreManagedSession, saveSessionUIMessages } from "../managers/managed-agent-session.js";
export { SKILL_DIRS_ENV_VAR, getDefaultSkillDirs } from "../managers/agent-manager.js";
