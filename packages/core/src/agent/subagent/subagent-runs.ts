/**
 * One owner for a parent agent's per-task run bookkeeping.
 *
 * A `task` call carries three kinds of client-side state: its **phase** (`running` → `summary` |
 * `limit`, read by the subagent rows), its **pre-fork seat** (the eagerly started run, its abort
 * handle and the subagents it already spawned), and — since `run_in_background` exists — its
 * **background ledger row** (the seat handed to the background-work trunk: label, owner session,
 * completion body, delivered flag). They are deliberately one registry, because nothing else can
 * clear "this parent's task state" in one call.
 *
 * ## Why the phase outlives the task but not the session
 *
 * A subagent agent is deliberately **not destroyed** when its task ends (`autoDestroy: false`): the
 * task panel keeps the preview, and `subagent-summaries` reads the phase for that row. Clearing the
 * phase at task end would make a lingering child read as `running` again — a wrong row, not a leak
 * fix. So the phase lives until the **session** ends; {@link SubagentRuns.reset} (called from the
 * session-switch transaction) drops the whole map and aborts any seat still registered for the
 * conversation being left.
 *
 * ## Why the ledger needs an epoch and the command registry does not
 *
 * The command side gets its "a late callback must not resurrect a destroyed registry" guarantee from
 * `AgentCommandService.closing`: the service object is thrown away and the next session builds a new
 * one. This registry is cached in a `WeakMap` keyed by the parent agent, so `reset()` runs on the
 * SAME object the next session will use — a settle that lands after the switch would find a live
 * registry, record a completion into it, and publish a row into the target conversation's channel.
 * {@link SubagentRuns.currentEpoch} is that missing `closing`: a background run captures the epoch it
 * was started in, and a settle from an older epoch is dropped whole (no row, no completion, no wake).
 */

import { isVisibleToSession } from "../jobs/background-work.js";

import { resolveMaxConcurrentTasks, TaskPreforkCoordinator } from "./task-prefork.js";
import { TaskRunState } from "./task-run-state.js";

import type { PreforkDiscard, PreforkDiscardCause } from "./task-prefork.js";
import type { TaskRunPhase, TaskRunTerminalPhase } from "./task-run-state.js";
import type { ManagedAgent } from "../../runtime-types/hosts.js";
import type { SessionJobStatus } from "../../runtime-types/session-payloads.js";
import type { BackgroundWorkChangeSink, BackgroundWorkTerminalStatus } from "../jobs/background-work.js";
import type { ToolDisplayPayload } from "../tools/presentation/types.js";

/**
 * Settled rows kept after delivery, oldest evicted first.
 *
 * A row is the *source* of the repair pass (`reconcileSettledTaskParts`), which runs at the next
 * model call — the only window in which a settled part can have been overwritten by the framework's
 * batched tool result. The cap is therefore generous (a stale row costs nothing) while still
 * bounding a long session; it matches the command registry's finished-job retention.
 */
const MAX_SETTLED_BACKGROUND_ROWS = 50;

/**
 * One background (`run_in_background: true`) task run: the task-side row of the shared jobs ledger.
 *
 * `status` and `body` are the fields the shared snapshot and the completion notification need, in the
 * vocabulary both sources use — which is what lets the task side implement the trunk's port without
 * translating anything.
 */
export interface BackgroundTaskRun {
  toolCallId: string;
  /** Human label (the spawn description, else the prompt's first line). */
  label: string;
  /** The session that started it — snapshotted, like a command job's owner. */
  ownerSessionId?: string;
  /** The registry epoch this run belongs to (see the header). */
  epoch: number;
  startedAt: number;
  endedAt: number | null;
  status: SessionJobStatus;
  /** Rendered completion detail (task summary + status flags), once settled. */
  body?: string;
  /**
   * The exact value written into the tool part, kept so the repair pass can replay it.
   *
   * TanStack writes every `TOOL_CALL_RESULT` of a batch when the whole tool phase ends, so a task
   * that settles while a sibling tool is still running can be overwritten by its own `running`
   * handle. The ledger is then the only place the settled output still exists.
   */
  output?: unknown;
  /** Display payload that belongs with {@link output} (the part keeps the handle's otherwise). */
  display?: ToolDisplayPayload;
  /** Whether the completion has been handed to the message window. */
  delivered: boolean;
}

/** What a settle records: the shared row fields plus the part payload it wrote. */
export interface BackgroundTaskSettlement {
  status: BackgroundWorkTerminalStatus;
  body: string;
  /**
   * The value handed to `addToolResult` — replayed by the repair pass.
   *
   * Optional only so a caller that owns no part (a test, or a future non-part surface) can settle
   * without inventing one; such a row simply cannot be repaired, which is why the real writer always
   * passes it.
   */
  output?: unknown;
  display?: ToolDisplayPayload;
}

export class SubagentRuns {
  /** The per-parent seat scheduler (concurrency window + eager runs). */
  readonly prefork: TaskPreforkCoordinator;
  private readonly phases = new Map<string, TaskRunState>();
  /** Background rows, keyed by the `task` tool call id. */
  private readonly background = new Map<string, BackgroundTaskRun>();
  /** Bumped by {@link reset}: a settle from an older epoch is ignored. */
  private epoch = 0;
  private changeSink: BackgroundWorkChangeSink | null = null;

  constructor(
    getMaxActive: () => number,
    private readonly getOwnerSessionId: () => string | undefined = () => undefined
  ) {
    this.prefork = new TaskPreforkCoordinator(getMaxActive);
  }

  /** Number of task phase records (test/observability). */
  get size(): number {
    return this.phases.size;
  }

  /** Current registry epoch — captured by a background run so a late settle can be recognised. */
  get currentEpoch(): number {
    return this.epoch;
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

  // ==========================================================================
  // Background ledger (the task source of the background-work trunk)
  // ==========================================================================

  /** Register the trunk's change sink (one per facade; replaced after a session switch). */
  setChangeSink(sink: BackgroundWorkChangeSink | null): void {
    this.changeSink = sink;
  }

  /** Open a background row for a `task` call being handed to the trunk. Idempotent per call id. */
  beginBackground(input: { toolCallId: string; label: string }): BackgroundTaskRun {
    const existing = this.background.get(input.toolCallId);
    if (existing) return existing;
    const ownerSessionId = this.getOwnerSessionId();
    const run: BackgroundTaskRun = {
      toolCallId: input.toolCallId,
      label: input.label,
      ...(ownerSessionId ? { ownerSessionId } : {}),
      epoch: this.epoch,
      startedAt: Date.now(),
      endedAt: null,
      status: "running",
      delivered: false,
    };
    this.background.set(input.toolCallId, run);
    this.notify([]);
    return run;
  }

  /**
   * Record the terminal transition; `true` only when THIS call performed it.
   *
   * Idempotent for the same reason the command registry's `finish()` is: a second settle must not
   * re-fire `finished` and wake an idle agent for a result it already received. A run from an older
   * epoch is no longer in the map (see the header), so it cannot resurrect a row either — the
   * optional `epoch` makes that a check of the row itself rather than of the caller's memory.
   */
  settleBackground(toolCallId: string, settlement: BackgroundTaskSettlement, epoch?: number): boolean {
    const run = this.background.get(toolCallId);
    if (!run || run.status !== "running") return false;
    if (epoch !== undefined && run.epoch !== epoch) return false;
    run.status = settlement.status;
    run.endedAt = Date.now();
    run.body = settlement.body;
    run.output = settlement.output;
    if (settlement.display) run.display = settlement.display;
    this.evictDeliveredBackground();
    this.notify([toolCallId]);
    return true;
  }

  /** Rows for the shared jobs snapshot, owner-scoped. */
  backgroundRows(): BackgroundTaskRun[] {
    const current = this.getOwnerSessionId();
    return [...this.background.values()].filter((run) => isVisibleToSession(run.ownerSessionId, current));
  }

  /** Settled, not-yet-delivered rows — the peek half of the delivery contract. */
  pendingBackground(): BackgroundTaskRun[] {
    return this.backgroundRows().filter((run) => run.status !== "running" && !run.delivered);
  }

  /**
   * Settled rows whose part payload the repair pass may need to replay.
   *
   * Delivered rows stay in this list on purpose: delivery marks the *notification*, not the part
   * write, and the two land at different moments. Only the retention cap removes them.
   */
  settledBackground(): BackgroundTaskRun[] {
    return this.backgroundRows().filter((run) => run.status !== "running" && run.output !== undefined);
  }

  /** Drop the oldest delivered rows once retention is exceeded (insertion order = start order). */
  private evictDeliveredBackground(): void {
    if (this.background.size <= MAX_SETTLED_BACKGROUND_ROWS) return;
    for (const [toolCallId, run] of this.background) {
      if (this.background.size <= MAX_SETTLED_BACKGROUND_ROWS) break;
      if (run.status !== "running" && run.delivered) this.background.delete(toolCallId);
    }
  }

  /** Mark rows delivered (the trunk marks only after the notification was persisted). */
  markBackgroundDelivered(toolCallIds: readonly string[]): void {
    if (toolCallIds.length === 0) return;
    let changed = false;
    for (const toolCallId of toolCallIds) {
      const run = this.background.get(toolCallId);
      if (!run || run.delivered) continue;
      run.delivered = true;
      changed = true;
    }
    // Membership-only: nothing ended here, only a result was handed over. The footer's `pending`
    // count is derived from this flag, so this notification is what clears it.
    if (changed) this.notify([]);
  }

  /**
   * End of a conversation: drop every phase, end every seat, forget every background row.
   *
   * The task-side equivalent of a command-registry teardown — epoch bump (a late settle is dropped),
   * seats aborted, pending queue cleared.
   *
   * It deliberately does NOT publish. Publication belongs to the facade, which must clear the channel
   * FIRST and only then reset its sources; a source that published here would emit a frame while the
   * facade is still open — i.e. the leaving session's rows, resurrected mid-switch — and a second empty
   * frame right after. Reached without a facade (an agent that never had background work) there is
   * nothing subscribed to update, so there is nothing to publish either.
   */
  reset(): void {
    this.epoch += 1;
    this.phases.clear();
    this.background.clear();
    // Discard the eager seats of the run being left, then end the background ones. Idempotent: the
    // switch transaction already aborts the run (which discards seats).
    this.prefork.abortAll();
    this.prefork.abortDetached();
  }

  private notify(finished: readonly string[]): void {
    this.changeSink?.(finished);
  }
}

const registries = new WeakMap<ManagedAgent, SubagentRuns>();

/** Get (or lazily create) the run registry for a parent agent. */
export function subagentRuns(parentManaged: ManagedAgent): SubagentRuns {
  let runs = registries.get(parentManaged);
  if (!runs) {
    // Read the cap through the parent so an `updateConfig` after creation is honored; the owner id is
    // read the same way, since a session id only exists after `ensureSessionData()`.
    runs = new SubagentRuns(
      () => resolveMaxConcurrentTasks(parentManaged),
      () => parentManaged.getSessionData?.()?.id
    );
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
  const state = subagentRuns(parentManaged).begin(toolCallId);
  // Assigned once: a re-entry (tool phase retry, background wake) must not move the attribution.
  // Optional: validators and hosts may drive the registry with a structural fake that has no run
  // identity. The row is still useful without attribution; do not fail the call for it.
  state.spawnRunId ??= parentManaged.getCurrentRunId?.() ?? undefined;
  return state;
}

/** The parent run that spawned a task, for settle-time rows (undefined for an unknown task). */
export function readTaskRunSpawnId(parentManaged: ManagedAgent, toolCallId: string | undefined): string | undefined {
  if (!toolCallId) return undefined;
  return subagentRuns(parentManaged).state(toolCallId)?.spawnRunId;
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

/**
 * Drop task bookkeeping: one task's phase, or — with no id — the whole conversation.
 *
 * The one entry point for both, because "clear this task" and "clear this session's tasks" are the
 * same registry operation at two scopes; two exported names for it invited a caller to clear twice
 * per switch. Non-creating: an agent that never ran a task must not gain a registry just to clear it.
 */
export function clearTaskRuns(parentManaged: ManagedAgent, toolCallId?: string): void {
  const runs = peekSubagentRuns(parentManaged);
  if (!runs) return;
  if (toolCallId) runs.forget(toolCallId);
  else runs.reset();
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
 *
 * This deliberately does NOT reach the detached seats ({@link TaskPreforkCoordinator.abortDetached}):
 * a background task survives its run ending — only a session switch ends it, which is why it is not
 * in `entries`.
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
