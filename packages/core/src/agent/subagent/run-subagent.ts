/**
 * Worker-profile runner — spawns and executes context-isolated subagents.
 * Uses shared `runAgentOnce` for stream consume + detached outcome.
 */

import { generateId } from "../../utils/generate-id.js";
import { ensureUIChannel, runAgentOnce } from "../run/run-agent-skeleton.js";
import { formatAgentStreamError } from "../stream/assert-async-iterable.js";
import { extractAssistantText } from "../stream/extract-assistant-text.js";
import { summaryStreamKey } from "../summary-stream";

import { buildExploreSystemPrompt } from "./explore-prompt.js";
import { isProgressSummaryEligible, summarizeProgress } from "./progress-summary.js";
import { captureStreamFinishReason, deriveSubagentRunStats, hasBeginSummaryCall } from "./run-stats.js";
import { applySubagentStopNotice, truncateSummary } from "./subagent-output.js";
import { resolveSubagentStopReason, type SubagentStopReason } from "./subagent-stop-reason.js";
import { beginTaskRun, enterTaskPhase } from "./task-run-state.js";
import { resolveSubagentBridgeUI, SUBAGENT_DEFAULT_MAX_ITERATIONS } from "./types.js";

import type { SubagentConfig, SubagentResult } from "./types.js";
import type { AgentManager } from "../../runtime-types/hosts.js";
import type { ModelMessage, StreamChunk, UIMessage as TanStackUIMessage, UIMessage } from "@tanstack/ai";

export interface SubagentRunDeps {
  manager: AgentManager;
}

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

async function executeSubagentRun(config: SubagentConfig, manager: AgentManager): Promise<SubagentResult> {
  const {
    subagentId: customId,
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

  const bridgeUI = resolveSubagentBridgeUI(config);
  const subagentId = customId ?? generateId("subagent", { exists: (id) => manager.getAgent(id) != null });
  const systemPrompt = customSystemPrompt ?? buildExploreSystemPrompt(maxIterations);

  const parentManaged = manager.getAgent(parentAgentId);
  if (!parentManaged) {
    throw new Error(`Parent agent not found: ${parentAgentId}`);
  }

  const subagent = await manager.spawnSubagent(parentAgentId, {
    id: subagentId,
    name: `subagent-${description}`,
    systemPrompt,
    maxIterations,
    subagentTools: customTools,
  });

  // link task to agent, for unstable input
  subagent.parentTaskId = parentTaskToolCallId;

  // Task-level phase machine: authoritative running → summary transitions.
  if (parentTaskToolCallId) {
    beginTaskRun(parentManaged, parentTaskToolCallId);
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

    // Always attach a channel (durable message SoT). bridgeUI only gates parent panel streaming.
    // Context injection is handled by the shared turn-context middleware (subagent kind
    // whitelist: current_date / git_status / project_instructions) — no manual seed here.
    const channel = ensureUIChannel(subagentManaged, {
      initialMessages: [userUIMessage],
    });

    const summaryHub = bridgeUI || compactSummaryStream ? parentManaged.summaryStreams : undefined;
    const compactId = compactSummaryStream?.compactId;
    const compactLabel = compactSummaryStream?.label;
    const compactEpoch = compactSummaryStream?.epoch;

    /**
     * One-way running → terminal transition + telemetry (no-op once in that phase).
     * `limit` upgrades a phase that was already left at `summary`: a subagent can
     * call `begin_summary` and still exhaust the budget before the run closes.
     */
    const enterPhase = (phase: "summary" | "limit") => {
      if (!parentTaskToolCallId) return;
      if (enterTaskPhase(parentManaged, parentTaskToolCallId, phase)) {
        subagent.emitEvent("subagent:phase", { subagentId, phase, parentTaskToolCallId }, { parentId: parentAgentId });
      }
    };
    /** `begin_summary` call site — the subagent is writing its own report. */
    const enterSummaryPhase = () => enterPhase("summary");

    subagent.emitEvent("subagent:created", { subagentId, parentTaskToolCallId }, { parentId: parentAgentId });
    subagent.emitEvent(
      "subagent:started",
      { subagentId, description, parentTaskToolCallId },
      { parentId: parentAgentId }
    );
    // Mirror into the parent's file so a `task` call's children are readable without opening
    // each subagent log (the bus event above only ever lands in the child's own file).
    parentManaged.logSubagentLifecycle("created", { subagentId, parentTaskToolCallId });
    parentManaged.logSubagentLifecycle("started", { subagentId, parentTaskToolCallId, description });

    subagentManaged.resetTurnLifecycle();

    let output = "(no summary)";
    let aborted = false;
    let finishReason: string | null = null;
    let previewMessages: UIMessage[] = [];

    try {
      // Same-epoch follow-up pass: continue the banner with a phase separator
      // instead of resetting it (the channel skips its reset for same epochs).
      if (summaryHub && compactId && compactEpoch) {
        const key = summaryStreamKey("compact", compactId);
        if (summaryHub.getSnapshot(key)?.epoch === compactEpoch) {
          summaryHub.append(key, compactLabel ? `\n\n[${compactLabel}]\n` : "\n\n", { epoch: compactEpoch });
        }
      }

      const result = await runAgentOnce({
        manager,
        agentId: subagentId,
        messages,
        abortSignal,
        channel,
        parentTaskToolCallId: bridgeUI ? parentTaskToolCallId : undefined,
        streamingAgentId: bridgeUI ? parentAgentId : undefined,
        summaryHub,
        compactId,
        compactLabel,
        compactEpoch,
        transformStream: (stream) =>
          captureStreamFinishReason(
            tapTextDeltas(
              tapBeginSummary(stream, parentTaskToolCallId ? () => enterSummaryPhase() : undefined),
              config.onTextDelta
            ),
            (reason) => {
              finishReason = reason;
            }
          ),
        // Outcome applied below — abort ends the stream without throwing, so we must
        // not hardcode `finished` (that would clobber `aborted` / skip cancel notice).
      });
      previewMessages = result.messages;
      output = extractAssistantText(previewMessages)?.trim() || "(no summary)";
    } catch (err) {
      const managed = manager.getAgent(subagentId);
      if (managed?.getStatus() === "aborted" || managed?.isAbortError(err)) {
        aborted = true;
        previewMessages = channel?.getMessages() ?? previewMessages;
        output = extractAssistantText(previewMessages)?.trim() || "(no summary)";
      } else {
        const errorMessage = formatAgentStreamError(err, "Subagent run failed").message;
        // Non-abort failure: surface a real terminal state before propagating.
        // Keep the task prompt + record the error in the preview (so the detail
        // view never spins on an empty transcript), flip the subagent status to
        // `error`, and emit `subagent:error`. The throw below skips the normal
        // outcome/telemetry path, so without this the task lingers as `running`
        // (e.g. after 429 retries are exhausted).
        try {
          channel.failRun(errorMessage);
        } catch {
          // ignore cleanup errors while propagating the run failure
        }
        try {
          subagentManaged.statusController.applyRunOutcome({
            kind: "error",
            messages: previewMessages,
            path: "detached",
            errorMessage,
          });
        } catch {
          // ignore status errors while propagating the run failure
        }
        try {
          subagentManaged.finalizeRun("error");
        } catch {
          // ignore finalize errors while propagating the run failure
        }
        subagent.emitEvent(
          "subagent:error",
          { subagentId, error: errorMessage, parentTaskToolCallId },
          { parentId: parentAgentId }
        );
        throw err;
      }
    }

    // Esc → managed.abort() sets status during consume; stream often completes without throw.
    aborted =
      aborted ||
      subagentManaged.getStatus() === "aborted" ||
      Boolean(subagentManaged.run.currentAbortController?.signal.aborted);

    // Why it stopped, read from the abort reason. TWO signals can carry it and both must be
    // consulted: the caller's `abortSignal` (the pre-fork route ties the child to the parent
    // run's controller) and the child's OWN controller — which is where every
    // `ManagedAgent.abort` / cascade path lands instead. Reading only the first reported a
    // user Esc on the serial `task` path as a parent-run stop, because that path passes no
    // `abortSignal` at all.
    const stopReason: SubagentStopReason = resolveSubagentStopReason({
      aborted,
      reason: abortSignal?.reason ?? subagentManaged.run.currentAbortController?.signal.reason,
    });
    const outcomeKind = aborted ? "aborted" : "finished";
    subagentManaged.statusController.applyRunOutcome({
      kind: outcomeKind,
      messages: previewMessages,
      path: "detached",
    });
    subagentManaged.finalizeRun(outcomeKind);
    // ONLY on an abort. A finished run has no stop reason, and applying the notice by class
    // appended `[Task cancelled.]` to every SUCCESSFUL subagent — which then reached the
    // parent model's context as a cancellation the operator never made. The summary of a
    // finished run is its output, verbatim.
    const noticed = aborted ? applySubagentStopNotice(output, stopReason) : output;
    let { summary: finalOutput, truncated } = truncateSummary(noticed, maxOutputLength);

    const runStats = deriveSubagentRunStats({
      messages: previewMessages,
      maxIterations,
      finishReason,
      output: finalOutput,
      aborted,
      status: subagentManaged.getStatus(),
      // The child's own loop progress. Authoritative for `iterations` and for the
      // step-budget comparison behind `reachedLimit`; the message-derived count is
      // the fallback for callers that lack it.
      observedIterations: subagentManaged.readIteration(),
    });

    // Snapshot status flags BEFORE the progress-summary fallback. The fallback may
    // replace the output text, but it must NEVER change the subagent's status
    // semantics: a step-budget cutoff stays reachedLimit=true + incomplete=true
    // even after a progress report replaces the empty output. Returning these
    // snapshots (not re-read runStats) keeps the contract explicit.
    const statusFlags = {
      iterations: runStats.iterations,
      maxIterations: runStats.maxIterations,
      reachedLimit: runStats.reachedLimit,
      incomplete: runStats.incomplete,
    };

    // Fallback: when the subagent hit the iteration budget before writing a final
    // answer (reachedLimit + incomplete), spawn a parent-owned summarizer that
    // distills the execution trace into a structured progress report. This also
    // covers the mid-tool-loop cutoff: output may hold exploration narration
    // ("Let me do a final check…") but without a `begin_summary` call it is not a
    // final answer. Failure is silent — the original output is kept unchanged.
    //
    // Gated to exploration subagents (default explore tools). Compaction
    // summarizer subagents pass `tools: {}` — never fall back for them, or the
    // fallback would recursively spawn yet another summarizer.
    if (
      !customTools &&
      isProgressSummaryEligible(
        statusFlags.incomplete,
        statusFlags.reachedLimit,
        finalOutput,
        hasBeginSummaryCall(previewMessages)
      )
    ) {
      // Mirror generation into the task summary UI: the phase machine flips to
      // `limit` (NOT `summary` — the run was cut off by the budget, and the UI
      // must not present the fallback report as a natural finish) and the hub
      // reset switches the panel to its summary view; deltas stream live; end
      // settles the view. Without this the report would only appear after the
      // whole side-LLM pass finishes.
      enterPhase("limit");
      const hub = parentTaskToolCallId ? parentManaged.summaryStreams : undefined;
      if (hub && parentTaskToolCallId) {
        hub.reset({ source: "task", toolCallId: parentTaskToolCallId });
      }
      const summaryKey = parentTaskToolCallId ? summaryStreamKey("task", parentTaskToolCallId) : "";
      const onDelta = hub ? (delta: string) => hub.append(summaryKey, delta) : undefined;
      const progressSummary = await summarizeProgress(
        previewMessages,
        parentAgentId,
        manager,
        prompt,
        onDelta ? { onDelta } : undefined,
        (error) =>
          subagent.emitEvent(
            "subagent:progress-summary-error",
            { subagentId, parentAgentId, error },
            { parentId: parentAgentId }
          )
      );
      if (hub && parentTaskToolCallId) {
        hub.end(summaryKey);
      }
      if (progressSummary) {
        const truncatedResult = truncateSummary(progressSummary, maxOutputLength);
        finalOutput = truncatedResult.summary;
        truncated = truncatedResult.truncated;
      }
    }

    const usage = subagentManaged.usage.getTotal();
    // The cache-aware prompt reading, taken alongside the raw aggregate because a
    // subagent's prompt is almost entirely cache reads: `usage.inputTokens` alone is the
    // miss part on an exclusive upstream, so host rendering must not use it.
    const billedInputTokens = subagentManaged.usage.getBilledInputTokens();
    const durationMs = Math.max(0, Date.now() - runStartedAt);

    if (aggregateUsageToParent && parentManaged) {
      // Carry the subagent's own per-call cost (computed at its own model's
      // pricing) instead of re-pricing its tokens at the parent's rate.
      parentManaged.usage.addTotalWithCost(usage, subagentManaged.usage.getTotalCostUsd());
    }

    subagent.emitEvent(
      aborted ? "subagent:error" : "subagent:completed",
      aborted
        ? {
            // A cancel reuses the abort branch, so the flag leads: `error` then holds the
            // partial narration — a summary of work done, not a fault — and the flag is
            // what tells the log bridge (and any other consumer) which of the two it has.
            cancelled: true,
            // How the run was stopped. `cancelled` alone merges a user cancel with a run
            // the parent restarted, which is exactly the attribution the log used to get
            // wrong (every abort read as "cancelled by user").
            stopReason,
            subagentId,
            parentTaskToolCallId,
            error: finalOutput,
          }
        : {
            subagentId,
            parentTaskToolCallId,
            summary: finalOutput,
            iterations: statusFlags.iterations,
            // Recorded next to the count so the persisted log data carries the budget the
            // number was measured against — a bare count there says nothing about how close
            // the run came to its limit. (Both land as structured `data` fields; the log
            // message is `Subagent completed: <summary>` either way.)
            maxIterations: statusFlags.maxIterations,
            durationMs,
            usage: {
              inputTokens: usage.inputTokens ?? 0,
              outputTokens: usage.outputTokens ?? 0,
              totalTokens: usage.totalTokens ?? 0,
            },
            // Flat token fields so the Event→Log entry keeps the numbers structured.
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
            totalTokens: usage.totalTokens ?? 0,
          },
      { parentId: parentAgentId }
    );
    // The parent-log mirror for the terminal state (see the `created`/`started` mirror above).
    if (aborted) {
      parentManaged.logSubagentLifecycle("stopped", { subagentId, parentTaskToolCallId, stopReason });
    } else {
      parentManaged.logSubagentLifecycle("completed", {
        subagentId,
        parentTaskToolCallId,
        iterations: statusFlags.iterations,
        maxIterations: statusFlags.maxIterations,
        durationMs,
      });
    }

    if (autoDestroy) {
      manager.destroyAgent(subagentId);
    }

    subagentRunCompleted = true;
    return {
      subagentId,
      output: finalOutput,
      truncated,
      iterations: statusFlags.iterations,
      maxIterations: statusFlags.maxIterations,
      durationMs,
      usage: {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        // Billed prompt + output, not `usage.totalTokens` — see `totalTokensOf`.
        totalTokens: billedInputTokens + (usage.outputTokens ?? 0),
        billedInputTokens,
        // Stored so a reader of this persisted result can recompute the prompt if
        // `billedInputTokens` is ever absent — see `formatTaskOutput`.
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        cacheWriteTokens: usage.cacheWriteTokens ?? 0,
      },
      reachedLimit: statusFlags.reachedLimit,
      incomplete: statusFlags.incomplete,
      aborted,
      // Carried only for an aborted run: it answers "why did this not finish", and a
      // finished run has nothing to answer. Without this the structured reason never left
      // the run and only the prose notice reached consumers.
      ...(aborted ? { stopReason } : {}),
    };
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
    if (chunk.type === "TOOL_CALL_START" && (chunk.toolName ?? chunk.toolCallName) === "begin_summary") {
      onBeginSummary();
    }
    yield chunk;
  }
}
