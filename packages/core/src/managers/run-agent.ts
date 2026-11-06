import { getPlanModeToolExcludeSet } from "../agent/plan/plan-tools.js";
import { AgentRunner } from "../agent/runner/agent-runner.js";
import { peekTaskPreforkCoordinator } from "../agent/subagent/subagent-runs.js";
import { resolveToolsRecord } from "../agent/tools/catalog/tool-set.js";
import { createTextAdapter } from "../models/adapter/adapter-factory.js";
import { resolvePromptCacheKey } from "../models/cache/prompt-cache.js";
import { DEFAULT_BASE_URLS } from "../models/config/model-config.js";
import { DEFAULT_AGENT_MAX_ITERATIONS } from "../runtime-types/agent-limits.js";

import { buildManagedAgentDeps } from "./agent-run-deps.js";
import {
  createApprovalResumeMiddleware,
  createBackgroundMiddleware,
  createCompactionMiddleware,
  createEarlyToolResultUiMiddleware,
  createExtensionsMiddleware,
  createLifecycleMiddleware,
  createMessageTransformMiddleware,
  createPlanModeMiddleware,
  createPromptCacheMiddleware,
  createRepeatReminderMiddleware,
  createStatusMiddleware,
  createStepBudgetMiddleware,
  createTaskPreforkMiddleware,
  createTodoReminderMiddleware,
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
import type { AgentPolicyFacts } from "../agent/mode/policy-facts.js";
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
  // `modelStyle` is optional on the create contract because `modelInfo` carries the same fact. Fall
  // back to it rather than failing a session whose connection was resolved but whose style flag was
  // not repeated.
  const style = config.modelStyle ?? managed.getModelInfo()?.style;
  if (!style) {
    throw new Error(
      `Agent "${managed.id}" has no modelStyle configured. Set modelStyle (or pass modelInfo with a style) on create.`
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
  resolveToolPresentation: (name: string) => ToolPresentation | undefined,
  getPolicyFacts: () => AgentPolicyFacts
): ServerTool[] {
  const facts = getPolicyFacts();
  const toolset = facts.profile;
  if (toolset !== "root" && toolset !== "general" && toolset !== "explore" && toolset !== "internal") {
    throw new Error(`Unsupported toolset profile: "${String(toolset)}"`);
  }
  if (toolset === "internal") {
    // Internal one-shot workers are caller-supplied; the caller owns their safety policy. Do not
    // silently drop a tool through the explore read-only filter here.
    return resolveToolsRecord(managed.tools) as ServerTool[];
  }
  // One projection of the policy: the profile's unavailable set (explore's read-only filter, the
  // mode's hidden names), plus the registry-dependent mutating/MCP set while plan restricts edits.
  const exclude = new Set(facts.unavailableTools);
  if (facts.toolAvailability.restrictsMutations) {
    for (const name of getPlanModeToolExcludeSet(managed.tools, resolveToolPresentation)) exclude.add(name);
  }
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
  const { config, parentId, session, usage, usageHistory, statusController, approvals, run } = deps;
  // `systemPrompt` is genuinely build-time (memoized on the agent and part of the runner
  // key's inputs), so it is read once and passed on.
  const systemPrompt = deps.getSystemPrompt();
  const emitEvent = createEmitTelemetryFn(managed);
  const midIterationMax = config.maxIterations ?? DEFAULT_AGENT_MAX_ITERATIONS;

  const middleware = sortMiddlewaresByPhase([
    createStatusMiddleware({
      status: statusController,
      getRunToken: () => run.getRunToken(),
      onApprovalRequested: (approvalId, toolCallId) => {
        approvals.upsert({ id: approvalId, toolCallId, status: "pending" });
      },
    }),
    createApprovalResumeMiddleware({
      getApprovals: () => approvals.toArray(),
      getMessages: () => deps.getUIChannel()?.getMessages() ?? [],
    }),
    createLifecycleMiddleware({
      usage: usage,
      getPricing: () => usage.getPricing(),
      // Per-user-turn identity: a retried attempt keeps the same id, so `firstOutput` is not
      // reported twice when the engine is re-entered.
      getRunToken: () => deps.getCurrentRunId?.() ?? null,
      onThinking: (info) => emitEvent("agent:thinking", info),
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
      compactions: deps.compactions,
      emitEvent,
      getWireProjectionCache: deps.getWireProjectionCache,
    }),
    createToolCompactMiddleware({
      getCompactionConfig: deps.getCompactionConfig,
      getToolCompactCache: deps.getToolCompactCache,
      getManagedAgent: () => managed,
      emitEvent,
    }),
    // Extension message transformers. Sits after `compaction` (that projection rebuilds the wire
    // from the channel, discarding earlier edits) and after `tool-compact` (the stage that
    // projects a tool result through its own `toModelOutput`: running before it meant a
    // transformer's rewrite of a tool message was re-projected over on the same call).
    createMessageTransformMiddleware({
      agentId: deps.agentId,
      getExtensionRunner: deps.getExtensionRunner,
      getUsage: () => usage,
      // Read live, not captured: a rejection can widen the run's drop set mid-run.
      getWireDropPartTypes: () => run.getWireDropPartTypes(),
      getAbortSignal: () => run.currentAbortController?.signal,
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
      getSections: () => deps.getDynamicTurnContextSections(),
      getUIChannel: () => deps.getUIChannel() ?? undefined,
      persistMessages: (next) => deps.shouldPersistUIMessage(next, "user-message"),
      getManagedAgent: () => managed,
      // Subagents get the parent's agent doc (their own is not loaded).
      getProjectInstructions: () => {
        if (!parentId) return undefined;
        return deps.manager.getAgent(parentId)?.getAgentDocContent() || undefined;
      },
    }),
    // Subagent step budget: one gentle reminder at 80%, so the child can wrap up before the cap.
    createStepBudgetMiddleware({
      isSubagent: () => Boolean(parentId),
      getMaxIterations: () => midIterationMax,
      getUIChannel: () => deps.getUIChannel() ?? undefined,
      persistMessages: (next) => deps.shouldPersistUIMessage(next, "user-message"),
    }),
    createExtensionsMiddleware({
      getExtensionRunner: deps.getExtensionRunner,
      getToolBeforeHooks: deps.getToolBeforeHooks,
      // Session identity from the same accessor the event envelope uses: a subagent resolves the
      // parent session it was spawned in (not its agent id), and a root falls back to the
      // pre-adoption `initialSessionId`. This is what keeps `tool:before:*` agreeing with the
      // `agent:tool-start` envelope for the same call.
      getSessionId: () => managed.getEventSessionId(),
      emitEvent,
      getAbortSignal: () => run.currentAbortController?.signal,
      // A pre-forked `task` emits its own start on admission; skip the eager one so a
      // queued run does not time while it waits for a concurrency slot.
      isTaskToolStartDeferred: (toolCallId) => peekTaskPreforkCoordinator(managed)?.has(toolCallId) === true,
      // The approval decision (and the command-safety analysis behind it) was computed from the
      // ORIGINAL input before this hook, and an eagerly started `task` subagent already began on
      // it. Neither can honour a rewritten argument list after the fact.
      isApprovalGated: (toolName) => deps.isToolNeedsApproval(toolName),
      // Name equality is not identity: an extension may shadow `task`, and the deferred-start /
      // argument-rewrite rules describe the built-in implementation on the original input.
      isBuiltinTool: (toolName) => deps.isBuiltinTool(toolName),
      onArgRewriteRefused: (toolName) => {
        emitEvent("session:diagnostic", {
          area: "extension",
          message: "Ignored an extension argument rewrite on a gated tool call",
          level: "warn",
          details: { toolName },
        });
      },
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
      getModeState: () => deps.getModeState(),
      resolveToolPresentation: deps.resolveToolPresentation,
      isBuiltinTool: (toolName) => deps.isBuiltinTool(toolName),
    }),
    // Condition + counter reminder: the todo list has gone stale for too many rounds. Reads
    // its round/episode state back from the window (no in-memory schedule).
    createTodoReminderMiddleware({
      getTodoManager: deps.getTodoManager,
      getUIChannel: () => deps.getUIChannel() ?? undefined,
      persistMessages: (next) => deps.shouldPersistUIMessage(next, "user-message"),
    }),
    // Condition + counter reminder: identical tool-call loops. Same scan model as the todo nag.
    createRepeatReminderMiddleware({
      getUIChannel: () => deps.getUIChannel() ?? undefined,
      persistMessages: (next) => deps.shouldPersistUIMessage(next, "user-message"),
    }),
    // Background class: one trunk for both kinds — the `<background_jobs>` pointer (hash-admitted
    // against the wire, commands only) and one-shot completion pushes, both persisted so they
    // survive across turns.
    createBackgroundMiddleware({
      getUIChannel: () => deps.getUIChannel() ?? undefined,
      persistMessages: (next) => deps.shouldPersistUIMessage(next, "user-message"),
      getBackgroundWork: () => deps.getBackgroundWork(),
      getCommandService: () => deps.getCommandService(),
      getParentId: () => parentId,
      isSessionSwitching: () => managed?.isSessionSwitching() ?? false,
      emitDiagnostic: (area, message, options) =>
        emitEvent("session:diagnostic", {
          area,
          message,
          ...(options?.level ? { level: options.level } : {}),
          ...(options?.error ? { error: options.error } : {}),
        }),
    }),
    createPromptCacheMiddleware({
      getModelStyle: () => config.modelStyle,
      getPromptCacheKey: () => resolvePromptCacheKey(session.getSessionData()?.id, deps.agentId),
    }),
  ]);
  assertCanonicalMiddlewareOrder(middleware, (message: string) =>
    emitEvent("session:diagnostic", { area: "middleware", message })
  );

  const maxOutputTokens = config.maxTokens ?? deps.getModelInfo()?.defaultMaxTokens;

  return new AgentRunner({
    adapter: textAdapter.adapter,
    model: textAdapter.model,
    maxIterations: midIterationMax,
    systemPrompts: systemPrompt ? [systemPrompt] : undefined,
    tools: resolveTanStackTools(managed, deps.resolveToolPresentation, deps.getPolicyFacts),
    middleware: instrumentMiddlewareLog(middleware, emitEvent),
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
    // A runtime `updateConfig({ maxTokens })` must rebuild the runner; the cap is baked into
    // `AgentRunner` at construction. (Creation always builds after the config is parsed.)
    maxTokens: managed.config.maxTokens,
    modelStyle: managed.config.modelStyle,
    modelBaseURL: managed.config.modelBaseURL,
    reasoningEffort: managed.config.reasoningEffort,
    // Rebuild when plan mode hides/restores tools
    planPhase: managed.getModeState().toolAvailability().phase,
  });
}

export async function ensureAgentRunner(_manager: AgentManager, managed: ManagedAgent): Promise<AgentRunner> {
  const textAdapter = await resolveTextAdapterForManaged(managed);
  const configKey = runnerConfigKey(managed);

  const existing = managed.getRunner();
  if (existing && managed.getRunnerConfigKey() === configKey) {
    return existing;
  }

  // Commit the key only after the build succeeds. Writing it first meant a throwing build left a
  // NEW key beside the OLD runner: the next call saw a key match and returned a runner built for the
  // previous tool/config set, with no retry. The old key + old runner is a coherent pair; the new key
  // is only true once a new runner exists.
  const runner = buildAgentRunner(managed, textAdapter, _manager);
  managed.setRunnerConfigKey(configKey);
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

  let messages = input.messages;
  if (input.prompt && !messages) {
    messages = [{ role: "user", content: input.prompt }];
  }

  // A run with no channel can never stream: reject before preparation so it does not mint a runId,
  // emit `prompt:submit`, or run the extension hooks for a turn that cannot start.
  if (!managed.getUI()) {
    throw new Error(`Agent "${agentId}" requires a UI channel before LLM runs`);
  }

  // Prepare BEFORE the adapter is built. `prepareForRun` is what mints this run's
  // AbortController (`setupAbortController`), while `ensureAgentRunner` is the step that can
  // reject on a configuration problem (missing key / unknown style). The old order left the
  // PREVIOUS run's controller current while the pump had already flipped the status to
  // `running`, so a stale `aborted` signal made `runManagedSpan` classify a setup failure as a
  // user cancel: the error disappeared, the turn finalized as `finished`, and post-run memory
  // extraction ran. Minting the controller first makes "was THIS run aborted?" answerable.
  await managed.prepareForRun({
    messages: messages as Parameters<typeof managed.prepareForRun>[0]["messages"],
    prompt: input.prompt,
    abortSignal: input.abortSignal,
  });

  const runner = await ensureAgentRunner(manager, managed);

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
        threadId: input.threadId ?? managed.getEventSessionId(),
        runId: input.runId,
        maxOutputTokens: managed.run.getMaxOutputTokensOverride(),
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
    // No `assertAsyncIterable` here: `executeManagedAgentRun` returns an async generator, so the
    // outer value is already iterable. The real assertion lives where the stream is created
    // (`AgentRunner.run` / `chat()`) and in the recovery wrapper that validates a custom `run`.
    yield* await executeManagedAgentRun(manager, agentId, input);
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
