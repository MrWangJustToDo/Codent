/**
 * Explore/internal task adapter — spawns and executes context-isolated subagents through the
 * shared managed span. Task-result projection and progress-summary remain explore concerns;
 * the helper owns the managed stream span.
 */

import { modelMessagesToUIMessages } from "@tanstack/ai";

import { generateId } from "../../utils/generate-id.js";
import { runManagedSpan } from "../run/managed-span.js";
import { ensureUIChannel } from "../run/run-agent-skeleton.js";
import { agentStreamKey } from "../stream-hub";

import { BEGIN_SUMMARY_TOOL_NAME } from "./begin-summary-tool.js";
import { buildExploreSystemPrompt } from "./explore-prompt.js";
import { captureStreamFinishReason } from "./run-stats.js";
import { EMPTY_SUMMARY } from "./subagent-output.js";
import { SUBAGENT_PARENT_RUN_NOTICE } from "./subagent-stop-reason.js";
import { finalizeSubagentTask, subagentPreviewOutput } from "./task-result.js";
import { beginTaskRun, enterTaskPhase } from "./task-run-state.js";
import { SUBAGENT_DEFAULT_MAX_ITERATIONS } from "./types.js";

import type { SubagentConfig, SubagentResult, SubagentRunDeps } from "./types.js";
import type { AgentProfileId } from "../../runtime-types/agent-profile.js";
import type { AgentManager } from "../../runtime-types/hosts.js";
import type { ModelMessage, StreamChunk, UIMessage as TanStackUIMessage, UIMessage } from "@tanstack/ai";

/**
 * Runs a subagent with fresh context to complete a delegated task.
 */
export async function runSubagent(config: SubagentConfig, deps: SubagentRunDeps): Promise<SubagentResult> {
  return executeSubagentRun(config, deps.manager);
}

/**
 * Get a subagent instance by ID.
 */
export function getSubagent(manager: AgentManager, subagentId: string) {
  return manager.getAgent(subagentId);
}

/**
 * Map a {@link SubagentResult} to the `task` tool output shape (summary field).
 * Used by the pre-fork middleware to mirror finished runs into the UI early.
 */
export function subagentResultToTaskOutput(result: SubagentResult) {
  return {
    subagentId: result.subagentId,
    ...(result.profile ? { profile: result.profile } : {}),
    summary: result.output,
    truncated: result.truncated,
    iterations: result.iterations,
    maxIterations: result.maxIterations,
    durationMs: result.durationMs,
    usage: result.usage,
    reachedLimit: result.reachedLimit,
    incomplete: result.incomplete,
    aborted: result.aborted,
    ...(result.stopReason ? { stopReason: result.stopReason } : {}),
    success: !result.aborted && !result.incomplete,
  };
}

/**
 * Destroy a subagent by ID.
 */
export function destroySubagent(manager: AgentManager, subagentId: string) {
  manager.destroyAgent(subagentId);
}

/** Result for an abort that landed before the child could start (or just after spawn). */
function abortedBeforeStartResult(subagentId: string, profile: AgentProfileId, maxIterations: number): SubagentResult {
  return {
    subagentId,
    profile,
    output: SUBAGENT_PARENT_RUN_NOTICE,
    truncated: false,
    iterations: 0,
    maxIterations,
    durationMs: 0,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, billedInputTokens: 0 },
    reachedLimit: false,
    incomplete: false,
    aborted: true,
    stopReason: "parent-run",
  };
}

/** A user cancel keeps the task preview; lifecycle/session aborts discard a just-spawned child. */
function retainsAbortedPreview(reason: unknown): boolean {
  return reason === "user-cancelled" || reason === "user";
}

async function executeSubagentRun(config: SubagentConfig, manager: AgentManager): Promise<SubagentResult> {
  const {
    subagentId: customId,
    profile: profileId,
    prompt,
    description = "subtask",
    parentAgentId,
    parentTaskToolCallId,
    systemPrompt: customSystemPrompt,
    tools: customTools,
    maxIterations = SUBAGENT_DEFAULT_MAX_ITERATIONS,
    maxOutputLength,
    abortSignal,
    autoDestroy = true,
    aggregateUsageToParent = true,
    initialMessages,
    compactSummaryStream,
  } = config;

  const effectiveProfileId = profileId ?? "explore";
  if (effectiveProfileId === "general") {
    throw new Error("general child profile is not enabled in this change");
  }
  // A task row is a property of the caller's tool call, not a separate policy: internal
  // workers never project, and a non-internal child with a parent task id does.
  const projectsToTask = effectiveProfileId !== "internal" && Boolean(parentTaskToolCallId);
  const taskCallId = projectsToTask ? parentTaskToolCallId : undefined;
  const subagentId = customId ?? generateId("subagent", { exists: (id) => manager.getAgent(id) != null });
  const systemPrompt = customSystemPrompt ?? buildExploreSystemPrompt(maxIterations);

  const parentManaged = manager.getAgent(parentAgentId);
  if (!parentManaged) {
    throw new Error(`Parent agent not found: ${parentAgentId}`);
  }
  // Capture the hub generation before spawning: a session switch during spawn must make this
  // producer stale, not let it adopt the new session's generation.
  const summaryGeneration = parentManaged.streamHub.getGeneration();
  if (abortSignal?.aborted) {
    return abortedBeforeStartResult(subagentId, effectiveProfileId, maxIterations);
  }

  const subagent = await manager.spawnSubagent(
    parentAgentId,
    {
      name: `subagent-${description}`,
      profileId: effectiveProfileId,
      toolsetProfile: effectiveProfileId,
      systemPrompt,
      maxIterations,
      ...(customTools !== undefined ? { subagentTools: customTools } : {}),
    },
    // The id is core's to assign (`subagent_…`) — passed as the internal channel, not as config.
    subagentId
  );

  // If the abort landed while spawnSubagent was awaiting, the child already exists. A user cancel
  // keeps the task preview; a lifecycle/session abort discards the just-spawned child, because it
  // would otherwise survive into the new session's subtask catalog.
  if (abortSignal?.aborted && !retainsAbortedPreview(abortSignal.reason)) {
    try {
      manager.destroyAgent(subagentId);
    } catch {
      // Cleanup must never mask the abort.
    }
    return abortedBeforeStartResult(subagentId, effectiveProfileId, maxIterations);
  }

  // link task to agent, for unstable input
  subagent.parentTaskId = taskCallId;
  subagent.log.setScope({
    profile: effectiveProfileId,
    ...(taskCallId ? { taskCallId } : {}),
  });
  const childLogDir = subagent.log.getFileSinkDir?.();
  const childLogPath = childLogDir ? `${childLogDir}/${subagentId}.log` : undefined;

  // Task-level phase machine: authoritative running → summary transitions.
  if (taskCallId) {
    beginTaskRun(parentManaged, taskCallId);
  }

  const subagentManaged = manager.getAgent(subagentId);
  if (!subagentManaged) {
    throw new Error(`Subagent not found: ${subagentId}`);
  }

  // Any throw after spawn (stream failure, finalize error, summarizer crash) must
  // not leave the subagent registered when autoDestroy was requested.
  let subagentRunCompleted = false;
  const runStartedAt = Date.now();
  try {
    const messages: ModelMessage[] = [...(initialMessages ?? []), { role: "user", content: prompt }];

    const userUIMessage: TanStackUIMessage = {
      id: generateId("msg"),
      role: "user",
      parts: [{ type: "text", content: prompt }],
      createdAt: new Date(),
    };

    // Always attach a channel (durable message SoT). The parent-row projection is selected by
    // `taskCallId`, not by a separate UI policy.
    // Context injection is handled by the shared turn-context middleware (subagent kind
    // whitelist: current_date / git_status / project_instructions) — no manual seed here.
    // Internal callers (compaction) hand over a ModelMessage history; seed the channel with its
    // UI form so the compaction middleware's channel projection does not discard it.
    const channel = ensureUIChannel(subagentManaged, {
      initialMessages: [...(initialMessages?.length ? modelMessagesToUIMessages(initialMessages) : []), userUIMessage],
    });

    const summaryHub = projectsToTask || compactSummaryStream ? parentManaged.streamHub : undefined;
    const compactId = compactSummaryStream?.compactId;
    const compactLabel = compactSummaryStream?.label;
    const compactEpoch = compactSummaryStream?.epoch;

    /**
     * One-way running → terminal transition + telemetry (no-op once in that phase).
     * `limit` upgrades a phase that was already left at `summary`: a subagent can
     * call `begin_summary` and still exhaust the budget before the run closes.
     */
    const enterPhase = (phase: "summary" | "limit") => {
      if (!taskCallId) return;
      if (enterTaskPhase(parentManaged, taskCallId, phase)) {
        subagent.emitEvent(
          "subagent:phase",
          { subagentId, phase, parentTaskToolCallId: taskCallId },
          { parentId: parentAgentId }
        );
        parentManaged.logSubagentLifecycle("phase", {
          subagentId,
          parentTaskToolCallId: taskCallId,
          taskPhase: phase,
          ...(childLogPath ? { childLogPath } : {}),
        });
      }
    };
    /** `begin_summary` call site — the subagent is writing its own report. */
    const enterSummaryPhase = () => enterPhase("summary");

    subagent.emitEvent(
      "subagent:created",
      { subagentId, parentTaskToolCallId: taskCallId },
      { parentId: parentAgentId }
    );
    subagent.emitEvent(
      "subagent:started",
      { subagentId, description, parentTaskToolCallId: taskCallId },
      { parentId: parentAgentId }
    );
    // Mirror into the parent's file so a `task` call's children are readable without opening
    // each subagent log (the bus event above only ever lands in the child's own file).
    parentManaged.logSubagentLifecycle("created", {
      subagentId,
      parentTaskToolCallId: taskCallId,
      ...(childLogPath ? { childLogPath } : {}),
    });
    parentManaged.logSubagentLifecycle("started", {
      subagentId,
      parentTaskToolCallId: taskCallId,
      description,
      ...(childLogPath ? { childLogPath } : {}),
    });

    subagentManaged.resetTurnLifecycle();

    let output = EMPTY_SUMMARY;
    let aborted = false;
    /** The run died (not a cancel). Terminal, reported as `incomplete` — never thrown. */
    let failed = false;
    let errorMessage: string | undefined;
    let finishReason: string | null = null;
    let previewMessages: UIMessage[] = [];

    // Same-epoch follow-up pass: continue the banner with a phase separator
    // instead of resetting it (the channel skips its reset for same epochs).
    if (summaryHub && compactId && compactEpoch) {
      const key = agentStreamKey("compact", compactId);
      if (summaryHub.getSnapshot(key)?.epoch === compactEpoch) {
        summaryHub.append(key, compactLabel ? `\n\n[${compactLabel}]\n` : "\n\n", {
          epoch: compactEpoch,
          ...(summaryGeneration !== undefined ? { generation: summaryGeneration } : {}),
        });
      }
    }

    const result = await runManagedSpan({
      manager,
      agentId: subagentId,
      abortErrorAsCancel: true,
      messages,
      abortSignal,
      channel,
      ...(taskCallId ? { parentTaskToolCallId: taskCallId } : {}),
      summaryHub,
      compactId,
      compactLabel,
      compactEpoch,
      ...(summaryGeneration !== undefined ? { summaryGeneration } : {}),
      transformStream: (stream) =>
        captureStreamFinishReason(
          tapTextDeltas(
            tapBeginSummary(stream, taskCallId ? () => enterSummaryPhase() : undefined),
            config.onTextDelta
          ),
          (reason) => {
            finishReason = reason;
          }
        ),
      // Outcome applied below — abort ends the stream without throwing, so we must
      // not hardcode `finished` (that would clobber `aborted` / skip cancel notice).
      onAbort: () => {
        aborted = true;
      },
      onError: (message) => {
        failed = true;
        errorMessage = message;
        subagentManaged.statusController.onRunError(message);
      },
    });

    previewMessages = result.messages;
    // The helper normalizes the shared abort/error classification. An abort OUTRANKS a captured
    // fault: an Esc that lands as the provider errors must read as a STOP, not a failure. The
    // caller's signal is checked too: a pre-spawn abort can terminate the stream without the
    // child's own RunCoordinator status flipping.
    aborted = aborted || result.aborted || abortSignal?.aborted === true;
    if (aborted) {
      failed = false;
      errorMessage = undefined;
    }
    output = subagentPreviewOutput(previewMessages);

    const taskResult = await finalizeSubagentTask({
      subagentId,
      profile: effectiveProfileId,
      parentAgentId,
      ...(taskCallId ? { parentTaskToolCallId: taskCallId } : {}),
      prompt,
      previewMessages,
      output,
      aborted,
      failed,
      ...(errorMessage ? { errorMessage } : {}),
      finishReason,
      maxIterations,
      ...(maxOutputLength !== undefined ? { maxOutputLength } : {}),
      runStartedAt,
      ...(abortSignal?.reason !== undefined ? { abortReason: abortSignal.reason } : {}),
      ...(childLogPath ? { childLogPath } : {}),
      subagentManaged,
      parentManaged,
      manager,
      aggregateUsageToParent,
      customTools: customTools !== undefined,
      ...(summaryGeneration !== undefined ? { summaryGeneration } : {}),
      ...(abortSignal ? { abortSignal } : {}),
      channel,
      enterPhase,
      spawn: runSubagent,
    });

    if (autoDestroy) {
      manager.destroyAgent(subagentId);
    }

    subagentRunCompleted = true;
    return taskResult;
  } finally {
    if (!subagentRunCompleted && autoDestroy) {
      try {
        manager.destroyAgent(subagentId);
      } catch {
        // Cleanup must never mask the original failure.
      }
    }
  }
}

/**
 * Forward assistant text deltas to an observer while passing chunks through.
 * Used by the progress-summary fallback to mirror side-LLM output into the
 * task summary UI while it generates.
 */
async function* tapTextDeltas(
  stream: AsyncIterable<StreamChunk>,
  onTextDelta?: (delta: string) => void
): AsyncIterable<StreamChunk> {
  if (!onTextDelta) {
    yield* stream;
    return;
  }
  for await (const chunk of stream) {
    if (chunk.type === "TEXT_MESSAGE_CONTENT" && typeof chunk.delta === "string") {
      onTextDelta(chunk.delta);
    }
    yield chunk;
  }
}

/**
 * Flip the task phase machine to `summary` when the subagent calls
 * `begin_summary` — one-way, authoritative, no message re-scanning.
 */
async function* tapBeginSummary(
  stream: AsyncIterable<StreamChunk>,
  onBeginSummary?: () => void
): AsyncIterable<StreamChunk> {
  if (!onBeginSummary) {
    yield* stream;
    return;
  }
  for await (const chunk of stream) {
    if (chunk.type === "TOOL_CALL_START" && (chunk.toolName ?? chunk.toolCallName) === BEGIN_SUMMARY_TOOL_NAME) {
      onBeginSummary();
    }
    yield chunk;
  }
}
