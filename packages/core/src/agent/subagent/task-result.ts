/**
 * Explore task result projection.
 *
 * The managed-span helper owns the stream/abort/error span; this module owns what a *task* does with
 * the resulting messages: detached finalization, stop notices, run statistics, the progress-summary
 * fallback, usage aggregation, and the parent lifecycle index. Keeping it out of `run-subagent`
 * leaves the runner as spawn + span + cleanup.
 */

import { extractAssistantText } from "../stream/extract-assistant-text.js";
import { agentStreamKey } from "../stream-hub";

import { isProgressSummaryEligible, summarizeProgress, type SummarizerSpawn } from "./progress-summary.js";
import { deriveSubagentRunStats, hasBeginSummaryCall } from "./run-stats.js";
import { EMPTY_SUMMARY, truncateSummary } from "./subagent-output.js";
import {
  applySubagentFailureNotice,
  applySubagentStopNotice,
  resolveSubagentStopReason,
} from "./subagent-stop-reason.js";

import type { SubagentStopReason } from "./subagent-stop-reason.js";
import type { SubagentResult } from "./types.js";
import type { AgentProfileId } from "../../runtime-types/agent-profile.js";
import type { AgentManager, ManagedAgent } from "../../runtime-types/hosts.js";
import type { AgentUIChannel } from "../ui/ui-channel.js";
import type { UIMessage } from "@tanstack/ai";

export interface FinalizeSubagentTaskInput {
  subagentId: string;
  profile: AgentProfileId;
  parentAgentId: string;
  parentTaskToolCallId?: string;
  prompt: string;
  previewMessages: UIMessage[];
  output: string;
  aborted: boolean;
  failed: boolean;
  errorMessage?: string;
  finishReason: string | null;
  maxIterations: number;
  maxOutputLength?: number;
  runStartedAt: number;
  /** Caller abort reason (pre-fork parent run); the child's own reason is read as a fallback. */
  abortReason?: unknown;
  childLogPath?: string;
  subagentManaged: ManagedAgent;
  parentManaged: ManagedAgent;
  manager: AgentManager;
  aggregateUsageToParent: boolean;
  customTools: boolean;
  channel: AgentUIChannel;
  /** Hub generation captured at run start; stale progress-summary writes are ignored. */
  summaryGeneration?: number;
  /** Run abort signal; stops an in-flight progress-summary after a session switch. */
  abortSignal?: AbortSignal;
  enterPhase: (phase: "summary" | "limit") => void;
  spawn: SummarizerSpawn;
}

/** Apply the task-result projection after the managed span has completed. */
export async function finalizeSubagentTask(input: FinalizeSubagentTaskInput): Promise<SubagentResult> {
  const {
    subagentId,
    profile,
    parentAgentId,
    parentTaskToolCallId,
    prompt,
    previewMessages,
    output,
    aborted,
    failed,
    errorMessage,
    finishReason,
    maxIterations,
    maxOutputLength,
    runStartedAt,
    abortReason,
    childLogPath,
    subagentManaged,
    parentManaged,
    manager,
    aggregateUsageToParent,
    customTools,
    channel,
    summaryGeneration,
    abortSignal,
    enterPhase,
    spawn,
  } = input;

  if (failed) {
    try {
      channel.failRun(errorMessage);
    } catch {
      // panel cleanup must never mask the terminal outcome
    }
  }

  const stopReason: SubagentStopReason = resolveSubagentStopReason({
    aborted,
    reason: abortReason ?? subagentManaged.getAbortSignal()?.reason,
  });
  const outcomeKind = aborted ? "aborted" : failed ? "error" : "finished";
  // Read the engine's own turn count BEFORE finalizing: `finalizeDetached` clears the retained
  // iteration progress, so reading it afterwards always returned 0 and the stats fell back to the
  // message-derived count — which undercounts a final text-only turn and can hide a budget cutoff.
  const observedIterations = subagentManaged.readIteration();
  subagentManaged.runFinalizer.finalizeDetached({
    kind: outcomeKind,
    messages: previewMessages,
    ...(failed && errorMessage ? { errorMessage } : {}),
  });

  const noticed = aborted
    ? applySubagentStopNotice(output, stopReason)
    : failed
      ? applySubagentFailureNotice(output, errorMessage)
      : output;
  let { summary: finalOutput, truncated } = truncateSummary(noticed, maxOutputLength);

  const runStats = deriveSubagentRunStats({
    messages: previewMessages,
    maxIterations,
    finishReason,
    output: finalOutput,
    aborted,
    status: subagentManaged.getStatus(),
    observedIterations,
  });
  const statusFlags = {
    iterations: runStats.iterations,
    maxIterations: runStats.maxIterations,
    reachedLimit: runStats.reachedLimit,
    incomplete: runStats.incomplete,
  };

  const taskStream = Boolean(parentTaskToolCallId && parentManaged.getStreamHub());
  const summaryCurrent = !taskStream || parentManaged.getStreamHub().isCurrentGeneration(summaryGeneration);

  if (
    summaryCurrent &&
    !customTools &&
    isProgressSummaryEligible(
      statusFlags.incomplete,
      statusFlags.reachedLimit,
      finalOutput,
      hasBeginSummaryCall(previewMessages),
      failed
    )
  ) {
    enterPhase("limit");
    const hub = taskStream ? parentManaged.getStreamHub() : undefined;
    if (hub && parentTaskToolCallId) {
      hub.reset({
        source: "task",
        toolCallId: parentTaskToolCallId,
        ...(summaryGeneration !== undefined ? { generation: summaryGeneration } : {}),
      });
    }
    const summaryKey = parentTaskToolCallId ? agentStreamKey("task", parentTaskToolCallId) : "";
    const onDelta =
      hub && parentTaskToolCallId
        ? (delta: string) => {
            hub.append(summaryKey, delta, {
              ...(summaryGeneration !== undefined ? { generation: summaryGeneration } : {}),
            });
          }
        : undefined;
    const progressSummary = await summarizeProgress(
      previewMessages,
      parentAgentId,
      manager,
      spawn,
      prompt,
      onDelta ? { onDelta } : undefined,
      (error) =>
        subagentManaged.emitEvent(
          "subagent:progress-summary-error",
          { subagentId, parentAgentId, error },
          { parentId: parentAgentId }
        ),
      abortSignal
    );
    // A session switch can land while the summarizer is running. Do not write the old task's
    // report into the new transcript or count its usage there.
    const progressCurrent = !taskStream || parentManaged.getStreamHub().isCurrentGeneration(summaryGeneration);
    if (hub && parentTaskToolCallId && progressCurrent) {
      hub.end(summaryKey, summaryGeneration);
    }
    if (progressSummary && progressCurrent) {
      const truncatedResult = truncateSummary(progressSummary, maxOutputLength);
      finalOutput = truncatedResult.summary;
      truncated = truncatedResult.truncated;
    }
  }

  const usage = subagentManaged.usage.getTotal();
  const billedInputTokens = subagentManaged.usage.getBilledInputTokens();
  const durationMs = Math.max(0, Date.now() - runStartedAt);
  const usageCurrent = !taskStream || parentManaged.getStreamHub().isCurrentGeneration(summaryGeneration);

  if (aggregateUsageToParent && usageCurrent) {
    // The child's billed-prompt sum travels with its totals: the parent cannot recover it from the
    // aggregate (the same reason `restoreTotals` takes it explicitly).
    parentManaged.usage.addTotalWithCost(
      usage,
      subagentManaged.usage.getTotalCostUsd(),
      subagentManaged.usage.getBilledInputTokens()
    );
  }

  subagentManaged.emitEvent(
    aborted || failed ? "subagent:error" : "subagent:completed",
    failed
      ? { subagentId, parentTaskToolCallId, error: errorMessage }
      : aborted
        ? {
            cancelled: true,
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
            maxIterations: statusFlags.maxIterations,
            durationMs,
            usage: {
              inputTokens: usage.inputTokens ?? 0,
              outputTokens: usage.outputTokens ?? 0,
              totalTokens: usage.totalTokens ?? 0,
            },
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
            totalTokens: usage.totalTokens ?? 0,
            costUsd: subagentManaged.usage.getTotalCostUsd(),
          },
    { parentId: parentAgentId }
  );

  if (aborted || failed) {
    parentManaged.logSubagentLifecycle("stopped", {
      subagentId,
      parentTaskToolCallId,
      ...(aborted ? { stopReason } : {}),
      ...(failed && errorMessage ? { error: errorMessage } : {}),
      ...(childLogPath ? { childLogPath } : {}),
    });
  } else {
    parentManaged.logSubagentLifecycle("completed", {
      subagentId,
      parentTaskToolCallId,
      iterations: statusFlags.iterations,
      maxIterations: statusFlags.maxIterations,
      durationMs,
      usage: {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        totalTokens: billedInputTokens + (usage.outputTokens ?? 0),
        billedInputTokens,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        cacheWriteTokens: usage.cacheWriteTokens ?? 0,
      },
      ...(childLogPath ? { childLogPath } : {}),
    });
  }

  return {
    subagentId,
    profile,
    output: finalOutput,
    truncated,
    iterations: statusFlags.iterations,
    maxIterations: statusFlags.maxIterations,
    durationMs,
    usage: {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      totalTokens: billedInputTokens + (usage.outputTokens ?? 0),
      billedInputTokens,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    },
    reachedLimit: statusFlags.reachedLimit,
    incomplete: statusFlags.incomplete,
    aborted,
    ...(aborted ? { stopReason } : {}),
  };
}

/** Extract the assistant summary from a child channel. */
export function subagentPreviewOutput(messages: UIMessage[]): string {
  return extractAssistantText(messages)?.trim() || EMPTY_SUMMARY;
}
