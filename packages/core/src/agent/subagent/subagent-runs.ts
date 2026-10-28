/**
 * One owner for a parent agent's per-task run bookkeeping.
 *
 * A `task` call carries two kinds of client-side state: its **phase** (`running` → `summary` |
 * `limit`, read by the subagent rows) and its **pre-fork seat** (the eagerly started run, its abort
 * handle and the subagents it already spawned). They used to live in two independent
 * `WeakMap<ManagedAgent, …>` registries, so nothing could clear "this parent's task state" in one
 * call — and nothing did: the phase map simply grew for the life of the agent, across `/new` and
 * `/resume`, because its only cleanup function had no production caller.
 *
 * ## Why the phase outlives the task but not the session
 *
 * A subagent agent is deliberately **not destroyed** when its task ends (`autoDestroy: false`): the
 * task panel keeps the preview, and `subagent-summaries` reads the phase for that row. Clearing the
 * phase at task end would make a lingering child read as `running` again — a wrong row, not a leak
 * fix. So the phase lives until the **session** ends; `clear()` (called from the session-switch
 * transaction) drops the whole map and aborts any seat still registered for the conversation being
 * left.
 */

import { resolveMaxConcurrentTasks, TaskPreforkCoordinator } from "./task-prefork.js";
import { TaskRunState } from "./task-run-state.js";

import type { PreforkDiscard, PreforkDiscardCause } from "./task-prefork.js";
import type { TaskRunPhase, TaskRunTerminalPhase } from "./task-run-state.js";
import type { ManagedAgent } from "../../runtime-types/hosts.js";

export class SubagentRuns {
  /** The per-parent seat scheduler (concurrency window + eager runs). */
  readonly prefork: TaskPreforkCoordinator;
  private readonly phases = new Map<string, TaskRunState>();

  constructor(getMaxActive: () => number) {
    this.prefork = new TaskPreforkCoordinator(getMaxActive);
  }

  /** Number of task phase records (test/observability). */
  get size(): number {
    return this.phases.size;
  }

  /** Register (or fetch) the state machine for a task call in the `running` phase. */
  begin(toolCallId: string): TaskRunState {
    const existing = this.phases.get(toolCallId);
    if (existing) return existing;
    const state = new TaskRunState(toolCallId);
    this.phases.set(toolCallId, state);
    return state;
  }

  state(toolCallId: string): TaskRunState | undefined {
    return this.phases.get(toolCallId);
  }

  /** Move a task to a terminal phase; true only when THIS call performed the transition. */
  enter(toolCallId: string, phase: TaskRunTerminalPhase): boolean {
    if (!toolCallId) return false;
    return this.begin(toolCallId).enterPhase(phase);
  }

  /** Current phase (default `running` for an unknown task). */
  read(toolCallId: string | undefined): TaskRunPhase {
    if (!toolCallId) return "running";
    return this.phases.get(toolCallId)?.phase ?? "running";
  }

  /** Drop one task's phase (its child was destroyed, so no row reads it any more). */
  forget(toolCallId: string): void {
    this.phases.delete(toolCallId);
  }

  /** End of a conversation: drop every phase and abort any seat still registered. */
  clear(): void {
    this.phases.clear();
    // Idempotent: the switch transaction already aborts the run (which discards seats). This is
    // the belt-and-braces for a seat registered while the conversation is idle.
    this.prefork.abortAll();
  }
}

const registries = new WeakMap<ManagedAgent, SubagentRuns>();

/** Get (or lazily create) the run registry for a parent agent. */
export function subagentRuns(parentManaged: ManagedAgent): SubagentRuns {
  let runs = registries.get(parentManaged);
  if (!runs) {
    // Read the cap through the parent so an `updateConfig` after creation is honored.
    runs = new SubagentRuns(() => resolveMaxConcurrentTasks(parentManaged));
    registries.set(parentManaged, runs);
  }
  return runs;
}

/** The run registry for a parent, when one already exists (non-creating). */
export function peekSubagentRuns(parentManaged: ManagedAgent): SubagentRuns | undefined {
  return registries.get(parentManaged);
}

// ============================================================================
// Phase accessors (thin, so call sites read as before)
// ============================================================================

export function getTaskRunState(parentManaged: ManagedAgent, toolCallId: string): TaskRunState | undefined {
  return subagentRuns(parentManaged).state(toolCallId);
}

export function beginTaskRun(parentManaged: ManagedAgent, toolCallId: string): TaskRunState {
  return subagentRuns(parentManaged).begin(toolCallId);
}

export function enterTaskPhase(parentManaged: ManagedAgent, toolCallId: string, phase: TaskRunTerminalPhase): boolean {
  return subagentRuns(parentManaged).enter(toolCallId, phase);
}

/** Move a task to the `summary` phase (the subagent is writing its own report). */
export function enterTaskSummaryPhase(parentManaged: ManagedAgent, toolCallId: string): boolean {
  return enterTaskPhase(parentManaged, toolCallId, "summary");
}

/** Move a task to the `limit` phase (budget cutoff; report comes from the fallback). */
export function enterTaskLimitPhase(parentManaged: ManagedAgent, toolCallId: string): boolean {
  return enterTaskPhase(parentManaged, toolCallId, "limit");
}

export function readTaskRunPhase(parentManaged: ManagedAgent, toolCallId: string | undefined): TaskRunPhase {
  return subagentRuns(parentManaged).read(toolCallId);
}

/** Drop finished bookkeeping (one task, or every task of the parent). */
export function clearTaskRuns(parentManaged: ManagedAgent, toolCallId?: string): void {
  const runs = peekSubagentRuns(parentManaged);
  if (!runs) return;
  if (toolCallId) runs.forget(toolCallId);
  else runs.clear();
}

/**
 * Session switch / new: the conversation these task rows belonged to is gone.
 *
 * Non-creating — an agent that never ran a task must not gain a registry just to clear it.
 */
export function clearSubagentRuns(parentManaged: ManagedAgent): void {
  peekSubagentRuns(parentManaged)?.clear();
}

/** Test/observability seam: how many task phase records this parent still holds. */
export function countSubagentRuns(parentManaged: ManagedAgent): number {
  return peekSubagentRuns(parentManaged)?.size ?? 0;
}

// ============================================================================
// Pre-fork accessors (same registry, so one clear drops both halves)
// ============================================================================

/** Get (or lazily create) the pre-fork coordinator for a parent agent. */
export function getTaskPreforkCoordinator(parentManaged: ManagedAgent): TaskPreforkCoordinator {
  return subagentRuns(parentManaged).prefork;
}

/**
 * The pre-fork coordinator for a parent, or `undefined` when none exists yet.
 *
 * Non-creating, unlike {@link getTaskPreforkCoordinator}: a reader that only wants to know whether a
 * call is already pre-forked (the extensions middleware deferring its eager `agent:tool-start`) must
 * not bring a coordinator into existence for an agent that never pre-forked anything.
 */
export function peekTaskPreforkCoordinator(parentManaged: ManagedAgent): TaskPreforkCoordinator | undefined {
  return peekSubagentRuns(parentManaged)?.prefork;
}

/**
 * Discard every registered pre-fork, and report each one to the log bridge.
 *
 * The one place registered runs may be thrown away, so every producer of a discard goes through it.
 * The seats are listed here as one inventory because they do not share a call path:
 *
 * - the stream boundaries `onFinish` (only when nothing is pending) / `onAbort` / `onError`;
 * - `ManagedAgent.abort()` — every run abort funnels through it (Esc, force-submit, a host stop,
 *   destroy), and a session switch reaches it too while PAUSED, via `stopIfActive`'s guard;
 * - `ManagedAgent.discardPreforkRuns("run-finish")` — the pump finalizing a turn whose only pending
 *   call could not run, i.e. the case `onFinish` deferred to a join that never came;
 * - `ManagedAgent.reset()` — a session switch or `/new` rewinds the run state without an agent abort;
 * - the restart-style recovery path (which ends the attempt that spawned them — see
 *   `prepareRestartStyleRetry`).
 *
 * The agent-level seats exist because PAUSED is the state a stream hook cannot describe: a wait ends
 * the `chat()` invocation, so `onAbort` never fires for a run abandoned in that window.
 *
 * Two ways this has been called too eagerly. Both orphan a HEALTHY run — the aborted subagent stays
 * in the catalog while the tool phase, finding nothing registered, spawns a second one for the same
 * call id:
 *
 * - on `RUN_STARTED`, which fires once per model **iteration**: iteration N+1's boundary aborted a
 *   pre-fork that iteration N's tool phase was about to join;
 * - on an `onFinish` that merely ends a PAUSING invocation. An approval or client-tool wait ends the
 *   `chat()` invocation and the controller re-pumps after it, so the joining tool phase is still
 *   coming. The caller must therefore ask `hasPendingRunContinuation` first and reach this function
 *   only when nothing is pending. The abandonment boundaries (`onAbort`/`onError`) need no such
 *   check: there the pump is genuinely not coming.
 */
export function discardRegisteredPrefork(
  managed: ManagedAgent,
  cause: PreforkDiscardCause,
  emit: (discard: PreforkDiscard) => void = () => {}
): void {
  for (const discard of getTaskPreforkCoordinator(managed).abortAll(cause)) {
    emit(discard);
  }
}
