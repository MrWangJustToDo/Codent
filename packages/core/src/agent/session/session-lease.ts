/**
 * One session's ownership/identity state machine.
 *
 * The session switch used to be a sequence of calls scattered across the lifecycle service:
 * acquire the target claim, bind the target log sink, adopt the target data, release the leaving
 * claim — each one a separate host method, with the ordering held by comments. This class is the
 * one place that owns that transition: a claim is either held by this agent or it is not, a target
 * is either committed or abandoned, and the generation advances exactly once per commit.
 *
 * The class is deliberately storage-free: ownership, the disk reservation, the log sink and the
 * persistence baseline arrive as ports. That keeps it testable (and usable by a fake host) while
 * `ManagedAgent` wires the real stores.
 */

import type { UIMessage } from "@tanstack/ai";

export type SessionLeaseState = "unclaimed" | "claimed" | "restoring" | "active" | "draining" | "released";

export interface SessionLeasePorts {
  /** Claim the session for this agent; false when another live agent holds it. */
  acquire(sessionId: string, ownerId: string): boolean;
  /** Release the claim if this agent holds it (idempotent). */
  release(sessionId: string, ownerId: string): void;
  /** Release a reservation this lease created (best-effort; the store owns the flag). */
  releaseReservation?(sessionId: string): void;
  /**
   * Commit side effects: the persistence baseline for `uiMessages` and the session generation used
   * by `Epoch`. Called once per successful commit, after ownership has moved.
   */
  onCommit?(sessionId: string, generation: number): void;
  /** Persistence-baseline side effect for the transcript that was actually adopted. */
  onAdopt?(sessionId: string, uiMessages?: UIMessage[]): void;
}

export interface SessionLeaseClaimOptions {
  /** True when this claim's session id came from an empty-session reservation we wrote. */
  reserved?: boolean;
}

export class SessionLease {
  private state: SessionLeaseState = "unclaimed";
  private sessionId: string | undefined;
  /** The active session while a switch to `sessionId` is in flight; released at commit/abort. */
  private leavingId: string | undefined;
  private generation = 0;
  private reserved = false;
  /** Whether the session being LEFT was reserved by this lease (released at commit). */
  private leavingReserved = false;

  constructor(
    private readonly ownerId: string,
    private readonly ports: SessionLeasePorts
  ) {}

  getState(): SessionLeaseState {
    return this.state;
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  getGeneration(): number {
    return this.generation;
  }

  isReserved(): boolean {
    return this.reserved;
  }

  isActive(): boolean {
    return this.state === "active";
  }

  /** Whether a switch to another session is in flight. */
  isTransitioning(): boolean {
    return this.leavingId !== undefined && this.leavingId !== this.sessionId;
  }

  /**
   * Claim `sessionId` for this agent.
   *
   * Idempotent for the id already held. Claiming a different id while active starts a transition:
   * the current id is remembered as the departure and is only released at {@link commit} (or
   * {@link abortClaim}), so "active in another live session" never describes a half-switch.
   */
  claim(sessionId: string, options: SessionLeaseClaimOptions = {}): boolean {
    if (this.state === "active" && this.sessionId === sessionId) return true;
    if (this.state === "claimed" && this.sessionId === sessionId) return true;
    if (this.state === "restoring" && this.sessionId === sessionId) return true;

    if (!this.ports.acquire(sessionId, this.ownerId)) return false;
    if (this.state === "active" || this.state === "draining") {
      this.leavingId = this.sessionId;
      this.leavingReserved = this.reserved;
    }
    this.sessionId = sessionId;
    this.reserved = options.reserved === true;
    this.state = "claimed";
    return true;
  }

  /** Enter the read/restore phase for the claimed target. */
  beginRestore(): void {
    if (this.state === "claimed") this.state = "restoring";
  }

  /**
   * Commit the claimed target: release the departure, make this the active session, advance the
   * generation, then run the commit side effects. Idempotent when already committed to this id.
   */
  commit(): void {
    if (!this.sessionId) throw new Error("SessionLease.commit called without a claimed session");
    if (this.state === "active" && this.leavingId === undefined) {
      // A caller (e.g. restore) may commit the session that is already active — do not advance the
      // generation twice; only a real transition or the first claim does.
      return;
    }
    if (this.leavingId !== undefined && this.leavingId !== this.sessionId) {
      this.ports.release(this.leavingId, this.ownerId);
      // The departure may have been a reused empty session this lease reserved at bootstrap. A
      // committed switch away from it must release that reservation, or it stays invisible to
      // `getLatestEmpty()` for the rest of the TTL.
      if (this.leavingReserved) this.ports.releaseReservation?.(this.leavingId);
    }
    this.leavingId = undefined;
    this.leavingReserved = false;
    this.state = "active";
    this.generation += 1;
    this.ports.onCommit?.(this.sessionId, this.generation);
  }

  /**
   * Record the transcript that was actually adopted (restore/bootstrap), independent of whether the
   * ownership commit advanced the generation. The persistence baseline must be reset even when the
   * restored session is already the active one.
   */
  adopt(options: { uiMessages?: UIMessage[] } = {}): void {
    if (!this.sessionId) return;
    this.ports.onAdopt?.(this.sessionId, options.uiMessages);
  }

  /**
   * Abandon a claim that never committed.
   *
   * A failed initial claim returns to `unclaimed`; a failed switch releases only the target and
   * keeps the departure active, so the agent remains on the session it was actually running.
   */
  abortClaim(): void {
    if (this.sessionId === undefined) return;
    const target = this.sessionId;
    if (this.leavingId !== undefined) {
      this.ports.release(target, this.ownerId);
      if (this.reserved) this.ports.releaseReservation?.(target);
      this.sessionId = this.leavingId;
      this.leavingId = undefined;
      this.reserved = this.leavingReserved;
      this.leavingReserved = false;
      this.state = "active";
      return;
    }
    this.ports.release(target, this.ownerId);
    if (this.reserved) this.ports.releaseReservation?.(target);
    this.sessionId = undefined;
    this.reserved = false;
    this.state = "unclaimed";
  }

  /** Stop accepting a switch; the session is being torn down. */
  beginDrain(): void {
    if (this.state === "active" || this.state === "claimed" || this.state === "restoring") {
      this.state = "draining";
    }
  }

  /** Release the active claim and any reservation. Idempotent. */
  release(): void {
    if (this.sessionId !== undefined) {
      this.ports.release(this.sessionId, this.ownerId);
      if (this.reserved) this.ports.releaseReservation?.(this.sessionId);
    }
    this.sessionId = undefined;
    this.leavingId = undefined;
    this.reserved = false;
    this.leavingReserved = false;
    this.state = "released";
  }
}
