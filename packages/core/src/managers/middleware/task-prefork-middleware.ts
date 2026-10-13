/**
 * Eagerly start `task` subagents while the model streams.
 *
 * Since `@tanstack/ai` 0.64, `chat()` runs a turn's server tools in parallel. A model
 * emitting N `task` calls finishes streaming ALL of their arguments before the tool
 * phase begins. This middleware watches `TOOL_CALL_END` for `task` calls and spawns the
 * subagent right away, so the pre-fork is the concurrency throttle + eager start (not a
 * serial-execution workaround); the tool phase later joins the already-running promise
 * via the task tool (task-prefork.ts).
 *
 * Epoch hygiene. TanStack fires `RUN_STARTED` once per model **iteration**, not once per
 * run (`lifecycle-middleware` relies on the same fact for per-round timing), so a single
 * recovered run streams many `RUN_STARTED`s. A pre-fork started on iteration N is joined
 * by the tool phase that follows iteration N — the very next `RUN_STARTED` is therefore an
 * ordinary boundary, and discarding registered runs there aborted a healthy pre-fork that
 * was about to be joined, leaving it orphaned in the subagent catalog while the tool phase
 * spawned a second subagent for the same call id. Pre-forks are discarded only where the
 * attempt is actually over: the run boundaries (`onFinish` / `onAbort` / `onError`) and the
 * restart-style recovery path, where the tool phase that would have joined them can no
 * longer arrive.
 *
 * Pause hygiene — the second generation of the same mistake. A run boundary is not the end of a
 * `chat()` INVOCATION: an approval or client-tool wait ends the invocation (TanStack ends the stream
 * on that interrupt), and `AgentChatController` re-pumps once the answer arrives, so `onFinish` fires
 * while the run has only paused. Discarding there threw away pre-forks the next pump's tool phase
 * would have joined; the tool phase then found nothing registered (`join` returns null) and spawned a
 * SECOND subagent for the same call id, while the predecessor stayed in the subagent catalog — which
 * is why one `task` call showed two rows. So `onFinish` discards only when no joining tool phase is
 * still pending (`hasPendingRunContinuation`), the stream's abandonment hooks (`onAbort`/`onError`)
 * discard unconditionally, and the AGENT's abandonment seats do too — `abort()` (which a paused
 * session switch reaches through `stopIfActive`'s guard) and `reset()`. Those seats are what covers a
 * run abandoned while PAUSED, because a wait has already ended the invocation `onAbort` would need.
 */

import { hasPendingRunContinuation } from "../../agent/stream/tool-phase-utils.js";
import { runSubagent, subagentResultToTaskOutput } from "../../agent/subagent/run-subagent.js";
import {
  discardRegisteredPrefork,
  getTaskPreforkCoordinator,
  type PreforkDiscardCause,
} from "../../agent/subagent/task-prefork.js";
import { SUBAGENT_NO_TRUNCATE } from "../../agent/subagent/types.js";
import { generateId } from "../../utils/generate-id.js";

import { defineMiddleware } from "./phase.js";

import type { ToolRunContext } from "../../agent/runner/run-context.js";
import type { AgentUIChannel, ManagedAgent, AgentManager } from "../../runtime-types";
import type { EmitAgentTelemetryFn } from "../telemetry/emit-agent-telemetry.js";
import type { ChatMiddleware } from "@tanstack/ai";

export interface TaskPreforkMiddlewareDeps {
  getManagedAgent: () => ManagedAgent | undefined;
  manager: AgentManager;
  /** Emits `agent:tool-start` when a queued run acquires a slot. */
  emitEvent?: EmitAgentTelemetryFn;
  /** Mirrors finished pre-forked results into the UI before the executor joins them. */
  getUIChannel?: () => AgentUIChannel | null | undefined;
}

interface PendingTaskCall {
  /** Args accumulated from TOOL_CALL_ARGS deltas. */
  argsText: string;
}

export function createTaskPreforkMiddleware(deps: TaskPreforkMiddlewareDeps): ChatMiddleware<ToolRunContext> {
  // `pendingCalls` accumulates args within ONE model iteration and is disarmed at each
  // `RUN_STARTED`; registered pre-forks outlive iterations and are discarded only at the
  // run boundaries.
  let pendingCalls = new Map<string, PendingTaskCall>();

  const discardRegistered = (managed: ManagedAgent, cause: PreforkDiscardCause) => {
    // Report what the discard actually threw away. The record carries the subagents already
    // spawned for the call — which are the ones this turns into orphans. Dropping that list
    // is what used to make the orphan indistinguishable from an unrelated subagent in the log.
    discardRegisteredPrefork(managed, cause, (discard) => {
      deps.emitEvent?.("subagent:prefork-discarded", {
        toolCallId: discard.toolCallId,
        cause: discard.cause,
        subagentIds: discard.subagentIds,
      });
    });
  };

  return defineMiddleware("tools", {
    name: "task-prefork",
    onChunk: (_ctx, chunk) => {
      const managed = deps.getManagedAgent();
      if (!managed) return chunk;

      if (chunk.type === "RUN_STARTED") {
        // A NEW model iteration is starting: the previous iteration's unfinished args will
        // never be resumed (they belong to a stream that has ended), so drop the bookkeeping.
        //
        // Registered pre-forks are deliberately LEFT ALONE. Reaching `RUN_STARTED` again
        // inside one run means one of two things, and neither is a dead attempt:
        //
        // - the next model iteration, whose tool phase is about to `join` what is registered
        //   (discarding it here is what orphaned a healthy pre-fork — this event is
        //   per-iteration, not per-run), or
        // - a restart, whose `abortAll` the recovery path performs itself at
        //   `prepareRestartStyleRetry`, where a restart is actually known to be happening.
        //
        // The run boundaries and the restart path are the only discard points; see
        // `discardRegisteredPrefork`.
        pendingCalls = new Map();
        return chunk;
      }

      if (chunk.type === "TOOL_CALL_START") {
        if ((chunk.toolName ?? chunk.toolCallName) === "task") {
          pendingCalls.set(chunk.toolCallId, { argsText: "" });
        }
        return chunk;
      }

      if (chunk.type === "TOOL_CALL_ARGS") {
        const pending = pendingCalls.get(chunk.toolCallId);
        if (pending && typeof chunk.delta === "string") {
          pending.argsText += chunk.delta;
        }
        return chunk;
      }

      if (chunk.type === "TOOL_CALL_END") {
        const pending = pendingCalls.get(chunk.toolCallId);
        if (pending) {
          trySpawn(deps, managed, chunk.toolCallId, pending, chunk.input);
        }
      }

      return chunk;
    },
    onFinish: async () => {
      const managed = deps.getManagedAgent();
      pendingCalls = new Map();
      if (!managed) return;
      // `onFinish` ends this `chat()` INVOCATION, which a wait also produces — so the discard has to
      // ask whether a joining tool phase is still coming (see the header). Read the channel that
      // actually carries approval state: `ChatMiddlewareContext.messages` is the ModelMessage wire
      // and has none, and `onFinish`'s info is only finishReason/duration/content/usage. The chat
      // controller's chain is the same object as the agent's UI channel
      // (`AgentChatController` calls `setUIChannel(this.channel)`); reading the controller first is
      // the convention this repo uses for "the live chain" (see `ManagedAgent.getMessagesForLLM`).
      //
      // No channel at all is read as "not over": a stranded run can still be reached by an abort,
      // while a run discarded on a guess cannot be recovered.
      const messages =
        managed.getChatController()?.getMessages() ??
        managed.getUI()?.getMessages() ??
        deps.getUIChannel?.()?.getMessages();
      if (!messages || hasPendingRunContinuation(messages)) return;
      discardRegistered(managed, "run-finish");
    },
    // Abandonment boundaries discard UNCONDITIONALLY: an abort or an error means the pump that would
    // have joined these pre-forks is not coming, whatever the message state happens to say.
    onAbort: async () => {
      const managed = deps.getManagedAgent();
      pendingCalls = new Map();
      if (managed) discardRegistered(managed, "run-abort");
    },
    // A run that ends in an error ends the same way as a clean one: the tool phase that
    // would have joined the registered pre-forks is not coming, so they would keep running
    // unobserved. Without this the error path was the one boundary that leaked.
    onError: async () => {
      const managed = deps.getManagedAgent();
      pendingCalls = new Map();
      if (managed) discardRegistered(managed, "run-error");
    },
  });
}

/**
 * Parse the streamed args and pre-fork the subagent. Any parse failure simply
 * skips pre-forking — the task tool then runs serially at execute time.
 */
function trySpawn(
  deps: TaskPreforkMiddlewareDeps,
  managed: ManagedAgent,
  toolCallId: string,
  pending: PendingTaskCall,
  endInput: unknown
): void {
  let prompt: string | undefined;
  let description: string | undefined;

  const direct = endInput as { prompt?: unknown; description?: unknown } | undefined;
  if (direct && typeof direct === "object" && typeof direct.prompt === "string") {
    prompt = direct.prompt;
    if (typeof direct.description === "string") description = direct.description;
  } else {
    try {
      const parsed = JSON.parse(pending.argsText) as { prompt?: unknown; description?: unknown };
      if (typeof parsed.prompt === "string") prompt = parsed.prompt;
      if (typeof parsed.description === "string") description = parsed.description;
    } catch {
      return;
    }
  }
  if (!prompt?.trim()) return;

  const coordinator = getTaskPreforkCoordinator(managed);
  // Tie the subagent to the parent's current run so a parent abort cascades.
  const controller = new AbortController();
  const parentSignal = deps.manager.getAgent(managed.id)?.run.currentAbortController?.signal;
  // Forward the parent's abort *reason*, not just the abort: the subagent reads
  // `signal.reason` to say why it stopped (a user cancel vs the parent run moving on vs the
  // parent agent stopping). `() => controller.abort()` dropped it, so every cascaded stop
  // reached the subagent reasonless and was reported as a user cancellation.
  const onParentAbort = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  const started = coordinator.start(
    toolCallId,
    () => controller.abort(),
    () =>
      runPreForked(deps, managed.id, toolCallId, { prompt: prompt as string, description }, controller, () =>
        parentSignal?.removeEventListener("abort", onParentAbort)
      ),
    // Fires when the queued run actually acquires a concurrency slot.
    () => {
      deps.emitEvent?.("agent:tool-start", {
        tool_name: "task",
        tool_call_id: toolCallId,
        tool_input: { prompt, description },
        // Tells the eager start apart from the tool-phase start of the same call id —
        // the second line used to be byte-identical, which is why a discarded-then-
        // respawned pair read as one doubled log line instead of a respawn.
        source: "prefork",
        timestamp: Date.now(),
      });
    }
  );
  if (!started) {
    // A duplicate id — the pre-fork for this call is already registered, so this spawn is a
    // no-op and its own parent-signal listener would leak. Disarm it. (The tool phase joins
    // the registered entry by call id, so nothing else is needed here.)
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

async function runPreForked(
  deps: TaskPreforkMiddlewareDeps,
  parentAgentId: string,
  toolCallId: string,
  args: { prompt: string; description?: string },
  controller: AbortController,
  cleanup: () => void
): ReturnType<typeof runSubagent> {
  // The parent's own `ManagedAgent` — also the handle on the run's abort surface below.
  const managed = deps.getManagedAgent?.();
  try {
    // Pre-allocate the id so the coordinator can record it before the run starts: a spawn
    // that is discarded while queued never reaches `runSubagent`, and one discarded right
    // after starting must still be reportable as an orphan.
    const subagentId = generateId("subagent", { exists: (id) => deps.manager.getAgent(id) != null });
    if (managed) getTaskPreforkCoordinator(managed).recordSpawn(toolCallId, subagentId);

    // Register with the RUN's abort surface, not only with the signal captured at spawn time.
    //
    // A pre-fork that outlives the invocation it was born in is no longer covered by its
    // `parentSignal` listener: each pump installs a fresh `RunCoordinator.currentAbortController`
    // (`setupAbortController`) and merely DETACHES the previous one's listeners, so that signal
    // never fires. `addPendingAbortController` is the surface that does survive a pump boundary —
    // `RunCoordinator.abort()` and the host-supplied `abortSignal` both drain it.
    //
    // Belt and braces with `ManagedAgent.cascadeAbortToChildren`, which reaches an active child by
    // lookup even through a stale signal (which is why a user stop already worked); what this adds
    // is the run-level abort that does not cascade to children at all.
    //
    // Registered here, at ADMISSION, rather than at spawn: a pre-fork discarded while still queued
    // never reaches this function, and would otherwise register a controller nothing ever
    // deregisters.
    managed?.addPendingAbortController(controller);

    const result = await runSubagent(
      {
        subagentId,
        prompt: args.prompt,
        description: args.description,
        parentAgentId,
        parentTaskToolCallId: toolCallId,
        autoDestroy: false,
        maxOutputLength: SUBAGENT_NO_TRUNCATE,
        abortSignal: controller.signal,
      },
      { manager: deps.manager }
    );
    // Mirror the finished result into the UI immediately — TanStack batches
    // authoritative TOOL_CALL_END chunks until ALL tools finish, so a task
    // completing before its siblings would otherwise stay a spinner.
    if (!result.aborted) {
      deps.getUIChannel?.()?.addToolResult(toolCallId, subagentResultToTaskOutput(result));
    }
    return result;
  } finally {
    // A no-op for a controller that was never registered (a throw before the registration).
    managed?.removePendingAbortController(controller);
    cleanup();
  }
}
