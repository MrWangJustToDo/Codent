/**
 * Prepare / finalize / abort run lifecycle for {@link ManagedAgent}.
 */

import { type UIMessage as TanStackUIMessage, type ModelMessage } from "@tanstack/ai";

import { getLatestUserMessage } from "../agent/compaction/message-utils.js";
import { isToolContinuationPrepare } from "../agent/stream/tool-phase-utils.js";
import { isActiveStatus } from "../runtime-types/agent-status.js";

import type { AgentStatus, RunFinalizeReason } from "./agent-types.js";
import type { RunCoordinator } from "./run-coordinator.js";
import type { CompactionService } from "./services/compaction-service.js";
import type { MemoryService } from "./services/memory-service.js";
import type { EmitAgentTelemetryFn } from "./telemetry/emit-agent-telemetry.js";
import type { UsageTracker } from "./telemetry/usage-tracker.js";
import type { AgentLog } from "../agent/agent-log";
import type { AgentUIChannel } from "../agent/ui/ui-channel.js";
import type { TextAdapterConfig } from "../models/adapter/adapter-factory.js";

/**
 * Narrow interface capturing only the methods/fields lifecycle helpers need.
 * ManagedAgent structurally satisfies this via its public API surface.
 * This prevents lifecycle helpers from depending on the full ManagedAgent class.
 */
export interface RunLifecycleHost {
  readonly id: string;
  parentId?: string;
  getStatus: () => AgentStatus;
  setStatus: (status: AgentStatus) => void;
  /** Track the active run id (log run-scoping); pass null to clear. */
  setCurrentRunId: (runId: string | null) => void;
  recordStreamDuration: () => void;
  consumePrepareAsContinuation: () => boolean;
  clearPrepareAsContinuation: () => void;
  beginTurnFinalize: () => boolean;
  getStreamStartedAt: () => number;
  setStreamStartedAt: (value: number) => void;
  persistSession: () => void;
  clearTurnContext: () => void;
  getMessagesForLLM: (canon?: ModelMessage[]) => ModelMessage[];
  collectExtensionPromptHooks: (prompt: string) => Promise<void>;
  emitEvent: EmitAgentTelemetryFn;
  resolveTextAdapter?: () => Promise<TextAdapterConfig | null>;
  log: AgentLog | null;
  usage: UsageTracker;
  getUI?: () => AgentUIChannel | undefined;
  run: RunCoordinator;
  compaction: CompactionService;
  memory: MemoryService;
}

export async function prepareManagedAgentForRun(
  host: RunLifecycleHost,
  options: {
    prompt?: string;
    messages?: Array<TanStackUIMessage | ModelMessage>;
    abortSignal?: AbortSignal;
  }
): Promise<void> {
  const inputMessages = options.messages || [];

  host.run.setupAbortController(options.abortSignal, {
    onAborted: () => {
      // Only an IN-FLIGHT run can be turned into an abort.
      //
      // The predicate is `isActiveStatus`, deliberately NOT `isTerminalStatus`. Those two
      // tables answer different questions, and this one asked the wrong table once:
      //
      // - `TERMINAL_STATUSES` means "must not be overwritten when a stream finishes
      //   normally". It therefore EXCLUDES `completed` (that is the value a normal finish
      //   writes) and INCLUDES `waiting` / `awaiting_user` (a paused run, which can and
      //   should still be aborted). Using it here left `completed` unguarded — exactly the
      //   case this exists for — while wrongly refusing to abort an approval pause.
      // - `ACTIVE_STATUSES` means "currently doing work", which is precisely "aborting this
      //   has something to change".
      //
      // This listener fires SYNCHRONOUSLY inside `RunCoordinator.abort()`, so it runs BEFORE
      // the status check at the end of `abortManagedAgentRun` — a guard placed after that
      // call sees the value this line already rewrote, which is how the original
      // `status !== "completed"` check became dead code.
      //
      // Aborting the CONTROLLER is still correct for a finished agent (late listeners read
      // `signal.aborted`); rewriting its STATUS is not. A run that already has an outcome
      // (completed / aborted / error) or never started (idle) keeps the status it has.
      if (isActiveStatus(host.getStatus())) {
        host.setStatus("aborted");
      }
    },
  });
  host.compaction.resetReactiveCompactRetries();

  // Always consume the flag (avoid `||` short-circuit leaving a stale continuation mark).
  const flaggedContinuation = host.consumePrepareAsContinuation() === true;
  const isToolContinuation = isToolContinuationPrepare(host.getStatus(), options.messages) || flaggedContinuation;
  if (!isToolContinuation || host.getStreamStartedAt() === 0) {
    host.setStreamStartedAt(Date.now());
  }

  // Run scope: one short id per user turn (tool continuations keep the same id).
  if (!isToolContinuation) {
    const runId = Math.random().toString(36).slice(2, 10);
    host.setCurrentRunId(runId);
    host.log?.setRun(runId);
  }

  if (!isToolContinuation && !host.parentId) {
    await host.memory.prefetchRelevantMemories({
      messages:
        getLatestUserMessage(options.prompt ? [{ role: "user", content: options.prompt }] : inputMessages) || [],
      usage: host.usage,
      log: host.log,
      resolveTextAdapter: host.resolveTextAdapter,
      emitEvent: (type, data) => host.emitEvent(type, data),
      // Let abort interrupt the memory-selection LLM side-query during prerun.
      abortSignal: host.run.currentAbortController?.signal,
    });

    // Extension hooks once per user turn — consumed by the turn-context middleware
    // at onConfig (injection happens after compaction, against the real wire payload).
    await host.collectExtensionPromptHooks(typeof options.prompt === "string" ? options.prompt : "(structured)");

    const userMsg = typeof options.prompt === "string" ? options.prompt : "(structured)";
    host.emitEvent("prompt:submit", {
      prompt: userMsg,
      contextMessageCount: (host.getUI?.()?.getMessages() ?? inputMessages).length,
    });
  }
}

export function finalizeManagedAgentRun(host: RunLifecycleHost, reason: RunFinalizeReason): void {
  // Idempotent per turn — pump `stop()` and outcome paths may both attempt finalize.
  if (!host.beginTurnFinalize()) return;

  host.clearPrepareAsContinuation();
  host.recordStreamDuration();
  host.persistSession();
  host.clearTurnContext();
  if (reason === "finished") {
    host.memory.runExtraction({
      getMessagesForLLM: () => host.getMessagesForLLM(),
      log: host.log,
      // Extraction and consolidation are real LLM spend; the tracker is what makes it
      // show up in the session's lifetime totals.
      usage: host.usage,
      resolveTextAdapter: host.resolveTextAdapter,
      emitEvent: (type, data) => host.emitEvent(type, data),
      // Best-effort pass-through of the run's controller. Note the limit: this
      // runs from `finalize`, which only happens once the turn has settled (and
      // only for `reason === "finished"`, so an aborted turn never gets here),
      // and the coordinator's controller is replaced per run rather than aborted
      // on completion. The signal is therefore live but nothing aborts it while
      // extraction is in flight — cancellation of a later turn does not reach
      // this call. Kept so the port's abort plumbing stays uniform with prefetch,
      // where the same signal is genuinely live mid-turn.
      abortSignal: host.run.currentAbortController?.signal,
    });
  }
  host.emitEvent("agent:stop", { reason });
  // Clear the run scope in a LATER task, not now.
  //
  // Teardown outlives the run it tears down: a cancelled tool's `onAfterToolCall` —
  // and, in the pump path, the `turn:summary` that reports the run — is delivered
  // after `agent:stop`, so clearing synchronously here wrote those entries with NO
  // `run` at all (observed: the cancelled `run_command`'s `tool-end` was the only
  // line in the session log without a run id). Deferring keeps a late entry inside
  // the run that produced it while still clearing before the next run, which stamps
  // a fresh id with `setRun` anyway.
  //
  // A microtask is enough for the pump path (`emitEvent` dispatches synchronously, so
  // `turn:summary` lands before this checkpoint); the `setRun` in `prepareManagedAgent`
  // is the backstop for anything slower, since it overwrites unconditionally.
  host.setCurrentRunId(null);
  queueMicrotask(() => {
    host.log?.setRun(null);
  });
}

export function abortManagedAgentRun(host: RunLifecycleHost, reason?: string): void {
  // "(no reason)" when the caller stated none. `RunCoordinator.abort` now forwards the
  // reason to the controller, so it reaches child subagent signals, which read it to say
  // *why* they stopped. A caller that rushes to default `"user-cancelled"` here would
  // relabel the run-lifecycle reset (a restart) as an operator cancel — the misattribution
  // this wiring removes; the actual Esc path passes `"user-cancelled"` explicitly.
  const effectiveReason = reason ?? "(no reason)";
  host.emitEvent("agent:abort", { reason: effectiveReason });
  host.run.abort(effectiveReason);
  // The status flip normally already happened in the abort listener above (it fires
  // synchronously inside `run.abort()`). This remainder covers the no-controller path: an
  // agent that never prepared a run has no listener to fire, so an explicit abort still
  // records the status. Same predicate as the listener, for the same reason — and both must
  // match, or one of them undoes the other (an `error` agent was being relabelled `aborted`
  // here once the listener stopped pre-empting it).
  if (isActiveStatus(host.getStatus())) {
    host.setStatus("aborted");
  }
}
