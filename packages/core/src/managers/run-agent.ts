import {
  getPlanModeToolExcludeSet,
  PLAN_AUTHORING_TOOL_NAMES,
  PLAN_COMPLETION_TOOL_NAMES,
} from "../agent/plan/plan-tools.js";
import { AgentRunner } from "../agent/runner/agent-runner.js";
import { assertAsyncIterable } from "../agent/stream/assert-async-iterable.js";
import { peekTaskPreforkCoordinator } from "../agent/subagent/task-prefork.js";
import { resolveToolsRecord } from "../agent/tools/catalog/tool-set.js";
import { SUBAGENT_EXCLUDED_TOOL_NAMES } from "../agent/tools/runtime/tool-sets.js";
import { createTextAdapter } from "../models/adapter/adapter-factory.js";
import { resolvePromptCacheKey } from "../models/cache/prompt-cache.js";
import { DEFAULT_BASE_URLS } from "../models/config/model-config.js";

import { buildManagedAgentDeps } from "./agent-run-deps.js";
import { DEFAULT_AGENT_MAX_ITERATIONS } from "./agent-types.js";
import {
  createApprovalResumeMiddleware,
  createBackgroundNotificationMiddleware,
  createCompactionMiddleware,
  createEarlyToolResultUiMiddleware,
  createExtensionsMiddleware,
  createLifecycleMiddleware,
  createMessageTransformMiddleware,
  createPlanModeMiddleware,
  createPromptCacheMiddleware,
  createRepeatReminderMiddleware,
  createStatusMiddleware,
  createTaskPreforkMiddleware,
  createToolCompactMiddleware,
  createTurnContextMiddleware,
  createWireRecoveryMiddleware,
  instrumentMiddlewareLog,
} from "./middleware";
import { sortMiddlewaresByPhase, assertCanonicalMiddlewareOrder } from "./middleware/phase.js";
import { runStreamWithRecovery } from "./run-stream-recovery.js";
import { createEmitTelemetryFn } from "./telemetry/emit-agent-telemetry.js";

import type { AgentManager } from "./agent-manager.js";
import type { ManagedAgent } from "./managed-agent.js";
import type { ToolPresentation } from "../agent/tools/presentation/types.js";
import type { TextAdapterConfig } from "../models/adapter/adapter-factory.js";
import type { ModelMessage, ServerTool, StreamChunk, UIMessage } from "@tanstack/ai";

// ============================================================================
// Run message selection
// ============================================================================

// ============================================================================
// Types
// ============================================================================

export interface RunAgentStreamInput {
  messages?: Array<UIMessage | ModelMessage>;
  data?: Record<string, unknown>;
  forwardedProps?: Record<string, unknown>;
  prompt?: string;
  abortSignal?: AbortSignal;
  threadId?: string;
  runId?: string;
  parentRunId?: string;
}

// ============================================================================
// Text adapter resolution
// ============================================================================

export async function resolveTextAdapterForManaged(managed: ManagedAgent): Promise<TextAdapterConfig> {
  const cached = managed.getTextAdapter();
  if (cached) return cached;

  const { config } = managed;
  const style = config.modelStyle;
  if (!style) {
    throw new Error(
      `Agent "${managed.id}" has no modelStyle configured. Set modelStyle, modelBaseURL, and modelApiKey on createManagedAgent().`
    );
  }

  const adapter = createTextAdapter({
    style,
    model: config.model,
    baseURL: config.modelBaseURL ?? DEFAULT_BASE_URLS[style],
    apiKey: config.modelApiKey,
    modelInfo: managed.getModelInfo(),
  });
  managed.setTextAdapter(adapter);
  return adapter;
}

// ============================================================================
// TanStack tools
// ============================================================================

function resolveTanStackTools(
  managed: ManagedAgent,
  resolveToolPresentation: (name: string) => ToolPresentation | undefined
): ServerTool[] {
  const toolset = managed.config.toolsetProfile ?? (managed.parentId ? "explore" : "root");
  if (toolset === "explore") {
    return resolveToolsRecord(managed.tools, { exclude: SUBAGENT_EXCLUDED_TOOL_NAMES }) as ServerTool[];
  }
  if (toolset === "internal") {
    // Internal one-shot workers are caller-supplied; the caller owns their safety policy. Do not
    // silently drop a tool through the explore read-only filter here.
    return resolveToolsRecord(managed.tools) as ServerTool[];
  }
  if (toolset !== "root" && toolset !== "general") {
    throw new Error(`Unsupported toolset profile: "${String(toolset)}"`);
  }
  if (managed.planMode.isRestrictingTools()) {
    const exclude = getPlanModeToolExcludeSet(managed.tools, resolveToolPresentation);
    for (const name of PLAN_COMPLETION_TOOL_NAMES) exclude.add(name);
    return resolveToolsRecord(managed.tools, { exclude }) as ServerTool[];
  }
  if (managed.planMode.getPhase() === "retro") {
    // Retro: allow mutate tools + complete_plan; hide authoring tools
    return resolveToolsRecord(managed.tools, {
      exclude: PLAN_AUTHORING_TOOL_NAMES,
    }) as ServerTool[];
  }
  // Agent / executing / off: hide plan-authoring and complete_plan
  const exclude = new Set([...PLAN_AUTHORING_TOOL_NAMES, ...PLAN_COMPLETION_TOOL_NAMES]);
  return resolveToolsRecord(managed.tools, { exclude }) as ServerTool[];
}

// ============================================================================
// AgentRunner factory
// ============================================================================

export function buildAgentRunner(
  managed: ManagedAgent,
  textAdapter: TextAdapterConfig,
  manager: AgentManager
): AgentRunner {
  // `deps` is the single collaborator surface this assembly reads from, so no factory
  // argument below reaches into `managed` directly.
  const deps = buildManagedAgentDeps(managed, manager);
  // Set-once collaborators are captured once here as local aliases; everything that can
  // change while the (cached) runner is alive stays behind a `deps.getX()` call at the
  // consumer, mirroring the liveness contract on `AgentRunDeps`.
  const { config, parentId, session, usage, usageHistory, statusController, approvals, run, planMode } = deps;
  // `systemPrompt` is genuinely build-time (memoized on the agent and part of the runner
  // key's inputs), so it is read once and passed on.
  const systemPrompt = deps.getSystemPrompt();
  const emitEvent = createEmitTelemetryFn(managed);
  const midIterationMax = config.maxIterations ?? DEFAULT_AGENT_MAX_ITERATIONS;

  const middleware = sortMiddlewaresByPhase([
    createStatusMiddleware({
      status: statusController,
      onApprovalRequested: (approvalId, toolCallId) => {
        approvals.upsert({ id: approvalId, toolCallId, status: "pending" });
      },
    }),
    createApprovalResumeMiddleware({
      getApprovals: () => approvals.toArray(),
    }),
    createLifecycleMiddleware({
      usage: usage,
      getPricing: () => usage.getPricing(),
      onThinking: () => emitEvent("agent:thinking"),
      onFirstModelOutput: deps.commitSurfacedMemories,
      emitEvent,
      recordUsage: (input) => usageHistory.record({ agentId: deps.agentId, ...input }),
      maxIterations: midIterationMax,
      onIteration: deps.setIterationProgress,
    }),
    createCompactionMiddleware({
      agentId: deps.agentId,
      manager: deps.manager,
      getCompactionConfig: deps.getCompactionConfig,
      getCoreEnv: () => deps.coreEnv,
      // Read live so late-arriving ModelInfo (models.dev lookup) stays in sync
      // with ManagedAgent.getMessagesForLLM's keep-policy resolution.
      getContextWindow: () => deps.getModelInfo()?.contextWindow,
      getUIChannel: deps.getUIChannel,
      getUsage: () => usage,
      getTodoManager: deps.getTodoManager,
      shouldTriggerAutoCompact: deps.shouldTriggerAutoCompact,
      status: statusController,
      log: deps.getLog(),
      emitEvent,
      getWireProjectionCache: deps.getWireProjectionCache,
    }),
    // Extension message transformers. Sits right after `compaction` so it sees the
    // channel-projected wire — running earlier would be discarded by that projection.
    createMessageTransformMiddleware({
      agentId: deps.agentId,
      getExtensionRunner: deps.getExtensionRunner,
      getUsage: () => usage,
      // Read live, not captured: a rejection can widen the run's drop set mid-run.
      getWireDropPartTypes: () => run.getWireDropPartTypes(),
      getAbortSignal: () => run.currentAbortController?.signal,
    }),
    createToolCompactMiddleware({
      getCompactionConfig: deps.getCompactionConfig,
      getToolCompactCache: deps.getToolCompactCache,
      getManagedAgent: () => managed,
    }),
    // Per-run wire overrides that must outlive the channel projection (capability
    // strip + `max_tokens` continuation). Sits after `tool-compact` — the stage that
    // turns a tool result into real content parts, so the strip can reach tool media
    // at all — and after `message-transform`, so a strip cannot hide the real media
    // part from an extension transformer.
    createWireRecoveryMiddleware({
      getRun: () => run,
      // Read live: a restore can report misses while the agent stays alive (mid-session switch).
      hasUnhydratedMedia: deps.hasUnhydratedMedia,
    }),
    createTurnContextMiddleware({
      getFrozenSystemPrompt: deps.getFrozenSystemPrompt,
      getSections: (messages) => deps.getDynamicTurnContextSections(messages),
      getBackgroundJobsSection: deps.getBackgroundJobsSection,
      getUIChannel: () => deps.getUIChannel() ?? undefined,
      persistMessages: (next) => deps.shouldPersistUIMessage(next, "user-message"),
      getManagedAgent: () => managed,
      // Subagents get the parent's agent doc (their own is not loaded).
      getProjectInstructions: () => {
        if (!parentId) return undefined;
        return deps.manager.getAgent(parentId)?.getAgentDocContent() || undefined;
      },
    }),
    createExtensionsMiddleware({
      getExtensionRunner: deps.getExtensionRunner,
      getSessionId: () => session.getSessionData()?.id ?? deps.agentId,
      emitEvent,
      getAbortSignal: () => run.currentAbortController?.signal,
      // A pre-forked `task` emits its own start on admission; skip the eager one so a
      // queued run does not time while it waits for a concurrency slot.
      isTaskToolStartDeferred: (toolCallId) => peekTaskPreforkCoordinator(managed)?.has(toolCallId) === true,
      onToolSettled: (toolCallId) => deps.streamHub.endCommand(toolCallId),
    }),
    // TanStack batches TOOL_CALL_END until all tools finish; mirror each result into UI early.
    createEarlyToolResultUiMiddleware({
      getUIChannel: deps.getUIChannel,
    }),
    // Pre-start task subagents while args stream so parallel task calls run concurrently.
    createTaskPreforkMiddleware({
      getManagedAgent: () => managed,
      manager: deps.manager,
      emitEvent,
      getUIChannel: () => deps.getUIChannel() ?? undefined,
    }),
    createPlanModeMiddleware({
      getPlanMode: () => planMode,
      resolveToolPresentation: deps.resolveToolPresentation,
    }),
    // Advisory loop hygiene: nudge the model out of identical tool-call loops. Counts
    // attempts and injects a synthetic reminder before the next LLM call (after the
    // repeated call's result), persisted like the background notification.
    createRepeatReminderMiddleware({
      getUIChannel: () => deps.getUIChannel() ?? undefined,
      persistMessages: (next) => deps.shouldPersistUIMessage(next, "user-message"),
    }),
    // Surface finished background jobs as a lightweight notification before each LLM call.
    // Both injects the notification into the current run's messages AND persists it as an
    // independent synthetic UIMessage so it survives across turns (prompt-cache friendly).
    createBackgroundNotificationMiddleware({
      getUIChannel: () => deps.getUIChannel() ?? undefined,
      persistMessages: (next) => deps.shouldPersistUIMessage(next, "user-message"),
      getCommandService: () => deps.getCommandService(),
    }),
    createPromptCacheMiddleware({
      getModelStyle: () => config.modelStyle,
      getPromptCacheKey: () => resolvePromptCacheKey(session.getSessionData()?.id, deps.agentId),
    }),
  ]);
  assertCanonicalMiddlewareOrder(middleware, (message: string) => deps.getLog().warn("agent", message));

  const maxOutputTokens = config.maxTokens ?? deps.getModelInfo()?.defaultMaxTokens;

  return new AgentRunner({
    adapter: textAdapter.adapter,
    model: textAdapter.model,
    maxIterations: midIterationMax,
    systemPrompts: systemPrompt ? [systemPrompt] : undefined,
    tools: resolveTanStackTools(managed, deps.resolveToolPresentation),
    middleware: instrumentMiddlewareLog(middleware, deps.getLog()),
    temperature: config.temperature,
    maxOutputTokens,
    reasoningEffort: config.reasoningEffort ?? deps.getModelInfo()?.reasoningConfig?.defaultEffort,
    modelStyle: config.modelStyle,
    lazyToolsConfig: config.lazyToolsConfig,
    // The owning runtime's env reaches tools via the run context; ambient otherwise.
    coreEnv: deps.coreEnv,
  });
}

function runnerConfigKey(managed: ManagedAgent): string {
  return JSON.stringify({
    tools: Object.keys(managed.tools).sort(),
    model: managed.config.model,
    maxIterations: managed.config.maxIterations,
    temperature: managed.config.temperature,
    modelStyle: managed.config.modelStyle,
    modelBaseURL: managed.config.modelBaseURL,
    reasoningEffort: managed.config.reasoningEffort,
    // Rebuild when plan mode hides/restores tools
    planPhase: managed.planMode.getPhase(),
  });
}

export async function ensureAgentRunner(_manager: AgentManager, managed: ManagedAgent): Promise<AgentRunner> {
  const textAdapter = await resolveTextAdapterForManaged(managed);
  const configKey = runnerConfigKey(managed);

  const existing = managed.getRunner();
  if (existing && managed.getRunnerConfigKey() === configKey) {
    return existing;
  }

  managed.setRunnerConfigKey(configKey);
  const runner = buildAgentRunner(managed, textAdapter, _manager);
  managed.setRunner(runner);
  return runner;
}

// ============================================================================
// runManagedAgentStream / runManagedAgent
// ============================================================================

async function executeManagedAgentRun(
  manager: AgentManager,
  agentId: string,
  input: RunAgentStreamInput
): Promise<AsyncIterable<StreamChunk>> {
  const managed = manager.getAgent(agentId);
  if (!managed) throw new Error(`Agent not found: ${agentId}`);

  const runner = await ensureAgentRunner(manager, managed);

  let messages = input.messages;
  if (input.prompt && !messages) {
    messages = [{ role: "user", content: input.prompt }];
  }

  await managed.prepareForRun({
    messages: messages as Parameters<typeof managed.prepareForRun>[0]["messages"],
    prompt: input.prompt,
    abortSignal: input.abortSignal,
  });

  if (!managed.getUI()) {
    throw new Error(`Agent "${agentId}" requires a UI channel before LLM runs`);
  }

  // Use the RunCoordinator controller created in prepareForRun so ManagedAgent.abort()
  // cancels the same AbortController identity TanStack chat listens to.
  const abortController = managed.run.currentAbortController;
  if (!abortController) {
    throw new Error(`Agent "${agentId}" missing abort controller after prepareForRun`);
  }

  // Always read the live channel — compact / synthetic ctx injection may mutate it mid-run/recovery.
  return runStreamWithRecovery({
    managed,
    manager,
    signal: abortController.signal,
    getMessages: () => managed.getUI()?.getMessages() ?? [],
    run: (runMessages) =>
      runner.run({
        agentId,
        messages: runMessages,
        abortController,
        threadId: input.threadId,
        runId: input.runId,
      }),
    runner,
  });
}

/**
 * Streaming entry — a lazy {@link AsyncIterable} of AG-UI chunks for one managed run.
 * `prepareForRun` runs on the first iteration, so a setup failure surfaces there rather
 * than at this call. Raw engine chunks only: no UI bridging (the caller consumes into a
 * channel — see `runAgentOnce`).
 */
export function runManagedAgentStream(
  manager: AgentManager,
  agentId: string,
  input: RunAgentStreamInput
): AsyncIterable<StreamChunk> {
  return (async function* () {
    const stream = await executeManagedAgentRun(manager, agentId, input);
    assertAsyncIterable(stream, `executeManagedAgentRun(${agentId})`);
    yield* stream;
  })();
}

/**
 * Awaiting entry — a promise that resolves to the same AG-UI chunk stream as
 * {@link runManagedAgentStream}. Awaiting runs `prepareForRun` eagerly, so setup
 * failures reject the promise instead of surfacing at the first iteration; that eager
 * boundary is the only difference from the lazy streaming sibling. No UI bridging.
 */
export async function runManagedAgent(
  manager: AgentManager,
  agentId: string,
  input: RunAgentStreamInput
): Promise<AsyncIterable<StreamChunk>> {
  return executeManagedAgentRun(manager, agentId, input);
}
