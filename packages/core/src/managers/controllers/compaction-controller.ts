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
 * - `abortForTeardown` — session switch / agent destroy: invalidate and abort, leave the status to
 *   the caller (the lifecycle resets it).
 *
 * Only `manual` refuses a second `begin`: a second `/compact` must not replace the first lease and
 * orphan its abort controller. The automatic kinds may claim at any time — that is how a stale
 * auto attempt is invalidated when a newer one starts.
 */

import type { AgentStatus } from "../../runtime-types/agent-status.js";
import type { EmitAgentTelemetryFn } from "../telemetry/emit-agent-telemetry.js";

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
  | { status: "failed"; error: string; phase?: string }
  | { status: "skipped" };

export interface CompactionControllerDeps {
  getStatus: () => AgentStatus;
  setStatus: (status: AgentStatus, trigger?: string) => void;
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
    if (kind === "manual" && this.active?.lease.kind === "manual") return null;

    const controller = kind === "manual" ? new AbortController() : undefined;
    const lease: CompactionLease = {
      kind,
      ...(controller ? { signal: controller.signal } : {}),
    };
    this.active = { lease, previousStatus: this.deps.getStatus(), ...(controller ? { controller } : {}) };

    this.deps.setStatus("compacting", `compaction:${kind}`);
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
          ...(outcome.phase ? { phase: outcome.phase } : {}),
          error: outcome.error,
        });
      } else if (lease.kind === "manual") {
        this.deps.emitEvent("compaction:manual-error", {
          ...(outcome.phase ? { phase: outcome.phase } : {}),
          error: outcome.error,
        });
      } else {
        this.deps.emitEvent("compaction:auto-error", {
          ...(outcome.phase ? { phase: outcome.phase } : {}),
          error: outcome.error,
        });
      }
    }
    this.restoreStatus(lease.kind);
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
   * Invalidate and abort whatever is running, without touching the status.
   *
   * Session switch / agent destroy: the lifecycle resets the status itself, and a stale producer
   * must not restore anything onto the session that replaced it.
   */
  abortForTeardown(reason: string): void {
    if (!this.active) return;
    this.abortActive(reason);
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

  /**
   * Force `compacting` back to `running`, if it is still set.
   *
   * A safety net for the reactive-retry shell, which can finish without an outcome to report (the
   * compaction applied, but the retry path only needs the status unwound before the restarted
   * stream).
   */
  settle(): void {
    if (this.deps.getStatus() === "compacting") this.deps.setStatus("running", "compaction-end");
  }

  private abortActive(reason: string): void {
    this.active?.controller?.abort(reason);
    // Dropping the lease IS the invalidation: a late `finish`/`release` from the aborted producer
    // is a no-op, so it cannot apply a checkpoint or restore a status.
    this.active = null;
  }

  private restoreStatus(kind: CompactionKind): void {
    // Only an owner may restore, and only from the status it published. A cancel (aborted), a
    // session switch (reset) or a newer run (running) already moved on.
    if (this.deps.getStatus() !== "compacting") return;
    const previous = this.active?.previousStatus;
    if (kind === "manual" && previous !== undefined && previous !== "compacting") {
      this.deps.setStatus(previous, "compaction-end");
      return;
    }
    // Auto/reactive continue the run they interrupted; a manual compaction that replaced another
    // compaction likewise returns to "work is in flight".
    this.deps.setStatus("running", "compaction-end");
  }
}
