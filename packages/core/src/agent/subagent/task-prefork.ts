/**
 * Task pre-fork coordinator — starts subagents eagerly while the model is
 * still streaming, so multiple `task` calls in one turn run in parallel.
 *
 * TanStack `chat()` runs tool calls in parallel by default (every call's
 * `onBeforeToolCall` fires, then the server tools start together). A `task`
 * call's subagent must not begin before its arguments finish streaming, so the
 * pre-fork middleware spawns it at `TOOL_CALL_END`; the tool phase's `execute`
 * later joins the already-running promise via the task tool.
 *
 * The pre-fork also caps concurrency: it is the throttle that keeps N parallel
 * `task` calls from opening N provider streams at once. Scheduling is a rolling
 * FIFO window — every registered run is accepted, and runs beyond
 * {@link MAX_ACTIVE_TASK_PREFORKS} queue until a slot frees, so the 5th+ starts
 * as soon as an earlier one finishes (not serially, and not all at once).
 *
 * A queued run has not begun: it fires its `agent:tool-start` only when it
 * acquires a slot (see {@link TaskPreforkCoordinator.start}'s `onRunStart`), and
 * the extensions middleware skips its own eager `agent:tool-start` for a call the
 * coordinator already owns — otherwise the row would time while merely waiting.
 */

import { SUBAGENT_PARENT_RUN_NOTICE } from "./subagent-stop-reason.js";

import type { SubagentResult } from "./types.js";
import type { ManagedAgent } from "../../runtime-types/hosts.js";

/** Max subagent runs executing LLM loops concurrently per parent. */
export const MAX_ACTIVE_TASK_PREFORKS = 4;

function cancelledStubResult(): SubagentResult {
  return {
    subagentId: "",
    // A discard is the run lifecycle moving on — never a user cancel. This used to read
    // `[Task cancelled.]` with no reason at all, which is the same misattribution the
    // notice taxonomy exists to fix, one layer down: the caller had no way to say what
    // happened, so a reader could only assume the operator did it.
    output: SUBAGENT_PARENT_RUN_NOTICE,
    truncated: false,
    iterations: 0,
    // No run happened, so there is no budget to report against the count.
    maxIterations: 0,
    durationMs: 0,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, billedInputTokens: 0 },
    reachedLimit: false,
    // `incomplete` means "finished, but not cleanly" — `deriveSubagentRunStats` only ever
    // sets it on the `!aborted` path, so a cancel can never carry it.
    //
    // This stub IS reachable: it is the result a discarded QUEUED pre-fork settles to (an
    // admitted one returns its own run's result instead). It is not joined by the tool phase
    // — `abortAll` clears the entry, so a later `join` gets `null` and spawns a fresh
    // subagent — but it is the coordinate's declared shape for "this run was thrown away",
    // so it still has to be honest about why. `incomplete` stays false because it is not
    // cancel-aware: a stale flag here would read as "stalled" rather than "stopped".
    incomplete: false,
    aborted: true,
    stopReason: "parent-run",
  };
}

export type PreforkDiscardCause = "run-start" | "run-finish" | "run-abort" | "run-error";

/** One tool call whose eagerly started run was thrown away. */
export interface PreforkDiscard {
  toolCallId: string;
  cause: PreforkDiscardCause;
  /** Subagents already spawned for the call — aborted by this discard, so orphaned. */
  subagentIds: string[];
}

interface PreforkEntry {
  /** "queued" until its gate opens, "running" once the factory may proceed. */
  state: "queued" | "running";
  /** Whether this entry currently occupies a concurrency slot. */
  occupying: boolean;
  aborted: boolean;
  /**
   * Subagents this entry has spawned so far.
   *
   * Read by {@link TaskPreforkCoordinator.abortAll}'s caller so a discarded pre-fork can
   * report which children it orphaned. Normally one, but the coordinator can be *reused*
   * for the same tool call id when a duplicate `TOOL_CALL_END` arrives for an id whose
   * entry was discarded mid-run — and an abandoned child is exactly what the report
   * exists for.
   */
  spawned: string[];
  gate: Promise<void>;
  openGate: () => void;
  abortHandle: () => void;
  promise: Promise<SubagentResult>;
}

export class TaskPreforkCoordinator {
  private readonly entries = new Map<string, PreforkEntry>();
  private readonly waiting = new Set<PreforkEntry>();
  private active = 0;

  /** Set by {@link setOnChange}: announced on every queue/occupancy mutation. */
  private onChange?: () => void;

  /**
   * @param getMaxActive Concurrency cap provider, read per admission so a value
   *   changed through `ManagedAgent.updateConfig` takes effect on the next run.
   *   Defaults to the module constant so the class is usable stand-alone.
   */
  constructor(private readonly getMaxActive: () => number = () => MAX_ACTIVE_TASK_PREFORKS) {}

  get size(): number {
    return this.entries.size;
  }

  /** Runs currently holding a concurrency slot (excludes queued runs). */
  get activeCount(): number {
    return this.active;
  }

  /** The cap currently enforced. Re-read from the provider, so an `updateConfig` is honored. */
  get maxActive(): number {
    return this.getMaxActive();
  }

  /**
   * Tasks waiting for a slot, in admission order (the order they will start in).
   *
   * Read from `waiting` rather than the entries' `state`: an entry is admitted by opening its
   * gate, and `state` only flips to `running` when the drive loop next runs — so `state` briefly
   * reports "queued" for a run that already holds a slot.
   */
  queuedToolCallIds(): string[] {
    const queued: string[] = [];
    for (const [toolCallId, entry] of this.entries) {
      if (!entry.aborted && this.waiting.has(entry)) queued.push(toolCallId);
    }
    return queued;
  }

  /**
   * Publish every mutation of the queue/occupancy to a host.
   *
   * A callback rather than a bus or a logger: this class stays transport-free (the middleware owns
   * the event), and the callback is the ONLY place a snapshot is taken, so a new mutation cannot
   * forget to announce itself — the failure mode would be a UI that keeps showing a task as
   * waiting after it started, or a slot count that never drops.
   */
  setOnChange(onChange: () => void): void {
    this.onChange = onChange;
  }

  private notify(): void {
    this.onChange?.();
  }

  has(toolCallId: string): boolean {
    return this.entries.has(toolCallId);
  }

  /**
   * Record a subagent spawned by this tool call's run.
   *
   * The runner has the id and the coordinator is the only object that outlives a discarded
   * run, so the record lands here: when {@link abortAll} throws the run away, the caller can
   * say which subagents were orphaned instead of leaving that to be reconstructed from
   * timestamps (which is what an orphan used to look like from the log — a subagent with no
   * binding to the `task` call that spawned it). No-op for an unknown id (the run was never
   * registered, e.g. the serial fallback path).
   */
  recordSpawn(toolCallId: string, subagentId: string): void {
    const entry = this.entries.get(toolCallId);
    if (!entry) return;
    entry.spawned.push(subagentId);
  }

  /**
   * Cancel every registered run (queued ones settle with a stub) and reset.
   *
   * @returns one record per discarded tool call when a cause is given — the tool call id
   * and the subagents that were already spawned for it, so the caller can report the
   * orphan instead of dropping the information on the floor. The coordinator itself stays
   * silent (it has no logger and is deliberately transport-free), and an *accepted* join
   * removes the entry first, so a call that completed normally is never reported.
   */
  abortAll(cause?: PreforkDiscardCause): PreforkDiscard[] {
    const discarded: PreforkDiscard[] = [];
    for (const [toolCallId, entry] of this.entries) {
      if (cause && !entry.aborted) {
        discarded.push({ toolCallId, cause, subagentIds: [...entry.spawned] });
      }
      if (entry.aborted) continue;
      entry.aborted = true;
      if (!entry.occupying) {
        // Never started — settle immediately without consuming a slot.
        this.waiting.delete(entry);
        entry.openGate();
      }
    }
    for (const entry of this.entries.values()) {
      try {
        entry.abortHandle();
      } catch {
        // Cleanup must never mask the original failure.
      }
    }
    this.entries.clear();
    // Every registered run is gone: announce it, or a host would keep rendering the queue it saw
    // before the discard (including tasks whose attempt this just cancelled).
    this.notify();
    return discarded;
  }

  /**
   * Register a background run. Beyond the concurrency cap runs queue FIFO and roll forward as slots
   * free.
   *
   * @returns `false` when this call registered NOTHING because a run for `toolCallId` is already
   * registered. The caller's spawn is then a no-op, and it has to disarm whatever it built for it
   * (its parent-signal listener and controller) — this return value is the only thing that tells it
   * the run it believes it started is not the one that will be joined.
   * @param abortHandle cancels the run (controller) — safe in any state.
   * @param onRunStart fires when the run actually acquires a slot (not while queued).
   */
  start(
    toolCallId: string,
    abortHandle: () => void,
    factory: () => Promise<SubagentResult>,
    onRunStart?: () => void
  ): boolean {
    if (this.entries.has(toolCallId)) return false;

    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const entry: PreforkEntry = {
      state: "queued",
      occupying: false,
      aborted: false,
      spawned: [],
      gate,
      openGate,
      abortHandle,
      promise: undefined!,
    };
    entry.promise = this.drive(entry, factory, onRunStart);
    this.entries.set(toolCallId, entry);

    // The registry owns this promise for its whole life, but nothing joins it when
    // the run is aborted/queued away (`abortAll` settles the gate, not the promise)
    // — and an unobserved rejection has no global handler, so a failing pre-fork
    // would crash the host process instead of surfacing through the task tool.
    // Attach a no-op catch: `join` still observes the real rejection through
    // `entry.promise`, and this only marks the rejection as handled.
    void entry.promise.catch(() => {});

    if (this.active < this.getMaxActive()) {
      this.admit(entry);
    } else {
      this.waiting.add(entry);
    }
    // Announce from here rather than from each branch: whether this call started immediately or
    // joined the queue, its arrival changed what a host should show.
    this.notify();
    return true;
  }

  /**
   * Join a registered run and drop bookkeeping. Returns null when the call was
   * not registered (caller runs it serially).
   */
  async join(toolCallId: string): Promise<SubagentResult | null> {
    const entry = this.entries.get(toolCallId);
    if (!entry) return null;
    this.entries.delete(toolCallId);
    this.notify();
    return entry.promise;
  }

  private admit(entry: PreforkEntry): void {
    this.waiting.delete(entry);
    entry.occupying = true;
    this.active += 1;
    entry.openGate();
    // No `notify()` here: every caller announces afterwards (the registering `start`, or `drive`'s
    // finally after `promote`), and two snapshots for one transition would be pure noise.
  }

  private async drive(
    entry: PreforkEntry,
    factory: () => Promise<SubagentResult>,
    onRunStart?: () => void
  ): Promise<SubagentResult> {
    await entry.gate;
    if (entry.aborted) {
      if (entry.occupying) {
        entry.occupying = false;
        this.active -= 1;
        this.promote();
      }
      this.notify();
      return cancelledStubResult();
    }
    entry.state = "running";
    try {
      // Inside the try: if the callback throws (a telemetry subscriber fault), the
      // finally still releases the slot. Outside, the leak was permanent — `active`
      // never dropped, so once it reached the cap admission stalled for the
      // coordinator's whole lifetime (cached per agent).
      onRunStart?.();
      return await factory();
    } finally {
      entry.occupying = false;
      this.active -= 1;
      this.promote();
      // After `promote`: a freed slot usually admits someone, so this announcement carries the
      // post-promotion queue rather than a one-off intermediate state.
      this.notify();
    }
  }

  private promote(): void {
    // Admit up to the cap, re-reading the provider each time: a cap lowered mid-run
    // must not be overshot by promotion, and a cap raised while runs wait should top
    // up. One admission per completion (the common case) falls out of the loop.
    while (this.active < this.getMaxActive()) {
      let admitted = false;
      for (const candidate of this.waiting) {
        if (candidate.aborted) continue;
        this.admit(candidate);
        admitted = true;
        break;
      }
      if (!admitted) break;
    }
  }
}

const coordinators = new WeakMap<ManagedAgent, TaskPreforkCoordinator>();

/**
 * Resolve a parent's concurrent-task cap: a finite integer `>= 1`, else the
 * default. A missing/0/negative/fractional/NaN value must not stall admission.
 */
export function resolveMaxConcurrentTasks(parentManaged: ManagedAgent): number {
  const configured = parentManaged.config?.maxConcurrentTasks;
  if (typeof configured !== "number" || !Number.isFinite(configured)) return MAX_ACTIVE_TASK_PREFORKS;
  return Math.max(1, Math.floor(configured));
}

/** Get (or lazily create) the pre-fork coordinator for a parent agent. */
export function getTaskPreforkCoordinator(parentManaged: ManagedAgent): TaskPreforkCoordinator {
  let coordinator = coordinators.get(parentManaged);
  if (!coordinator) {
    // Read the cap through the parent so an `updateConfig` after creation is honored.
    coordinator = new TaskPreforkCoordinator(() => resolveMaxConcurrentTasks(parentManaged));
    coordinators.set(parentManaged, coordinator);
  }
  return coordinator;
}

/**
 * The pre-fork coordinator for a parent, or `undefined` when none exists yet.
 *
 * Non-creating, unlike {@link getTaskPreforkCoordinator}: a reader that only
 * wants to know whether a call is already pre-forked (the extensions middleware
 * deferring its eager `agent:tool-start`) must not bring a coordinator into
 * existence for an agent that never pre-forked anything.
 */
export function peekTaskPreforkCoordinator(parentManaged: ManagedAgent): TaskPreforkCoordinator | undefined {
  return coordinators.get(parentManaged);
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
 * - `ManagedAgent.reset()` — `/clear` and a new session rewind the run state without an agent abort;
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
