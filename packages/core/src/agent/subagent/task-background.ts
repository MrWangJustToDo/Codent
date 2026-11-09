/**
 * The lifecycle half of a `run_in_background` task: start, settle, repair, and the interrupted hand-off.
 *
 * The source that projects `SubagentRuns` onto the background-work trunk's port lives in
 * `task-work-source.ts` (this module only runs a task and writes its outcome back). Two rules shape
 * everything here:
 *
 * 1. **{@link startBackgroundTask}** hands a `task` call to a detached pre-fork seat and, when that run
 *    settles, writes the outcome back into the tool part and records the completion. It does NOT
 *    publish to the jobs channel, does NOT wake the agent and does NOT inject anything: `finished`
 *    from the ledger drives all three through the owning agent's single change handler.
 * 2. **The write-back is replayable** ({@link reconcileSettledTaskParts}) **and the restore path can
 *    close it out** ({@link cancelInterruptedBackgroundTasks}).
 *
 * Why the write-back exists at all: the tool returned a `running` handle immediately, so the part the
 * model/user sees would otherwise stay a spinner forever. `addToolResult` is not UI-only — the next
 * turn's wire re-projects the part's output through the tool's own `toModelOutput`
 * (`tool-compact`), so the summary also lands in its natural position. That does not remove the need
 * for the notification: a live run's next model call does not re-read the channel, and a compaction may
 * have dropped this call entirely.
 *
 * Why it has a second half: the framework writes a whole tool phase's results when the batch ends, so
 * a task that settles while a sibling tool still runs is overwritten by its own `running` handle
 * (`reconcileSettledTaskParts` replays the settled payload from the ledger at the next model call).
 */

import { isBusyStatus } from "../../runtime-types/agent-status.js";
import { errorMessage } from "../../utils/errors.js";
import { SESSION_END_CANCELLED_MESSAGE } from "../jobs/background-work.js";
import { settleToolCallsAs } from "../stream/incomplete-tool-calls.js";
import { findToolCallPart } from "../stream/suppress-replayed-tool-chunks.js";
import { BUILTIN_TOOL_NAMES } from "../tools/catalog/tool-names.js";
import { getBuiltinToolPresentation } from "../tools/presentation/builtin.js";
import { computeToolDisplay } from "../tools/presentation/compute-display.js";

import { subagentRuns, peekSubagentRuns } from "./subagent-runs.js";
import {
  buildTaskOutput,
  failedTaskOutput,
  formatTaskModelText,
  interruptedTaskOutput,
  isRunningTaskOutput,
} from "./task-output.js";

import type { SubagentRuns } from "./subagent-runs.js";
import type { SubagentResult } from "./types.js";
import type { ResolvedCoreEnv } from "../../env";
import type { ManagedAgent } from "../../runtime-types/hosts.js";
import type { BackgroundWorkTerminalStatus } from "../jobs/background-work.js";
import type { ToolDisplayPayload } from "../tools/presentation/types.js";
import type { UIMessage } from "@tanstack/ai";

// ============================================================================
// Start / settle
// ============================================================================

export interface StartBackgroundTaskInput {
  /** The parent agent that owns the run and its ledger row. */
  managed: ManagedAgent;
  coreEnv: ResolvedCoreEnv;
  toolCallId: string;
  /** Human label for the footer row and the notification (description, else the prompt's head). */
  label: string;
  /** The call's own input, so the display payload renders exactly like a blocking task's. */
  input: unknown;
  /**
   * Serial spawn, used only when no pre-fork seat is registered for this call (the middleware
   * normally spawned one at `TOOL_CALL_END`). The signal is the background run's OWN controller — not
   * the parent run's — so a parent abort cannot kill work it was told to leave running.
   */
  spawn: (abortSignal: AbortSignal) => Promise<SubagentResult>;
}

/**
 * Hand a `task` call to the trunk and return without waiting.
 *
 * Ordering matters twice:
 *
 * - the ledger row is opened BEFORE the seat is detached, so the row exists by the time any change
 *   can be published (and the footer shows `running` from the first frame);
 * - the owning epoch is captured BEFORE the run is started, so a session switch that happens while the
 *   run is in flight is recognised at settle time and the result is dropped whole.
 *
 * Two guards, and they answer DIFFERENT questions — conflating them was a real defect:
 *
 * - **Epoch = ownership.** A switch bumps it (`SubagentRuns.reset()`); the row is already gone and the
 *   seat aborted, so there is nothing left to report into and the settle is dropped whole.
 * - **Switching in flight = transcript safety.** A write that lands mid-transaction would be persisted
 *   into whichever transcript the switch ends up on. That check gates the PART write only. It must not
 *   gate the ledger settle: a restore (even a FAILED `/resume`, which deliberately keeps background work
 *   alive) can re-hydrate the same session's channel, and dropping the completion then left a row
 *   `running` forever — no notification, no wake, and a footer counting work that had already finished.
 *
 * The settle itself is unconditional (`finally`): a footer row that never ends and an unhandled
 * rejection are the same bug seen from two sides, and `buildTaskOutput` really can throw (its disk
 * cache write goes through CoreEnv).
 */
export function startBackgroundTask(input: StartBackgroundTaskInput): void {
  const { managed, coreEnv, toolCallId, label } = input;
  const runs = subagentRuns(managed);
  const run = runs.beginBackground({ toolCallId, label });
  const epoch = run.epoch;

  let settled: Promise<SubagentResult>;
  try {
    settled = detachOrStart(runs, input);
  } catch (error) {
    // Registration refused: settle the row we just opened instead of handing back a handle nobody
    // holds, then report the failure to the model through the tool call.
    const message = `The background task could not be started: ${errorMessage(error)}`;
    settlePart(failedTaskOutput(message), { status: "failed", body: message });
    runs.prefork.forgetDetached(toolCallId);
    throw error;
  }

  // Both arms are observed: an unobserved rejection here would crash the host process (the pre-fork
  // coordinator documents the same hazard for its own settle promise).
  void settled.then(
    (result) => finalize(result),
    (error: unknown) => finalize(null, error)
  );

  async function finalize(result: SubagentResult | null, error?: unknown): Promise<void> {
    try {
      // Ownership guard: the conversation this row belongs to is gone.
      if (runs.currentEpoch !== epoch) return;

      if (!result) {
        reportFailure(
          `The background task failed before producing a summary: ${errorMessage(error ?? "unknown error")}`
        );
        return;
      }

      const output = await buildTaskOutput(coreEnv, toolCallId, result, { runInBackground: true });
      // The cache write above is async: a switch may have started while it ran.
      if (runs.currentEpoch !== epoch) return;

      settlePart(output, { status: taskStatusForResult(result), body: formatTaskModelText(output) });
    } catch (failure) {
      // Whatever went wrong, the row must not stay `running`: the transcript, the footer and the
      // notification are all derived from this one settle, and a stuck row is a screen that lies.
      reportFailure(`The background task finished but its result could not be recorded: ${errorMessage(failure)}`);
    } finally {
      runs.prefork.forgetDetached(toolCallId);
    }
  }

  /** Settle the part and the row as a failure (same two writes the happy path makes). */
  function reportFailure(message: string): void {
    if (runs.currentEpoch !== epoch) return;
    settlePart(failedTaskOutput(message), { status: "failed", body: message });
  }

  /**
   * Write the part, then record the SAME payload in the ledger.
   *
   * The ledger copy is what makes the write-back recoverable: the framework writes every batched
   * `TOOL_CALL_RESULT` when the whole tool phase ends, so a task that settles while a sibling tool is
   * still running is overwritten by the `running` handle it just replaced. The next model call repairs
   * it from here (`reconcileSettledTaskParts`) — outside that window the two writes never disagree.
   */
  function settlePart(output: unknown, row: { status: BackgroundWorkTerminalStatus; body: string }): void {
    const display = writePart(output);
    runs.settleBackground(toolCallId, { ...row, output, display }, epoch);
    // The settle is an ASYNC event outside the run. When the run that started this task has since
    // been aborted, `wakeForBackgroundCompletion` refuses (deliberately), so no pump and no
    // pump-complete persist follow — the channel write above would live only in memory. The next
    // restore would then see the on-disk `running` handle and mark a FINISHED task interrupted.
    // Persist here, under the same switch guard `writePart` uses. Only when no run is busy: a live
    // pump owns the next `pump-complete`, and writing its mid-stream transcript here would land a
    // partial assistant message on disk.
    const channel = managed.getUI?.();
    if (channel && managed.isSessionSwitching?.() !== true && !isBusyStatus(managed.getStatus())) {
      managed.maybeSaveSessionUIMessages?.(channel.getMessages(), "pump-complete");
    }
  }

  /**
   * Write the result into the tool part — the surface the user and the next turn read.
   *
   * `addToolResult` settles the part for BOTH readers: the row (output) and, next turn, the model wire
   * (re-projected through `toModelOutput`). The display payload has to be replaced explicitly — the one
   * attached for the running handle would otherwise persist, since it is a function of the output.
   *
   * Skipped while a switch is in flight: that write would land in the transcript the switch is about
   * to target. The completion still settles and still notifies, and the row keeps its payload — but a
   * switch CLEARS the ledger, so the repair pass cannot reach it either; the part is instead settled as
   * interrupted when that session is next restored (`cancelInterruptedBackgroundTasks`).
   */
  function writePart(output: unknown): ToolDisplayPayload | undefined {
    const channel = managed.getUI?.();
    if (!channel) return undefined;
    if (managed.isSessionSwitching?.()) return undefined;
    channel.addToolResult(toolCallId, output);
    return attachTaskDisplay(channel, toolCallId, output, input.input);
  }
}

/**
 * Take the run: an already registered pre-fork (the normal path — the middleware spawned it at
 * `TOOL_CALL_END`) or, when there is none, a seat started here and immediately detached.
 *
 * Both end up detached, which is what keeps run-lifecycle discards (`abortAll`) away from it: a
 * background task is only stopped by the session-switch path.
 */
function detachOrStart(runs: SubagentRuns, input: StartBackgroundTaskInput): Promise<SubagentResult> {
  const { toolCallId } = input;
  const detached = runs.prefork.detach(toolCallId);
  if (detached) return detached;

  const controller = new AbortController();
  runs.prefork.start(
    toolCallId,
    () => controller.abort("session-ended"),
    () => input.spawn(controller.signal)
  );
  const started = runs.prefork.detach(toolCallId);
  if (!started) {
    // A duplicate registration that was neither joined nor detached: refuse loudly rather than
    // reporting a running handle for a run nobody holds.
    throw new Error(`Background task ${toolCallId} could not be registered`);
  }
  return started;
}

/**
 * Render the task display payload for a settled output (same descriptor the blocking path uses).
 *
 * The payload is written even when it renders to NOTHING (`{}`), because "nothing" is itself an
 * answer: the row attached for the `running` handle summarizes as `running`, and leaving it in place
 * after the settle made a finished task read as in-progress forever (`display.summary` wins over the
 * host's own formatter). Clearing it lets the host fall back to the settled output.
 */
function attachTaskDisplay(
  channel: NonNullable<ReturnType<ManagedAgent["getUI"]>>,
  toolCallId: string,
  output: unknown,
  input: unknown
): ToolDisplayPayload {
  const display =
    computeToolDisplay(
      BUILTIN_TOOL_NAMES.task,
      output,
      input,
      (name) => channel.resolveToolPresentation?.(name) ?? getBuiltinToolPresentation(name)
    ) ?? {};
  channel.attachToolDisplay(toolCallId, display);
  return display;
}

// ============================================================================
// Row vocabulary, part repair, and the interrupted-session hand-off
// ============================================================================

/**
 * Map a finished subagent run onto the shared status vocabulary.
 *
 * `aborted` is a stop someone asked for (`killed`), while `incomplete` covers every bad end that is
 * not a cancel — budget cutoff, output truncation, error, empty summary — so it reads as `failed`.
 * Neither is `exited`: that word means "finished the work", and a task row that says so after a
 * budget cutoff would contradict the same result's `[task status: reachedLimit=true]`.
 *
 * Lives here rather than in `agent/jobs/background-work.ts` because it is the only task-shaped rule
 * on the trunk: the shared module must not import `SubagentResult` just to describe one kind.
 */
export function taskStatusForResult(
  result: Pick<SubagentResult, "aborted" | "incomplete">
): BackgroundWorkTerminalStatus {
  if (result.aborted) return "killed";
  if (result.incomplete) return "failed";
  return "exited";
}

/**
 * Re-apply a settled result whose tool part was overwritten by the framework's batched write.
 *
 * TanStack writes a whole tool phase's `TOOL_CALL_RESULT` chunks only when EVERY tool of that batch
 * has finished. A background task returns its `running` handle inside that phase, so the batched write
 * lands later — and a subagent that settles in between is overwritten by the handle it just replaced.
 * Nothing else would ever rewrite the part: the row reads `running`, the wire keeps telling the model
 * "do not poll, a completion will arrive", and the completion has already been delivered.
 *
 * Called at every model-call boundary (the pump, before it reads the channel), which is always after
 * the previous phase's batched write and always before the next wire projection. Cheap when nothing is
 * wrong: one ledger scan plus one part lookup per settled row.
 */
export interface TaskBackgroundHost {
  getUI?():
    | {
        getMessages(): UIMessage[];
        addToolResult(id: string, output: unknown): void;
        attachToolDisplay(id: string, display: ToolDisplayPayload): void;
      }
    | undefined;
  isSessionSwitching?(): boolean;
}

export function reconcileSettledTaskParts(managed: TaskBackgroundHost): void {
  const runs = peekSubagentRuns(managed);
  if (!runs) return;
  const channel = managed.getUI?.();
  if (!channel) return;
  if (managed.isSessionSwitching?.()) return;
  for (const run of runs.settledBackground()) {
    const part = findToolCallPart(channel.getMessages(), run.toolCallId);
    if (!part || !isRunningTaskOutput(part.output)) continue;
    channel.addToolResult(run.toolCallId, run.output);
    if (run.display) channel.attachToolDisplay(run.toolCallId, run.display);
  }
}

/**
 * Settle background start handles that cannot still be running: the session they belonged to ended.
 *
 * A `run_in_background` call writes its `running` handle into the part immediately, and the settle
 * write-back is dropped (by design) when a switch is in flight. The part is then persisted as
 * `running` while the ledger that would repair it is gone — so a restored transcript would show a
 * spinner that never ends and tell the model to wait for a completion that can never arrive.
 *
 * The generic settle pass skips any part that already carries an output (`isInFlightToolCall`), which
 * is exactly this shape. This is the task-specific half, called from the restore path BEFORE that
 * pass; it writes a task-shaped result (not the shared cancel marker, which the task's own
 * `toModelOutput` cannot render) carrying {@link SESSION_END_CANCELLED_MESSAGE}.
 */
export function cancelInterruptedBackgroundTasks(
  messages: UIMessage[],
  reason: string = SESSION_END_CANCELLED_MESSAGE
): UIMessage[] {
  return settleToolCallsAs(
    messages,
    (part) => part.name === BUILTIN_TOOL_NAMES.task && isRunningTaskOutput(part.output),
    reason,
    (_part, message) => interruptedTaskOutput(message)
  );
}
