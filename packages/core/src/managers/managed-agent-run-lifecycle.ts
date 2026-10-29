/**
 * Prepare / finalize / abort run lifecycle for {@link ManagedAgent}.
 */

import { type UIMessage as TanStackUIMessage, type ModelMessage } from "@tanstack/ai";

import { isToolContinuationPrepare } from "../agent/stream/tool-phase-utils.js";
import { lastGenuineUserText } from "../agent/turn-context/turn-context-message.js";
import { isActiveStatus } from "../runtime-types/agent-status.js";

import type { AgentStatus, RunFinalizeReason } from "./agent-types.js";
import type { RunCoordinator } from "./run-coordinator.js";
import type { CompactionService } from "./services/compaction-service.js";
import type { MemoryService } from "./services/memory-service.js";
import type { EmitAgentTelemetryFn } from "./telemetry/emit-agent-telemetry.js";
import type { UsageTracker } from "./telemetry/usage-tracker.js";
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
  setStatus: (status: AgentStatus, trigger?: string) => void;
  /** Track the active run id (log run-scoping); pass null to clear. */
  setCurrentRunId: (runId: string | null) => void;
  recordStreamDuration: () => void;
  consumePrepareAsContinuation: () => boolean;
  clearPrepareAsContinuation: () => void;
  /** A pump started without a user prompt (background-completion wake) — new run scope, no hooks. */
  consumePrepareAsNewTurn: () => boolean;
  beginTurnFinalize: () => boolean;
  getStreamStartedAt: () => number;
  setStreamStartedAt: (value: number) => void;
  persistSession: () => void;
  clearTurnContext: () => void;
  getMessagesForLLM: (canon?: ModelMessage[]) => ModelMessage[];
  collectExtensionPromptHooks: (prompt: string) => Promise<void>;
  emitEvent: EmitAgentTelemetryFn;
  resolveTextAdapter?: () => Promise<TextAdapterConfig | null>;
  usage: UsageTracker;
  getUI?: () => AgentUIChannel | undefined;
  run: RunCoordinator;
  getCompaction(): CompactionService;
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
        host.setStatus("aborted", "run-abort");
      }
    },
  });
  host.getCompaction().resetReactiveCompactRetries();
  // A previous phase's truncation escalation is not this phase's budget.
  host.run.resetMaxOutputTokensOverride();

  // Always consume the flags (avoid `||` short-circuit leaving a stale mark behind).
  const forcedNewTurn = host.consumePrepareAsNewTurn() === true;
  const flaggedContinuation = host.consumePrepareAsContinuation() === true;
  // A wake turn runs with the previous assistant message last, so the message-derived rule would
  // classify it as a tool continuation. It is a NEW turn (own `runId`, own turn boundaries), just
  // one without a prompt — see `markNextPrepareAsNewTurn`.
  const isToolContinuation =
    !forcedNewTurn && (isToolContinuationPrepare(host.getStatus(), options.messages) || flaggedContinuation);
  // Remember it for the finalizer: a turn with no prompt skips memory extraction (nothing the user
  // said to remember, and the notification + reply are not worth a side query).
  if (forcedNewTurn) {
    host.run.setPromptlessTurn(true);
  }
  if (!isToolContinuation || host.getStreamStartedAt() === 0) {
    host.setStreamStartedAt(Date.now());
  }

  // Run scope: one short id per user turn (tool continuations keep the same id).
  if (!isToolContinuation) {
    const runId = Math.random().toString(36).slice(2, 10);
    host.setCurrentRunId(runId);
    // Emitted AFTER the id exists: a wake turn has no `prompt:submit`, so this row is the only
    // explanation of why the agent is working, and it has to slice with the run it explains.
    if (forcedNewTurn) {
      // Debug-level on purpose — it explains a run without being part of the readable story.
      host.emitEvent("run:wake", { cause: "job" });
    }
  }

  if (!isToolContinuation && !forcedNewTurn && !host.parentId) {
    // The user's ask, when this run has one: a run started from `messages` (resume, queued send,
    // wake) carries no `prompt` string, and both consumers below used to receive the literal
    // placeholder "(structured)" — every prompt row claimed a 12-byte prompt and an extension's
    // `before_agent_start` hook got the placeholder instead of what the user said.
    const userMsg =
      (typeof options.prompt === "string" ? options.prompt : undefined) ??
      lastGenuineUserText(host.getUI?.()?.getMessages() ?? []);

    // Extension hooks once per user turn — consumed by the turn-context middleware
    // at onConfig (injection happens after compaction, against the real wire payload).
    // A wake turn is skipped: there is no user prompt, so `before_agent_start` / memory selection
    // would be handed nothing to select against.
    if (userMsg) await host.collectExtensionPromptHooks(userMsg);

    if (userMsg) {
      host.emitEvent("prompt:submit", {
        prompt: userMsg,
        contextMessageCount: (host.getUI?.()?.getMessages() ?? inputMessages).length,
      });
    }
  }
}

export function finalizeManagedAgentRun(host: RunLifecycleHost, reason: RunFinalizeReason): boolean {
  // Idempotent per turn — pump `stop()` and outcome paths may both attempt finalize.
  if (!host.beginTurnFinalize()) return false;

  host.clearPrepareAsContinuation();
  host.recordStreamDuration();
  host.persistSession();
  host.clearTurnContext();
  // Always consume: a wake turn that was aborted must not leave the mark for the NEXT turn.
  const promptless = host.run.consumePromptlessTurn();
  if (reason === "finished" && !promptless) {
    host.memory.runExtraction({
      getMessagesForLLM: () => host.getMessagesForLLM(),
      onSideQuery: (event) => {
        const { type, ...payload } = event;
        host.emitEvent(type, payload as never);
      },
      // Extraction and consolidation are real LLM spend; the tracker is what makes it
      // show up in the session's lifetime totals.
      usage: host.usage,
      resolveTextAdapter: host.resolveTextAdapter,
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
  // after `agent:stop`, so clearing synchronously here stamped those entries with no
  // run at all (observed: the cancelled `run_command`'s `tool-end` was the only line
  // in the session log without a run id). Deferring keeps a late entry inside the run
  // that produced it while still clearing before the next run, which stamps a fresh id
  // with `setCurrentRunId` in `prepareManagedAgentForRun` anyway.
  //
  // A microtask is enough for the pump path (`emitEvent` dispatches synchronously, so
  // `turn:summary` lands before this checkpoint); the `setCurrentRunId` in prepare is
  // the backstop for anything slower, since it overwrites unconditionally.
  queueMicrotask(() => {
    host.setCurrentRunId(null);
  });
  return true;
}

export function abortManagedAgentRun(host: RunLifecycleHost, reason?: string): void {
  // "(no reason)" when the caller stated none. `RunCoordinator.abort` now forwards the
  // reason to the controller, so it reaches child subagent signals, which read it to say
  // *why* they stopped. A caller that rushes to default `"user-cancelled"` here would
  // relabel the run-lifecycle reset (a restart) as an operator cancel — the misattribution
  // this wiring removes; the actual Esc path passes `"user-cancelled"` explicitly.
  const effectiveReason = reason ?? "(no reason)";
  // An abort is only a fact when a run (or a turn parked on the user) exists. Destroying an idle
  // agent used to write `agent:abort` anyway: every normal shutdown produced a `warn` row
  // ("Agent aborted (Agent destroyed)") that read as a fault, and it dwarfed real cancels
  // (measured: 459 rows across 390 logs vs 58 `user-cancelled`). The signal is still aborted below
  // — that is what cancels in-flight work such as memory extraction.
  const hadRun = isActiveStatus(host.getStatus());
  if (hadRun) host.emitEvent("agent:abort", { reason: effectiveReason });
  host.run.abort(effectiveReason);
  // The status flip normally already happened in the abort listener above (it fires
  // synchronously inside `run.abort()`). This remainder covers the no-controller path: an
  // agent that never prepared a run has no listener to fire, so an explicit abort still
  // records the status. Same predicate as the listener, for the same reason — and both must
  // match, or one of them undoes the other (an `error` agent was being relabelled `aborted`
  // here once the listener stopped pre-empting it).
  if (isActiveStatus(host.getStatus())) {
    host.setStatus("aborted", "run-abort");
  }
}
