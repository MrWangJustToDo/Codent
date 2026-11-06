/**
 * Compaction ownership — one controller for every kind of compaction.
 *
 * Compaction has three producers (auto inside the loop, reactive after a context overflow, and the
 * user's `/compact`) and four things that must agree between them: **who owns the current run of
 * work** (one lease at a time), **what the status is** (`compacting` and what it returns to), **which
 * events/log lines describe it**, and **how it is cancelled**. Those used to live in four places —
 * `ManagedAgent` held a generation counter and the manual `AbortController`, `AgentStatusController` held
 * `beginCompaction`/`endCompaction`, and each producer restored its own status in its own `finally`.
 * The result was the bug this controller exists to prevent: a producer that invalidated ownership
 * also disabled the status restore, so the agent could stay stuck in `compacting`; and
 * manual `/compact` borrowed the auto event names.
 *
 * A lease is the unit of ownership. `begin` claims it (publish status, emit start),
 * the producer does its work and checks `isCurrent(lease)` before applying anything, and exactly one
 * of `finish` / `release` / `cancel` / `abortForTeardown` ends it:
 *
 * - `finish` — terminal, emits `compaction:<kind>-complete|error` and restores the status.
 * - `release` — terminal but silent (a cancel is not a failure; an unexpected throw still restores).
 * - `cancel` — the user's Esc on a manual compaction: status `aborted`, summarizer aborted.
 * - `abortForTeardown` — session switch / agent destroy: invalidate and abort, restore the status
 *   it replaced (the reset paths overwrite it before the new session is adopted).
 *
 * Only `manual` refuses a second `begin`: a second `/compact` must not replace the first lease and
 * orphan its abort controller. The automatic kinds may claim at any time — that is how a stale
 * auto attempt is invalidated when a newer one starts.
 */

import { isTerminalStatus } from "../../runtime-types/agent-status.js";

import type { EmitAgentTelemetryFn } from "../../runtime-types/agent-events.js";
import type { AgentState, AgentStateEventType, AgentTransitionEvent } from "../../runtime-types/agent-state.js";
import type { AgentStatus } from "../../runtime-types/agent-status.js";

export type CompactionKind = "auto" | "manual" | "reactive";

/** Ownership token returned by {@link CompactionController.begin}. */
export interface CompactionLease {
  readonly kind: CompactionKind;
  /**
   * The summarizer's own signal — manual only.
   *
   * Auto and reactive compaction ride the run's `currentAbortController` signal instead, so an Esc
   * that aborts the run also stops their summarizer. A manual compaction has no run, so it needs a
   * signal of its own (this one) for the same guarantee.
   */
  readonly signal?: AbortSignal;
}

export interface CompactionBeginOptions {
  tokensBefore?: number;
  /** Reactive only: which retry this is. */
  retry?: number;
  /** Reactive only: the retry budget. */
  maxRetries?: number;
}

/** How a compaction ended. `skipped` restores the status but reports nothing (no progress). */
export type CompactionOutcome =
  | {
      status: "completed";
      tokensBefore?: number;
      tokensAfter?: number;
      /** Reactive only: message counts, which is what the caller there reports. */
      originalCount?: number;
      compactedCount?: number;
    }
  | { status: "failed"; error: string }
  | { status: "skipped" };

export interface CompactionControllerDeps {
  getStatus: () => AgentStatus;
  setStatus: (status: AgentStatus, event?: AgentStateEventType) => void;
  /** The single state writer; compaction is a run phase, not a status of its own. */
  transition?: (event: AgentTransitionEvent) => AgentStatus;
  /**
   * The state axes, when `transition` owns the state.
   *
   * The restore guard must read the run phase (`run === "compacting"`), not the projected status:
   * a failure that lands while the lease owns the run keeps `run: "compacting"` and sets
   * `outcome: "error"`, and `projectAgentStatus` reports `error` for that combination. Reading the
   * projection here then skipped the restore, `compaction-end` was never dispatched, and the agent
   * stayed wedged (a new run and a new compaction both rejected).
   */
  getAgentState?: () => AgentState;
  /**
   * Clear the last error when a compaction restores a terminal status to `idle`.
   *
   * `setStatus` moves the status only, so a successful `/compact` after a failed turn produced the
   * one combination no other writer makes — `idle` with the old error still set — and hosts that
   * render `error` keep showing a failure beside a `compaction:manual-complete` that succeeded.
   */
  setError?: (error: string) => void;
  /** `AgentStatusController.onUserCancel` — the one "the user cancelled" verdict. */
  onUserCancel: () => void;
  emitEvent: EmitAgentTelemetryFn;
}

interface ActiveCompaction {
  lease: CompactionLease;
  /** Status the compaction replaced; only `manual` restores it (the others continue a live run). */
  previousStatus: AgentStatus;
  /** Manual only — aborted by `cancel` / `abortForTeardown`. */
  controller?: AbortController;
}

export class CompactionController {
  private active: ActiveCompaction | null = null;

  constructor(private readonly deps: CompactionControllerDeps) {}

  /**
   * Claim a compaction: publish `compacting`, emit the kind's start event, take the lease.
   *
   * Returns null only when a manual compaction is already running (the caller reports "already in
   * progress"). The automatic kinds never queue: a newer claim invalidates the older lease, which
   * is what keeps a superseded summary from being applied.
   */
  begin(kind: CompactionKind, options: CompactionBeginOptions = {}): CompactionLease | null {
    if (this.active) {
      // Manual `/compact` is single-flight against another manual: a second one must not replace
      // the paid summarizer the user is waiting on. Every other combination supersedes.
      if (kind === "manual" && this.active.lease.kind === "manual") return null;
      // Supersede SAFELY: abort the old lease AND restore the status it published before claiming
      // the phase again. Aborting alone left the status at `compacting`, so the state machine
      // rejected the new `compaction-start` while `begin` still handed out a lease for it — the
      // older producer's `finish` became a silent no-op and the new checkpoint applied to a phase
      // it never owned. Restoring first is also what makes the manual case safe (its producer's
      // `release` is lease-checked and becomes a no-op).
      const previousKind = this.active.lease.kind;
      const { previousStatus } = this.active;
      this.abortActive(`superseded-by-${kind}`);
      this.restoreStatusFor(previousKind, previousStatus);
    }

    const controller = kind === "manual" ? new AbortController() : undefined;
    const lease: CompactionLease = {
      kind,
      ...(controller ? { signal: controller.signal } : {}),
    };
    this.active = { lease, previousStatus: this.deps.getStatus(), ...(controller ? { controller } : {}) };

    if (this.deps.transition) this.deps.transition({ type: "compaction-start" });
    else this.deps.setStatus("compacting", "compaction-start");
    // The transition can be refused by the state machine (a run phase that cannot be preempted,
    // a pending wait, a destroyed agent). Return no lease then: producers already treat null as
    // "could not start", while a lease against a status that never became `compacting` would let a
    // summary apply and emit start/complete lines for a phase that does not exist.
    if (this.deps.getStatus() !== "compacting") {
      this.active = null;
      return null;
    }
    if (kind === "auto") {
      this.deps.emitEvent(
        "compaction:auto-start",
        options.tokensBefore !== undefined ? { tokensBefore: options.tokensBefore } : undefined
      );
    } else if (kind === "manual") {
      this.deps.emitEvent(
        "compaction:manual-start",
        options.tokensBefore !== undefined ? { tokensBefore: options.tokensBefore } : undefined
      );
    } else {
      this.deps.emitEvent("compaction:reactive-start", {
        ...(options.retry !== undefined ? { retry: options.retry } : {}),
        ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
      });
    }
    return lease;
  }

  /**
   * Whether `lease` still owns the compaction.
   *
   * Identity is the whole answer: a lease that already finished, was superseded by a newer claim, or
   * was invalidated by a cancel/teardown is simply not `this.active` any more. Producers call this
   * immediately before applying a checkpoint and before restoring a status.
   */
  isCurrent(lease: CompactionLease): boolean {
    return this.active?.lease === lease;
  }

  /** Terminal outcome: emit the completion/failure line and restore the status this lease took. */
  finish(lease: CompactionLease, outcome: CompactionOutcome): boolean {
    if (!this.isCurrent(lease)) return false;
    if (outcome.status === "completed") {
      if (lease.kind === "reactive") {
        this.deps.emitEvent("compaction:reactive-complete", {
          originalCount: outcome.originalCount,
          compactedCount: outcome.compactedCount,
          tokensBefore: outcome.tokensBefore,
          tokensAfter: outcome.tokensAfter,
        });
      } else if (lease.kind === "manual") {
        this.deps.emitEvent("compaction:manual-complete", {
          tokensBefore: outcome.tokensBefore,
          tokensAfter: outcome.tokensAfter,
        });
      } else {
        this.deps.emitEvent("compaction:auto-complete", {
          tokensBefore: outcome.tokensBefore,
          tokensAfter: outcome.tokensAfter,
        });
      }
    } else if (outcome.status === "failed") {
      if (lease.kind === "reactive") {
        this.deps.emitEvent("compaction:reactive-error", {
          error: outcome.error,
        });
      } else if (lease.kind === "manual") {
        this.deps.emitEvent("compaction:manual-error", {
          error: outcome.error,
        });
      } else {
        this.deps.emitEvent("compaction:auto-error", {
          error: outcome.error,
        });
      }
    }
    this.restoreStatus(lease.kind, outcome);
    this.active = null;
    return true;
  }

  /**
   * Terminal but silent: restore the status without reporting an outcome.
   *
   * Used for a user abort (a cancel is not a failure) and as the `finally` safety net so a thrown
   * producer cannot leave the agent stuck in `compacting`.
   */
  release(lease: CompactionLease): void {
    if (!this.isCurrent(lease)) return;
    this.restoreStatus(lease.kind);
    this.active = null;
  }

  /**
   * Cancel the running manual compaction (the user's Esc).
   *
   * The verdict matches the auto path — a user cancel is an ABORT — but there is no run to
   * finalize, so nothing is emitted: `agent:abort` / `agent:stop` would describe a turn that never
   * existed. Dropping the lease is what makes the unwinding producer's `finish` a no-op, which is
   * why the status has to be restored HERE and not by the producer.
   */
  cancel(reason = "user-cancelled"): boolean {
    if (this.active?.lease.kind !== "manual") return false;
    this.deps.onUserCancel();
    this.abortActive(reason);
    return true;
  }

  /**
   * Invalidate and abort whatever is running on a teardown, restoring the status it replaced.
   *
   * Session switch / agent destroy: a stale producer must not restore anything onto the session
   * that replaced it, so the controller restores BEFORE the caller adopts the new session. The
   * reset paths (`reset()`, new/resume) overwrite this immediately; a host that only stops
   * producers (`stopForSessionSwitch`) used to be left in `compacting` forever — no run exists to
   * restore it, `isRunActive()` stays true, `/compact` and `/clone` are refused, and input queues
   * with nothing to drain it.
   */
  abortForTeardown(reason: string): void {
    if (!this.active) return;
    const { kind } = this.active.lease;
    const { previousStatus } = this.active;
    this.abortActive(reason);
    this.restoreStatusFor(kind, previousStatus);
  }

  /** Whether any compaction currently owns the agent. */
  isRunning(): boolean {
    return this.active !== null;
  }

  /** The running kind, or null. */
  runningKind(): CompactionKind | null {
    return this.active?.lease.kind ?? null;
  }

  /** Whether the running compaction is the user's `/compact` (the one Esc targets). */
  ownsManual(): boolean {
    return this.active?.lease.kind === "manual";
  }

  // ==========================================================================
  // Auto-compaction retry floor
  // ==========================================================================

  /**
   * Fill (in tokens) at which the last auto attempt failed or made no progress, or null.
   *
   * Lives here, not in the compaction middleware, because the middleware is rebuilt whenever the
   * runner is invalidated (`/models`, reasoning effort, system prompt, plan phase). The memory used
   * to vanish with it, so a summarizer that failed once was retried on EVERY model call by the new
   * pipeline — the exact storm the floor exists to prevent.
   */
  private autoRetryFloor: number | null = null;

  /** The fill the last failed/no-progress auto attempt started at (null when none). */
  getAutoRetryFloor(): number | null {
    return this.autoRetryFloor;
  }

  /** Remember that an auto attempt at this fill failed (or produced no checkpoint). */
  armAutoRetryFloor(tokensBefore: number): void {
    this.autoRetryFloor = tokensBefore;
  }

  /** A successful compaction — or a new session — invalidates the floor. */
  clearAutoRetryFloor(): void {
    this.autoRetryFloor = null;
  }

  private abortActive(reason: string): void {
    this.active?.controller?.abort(reason);
    // Dropping the lease IS the invalidation: a late `finish`/`release` from the aborted producer
    // is a no-op, so it cannot apply a checkpoint or restore a status.
    this.active = null;
  }

  private restoreStatus(kind: CompactionKind, outcome?: CompactionOutcome): void {
    this.restoreStatusFor(kind, this.active?.previousStatus, outcome);
  }

  private restoreStatusFor(kind: CompactionKind, previous: AgentStatus | undefined, outcome?: CompactionOutcome): void {
    // Only an owner may restore, and only from the phase it published. A cancel (aborted), a
    // session switch (reset) or a newer run (running) already moved on.
    //
    // Ownership is the run phase, NOT the projection: an error that lands during compaction keeps
    // `run: "compacting"` (the lease still owns it) while the projection becomes `error`. Using the
    // projection here made a failed compaction skip its own restore forever — `prepare` and the next
    // `compaction-start` were both rejected, so every following turn ended in error.
    const state = this.deps.getAgentState?.();
    const ownsPhase = state ? state.run === "compacting" : this.deps.getStatus() === "compacting";
    if (!ownsPhase) return;
    if (this.deps.transition) {
      const terminalPrevious = previous !== undefined && isTerminalStatus(previous);
      // Only a compaction that SUCCEEDED (or made no change) may clear the previous turn's fault.
      // A FAILED `/compact` reported `compaction:manual-error` and then settled `idle` with the
      // error text erased, so every host rendered a healthy session beside a failed compaction.
      // `release()` (cancel / teardown / safety net) passes no outcome and must also leave the
      // verdict alone: a cancel is not a repair.
      const repaired = outcome?.status === "completed" || outcome?.status === "skipped";
      if (kind === "manual" && terminalPrevious && repaired) {
        // A successful manual compact after a failed turn clears the old fault and settles idle.
        this.deps.setError?.("");
        this.deps.transition({ type: "reset" });
        return;
      }
      this.deps.transition({ type: "compaction-end" });
      return;
    }
    if (kind === "manual" && previous !== undefined && previous !== "compacting") {
      // A terminal status is not state to restore. `/compact` is allowed after a failed or
      // aborted turn, and writing `error`/`aborted` back after a SUCCESSFUL compaction made the
      // session look broken and contradicted the `compaction:manual-complete` that just fired.
      //
      // `waiting` / `awaiting_user` are NOT terminal (they are active waits), so they fall through
      // to the restore branch below deliberately: a parked turn is state to RESTORE. Reporting
      // `idle` instead would contradict the approval table (an unanswered question with no wait
      // status) and stop deferring the user's next message. The earlier `ownsPhase` guard is what
      // stops a normal stream finish from overwriting a parked turn — not this predicate.
      if (isTerminalStatus(previous)) {
        // Only a compaction that succeeded may clear the previous turn's fault. `release()`
        // (cancel / teardown / safety net) passes no outcome; restoring the terminal status keeps
        // its error text instead of erasing a real fault.
        if (outcome?.status !== "completed" && outcome?.status !== "skipped") {
          this.deps.setStatus(previous, "compaction-end");
          return;
        }
        // The error belonged to that failed turn: leaving it set is the only way `idle` and a
        // non-empty `error` can coexist.
        this.deps.setError?.("");
        this.deps.setStatus("idle", "compaction-end");
        return;
      }
      this.deps.setStatus(previous, "compaction-end");
      return;
    }
    // Auto/reactive continue the run they interrupted; a manual compaction that replaced another
    // compaction likewise returns to "work is in flight".
    this.deps.setStatus("running", "compaction-end");
  }
}
