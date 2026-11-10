/**
 * Agent-side session persistence: the sync fingerprint, save/persist entry points and the
 * restore transaction.
 *
 * `SessionService` owns the store and the serialized disk write; this class owns "what this agent
 * has already persisted" and the one best-effort error path every fire-and-forget caller shares.
 * `ManagedAgent.restoreSession` keeps only the lifecycle wrapper (ownership, session:switch, log
 * sink rebinding) around {@link SessionPersistence.restore}.
 */

import { errorMessage } from "../../utils/errors.js";
import {
  createSessionSyncTracker,
  type SessionSaveReason,
  type SessionSyncTracker,
} from "../persistence/session-sync-tracker.js";

import { getSessionPersistInput, restoreManagedSession, saveSessionUIMessages } from "./session-restore.js";

import type { SessionHost } from "../../runtime-types/session-host.js";
import type { SessionData } from "../persistence/types.js";
import type { UIMessage } from "@tanstack/ai";

export class SessionPersistence {
  private readonly tracker: SessionSyncTracker = createSessionSyncTracker();

  constructor(private readonly host: SessionHost) {}

  getSessionData(): SessionData | null {
    return this.host.session.getSessionData();
  }

  resetTracker(uiMessages?: UIMessage[]): void {
    this.tracker.reset(uiMessages);
  }

  /**
   * Persist `uiMessages` when an explicit trigger fires and the fingerprint changed.
   *
   * Returns the write's verdict (undefined when the tracker skipped it) so a caller that must not
   * claim durability — the background completion push — can wait for the actual result instead of
   * treating "queued" as "landed".
   */
  maybeSave(uiMessages: UIMessage[], reason: SessionSaveReason): Promise<boolean> | undefined {
    if (uiMessages.length === 0) return undefined;
    const sessionId = this.host.session.getSessionData()?.id;
    if (!this.tracker.shouldPersist(uiMessages, { reason })) {
      // The fingerprint short-circuit is a write DECISION worth seeing: "nothing was written" and
      // "the write failed" were indistinguishable in the timeline.
      this.emitPersist(reason, uiMessages.length, Date.now(), false, sessionId, true);
      return undefined;
    }
    const startedAt = Date.now();
    return saveSessionUIMessages(this.host, uiMessages, this.tracker, sessionId).then(
      (saved) => {
        this.emitPersist(reason, uiMessages.length, startedAt, saved, sessionId);
        return saved;
      },
      (err) => {
        this.emitPersist(reason, uiMessages.length, startedAt, false, sessionId);
        this.reportBackgroundPersistError(err, sessionId);
        return false;
      }
    );
  }

  /** Force-persist `uiMessages` (explicit slash-command flushes). */
  save(uiMessages: UIMessage[]): void {
    const sessionId = this.host.session.getSessionData()?.id;
    const startedAt = Date.now();
    void saveSessionUIMessages(this.host, uiMessages, this.tracker, sessionId).then(
      (saved) => this.emitPersist("force", uiMessages.length, startedAt, saved, sessionId),
      (err) => {
        this.emitPersist("force", uiMessages.length, startedAt, false, sessionId);
        this.reportBackgroundPersistError(err, sessionId);
      }
    );
  }

  /**
   * Force-persist the current transcript and report whether it landed, bypassing the fingerprint
   * short-circuit. Used when a synthetic message is ALREADY on the channel (a retry after a failed
   * write): there is no new content to queue, but the previous write still has to succeed before
   * the delivery may be marked.
   */
  persistUiMessagesNow(uiMessages: UIMessage[]): Promise<boolean> {
    const sessionId = this.host.session.getSessionData()?.id;
    const startedAt = Date.now();
    return saveSessionUIMessages(this.host, uiMessages, this.tracker, sessionId).then(
      (saved) => {
        this.emitPersist("force", uiMessages.length, startedAt, saved, sessionId);
        return saved;
      },
      (err) => {
        this.emitPersist("force", uiMessages.length, startedAt, false, sessionId);
        this.reportBackgroundPersistError(err, sessionId);
        return false;
      }
    );
  }

  /**
   * File the transcript write outcome as a bus event (the log policy decides the row).
   *
   * `written:false, skipped:true` is the fingerprint no-op; `written:false` without `skipped` is a
   * refusal (switch/closed) or a failed write. This is what makes a turn that sits unpersisted for
   * a long `task` batch visible without watching the file's mtime.
   *
   * The session id is the one CAPTURED before the write, not re-read here: a write for session A
   * that completes after `/resume` adopted B must not be filed under B (the same reason the error
   * reporter receives the captured id).
   */
  private emitPersist(
    reason: SessionSaveReason,
    messages: number,
    startedAt: number,
    written: boolean,
    sessionId: string | undefined,
    skipped = false
  ): void {
    this.host.emitEvent(
      "session:persist",
      {
        reason,
        messages,
        written,
        ...(skipped ? { skipped: true } : {}),
        durationMs: Date.now() - startedAt,
      },
      ...(sessionId ? [{ sessionId }] : [])
    );
  }

  /** Awaitable state-only persist (rename/title need the write to land before returning). */
  async persistStateNow(): Promise<boolean> {
    const sessionId = this.host.session.getSessionData()?.id;
    return this.host.session.persistSession(() => ({
      ...getSessionPersistInput(this.host),
      ...(sessionId ? { sessionId } : {}),
    }));
  }

  /** Persist model/state only (usage, todos, mode); does not write `uiMessages`. */
  persistState(): void {
    const sessionId = this.host.session.getSessionData()?.id;
    void this.host.session
      .persistSession(() => ({
        ...getSessionPersistInput(this.host),
        ...(sessionId ? { sessionId } : {}),
      }))
      .catch((err) => this.reportBackgroundPersistError(err, sessionId));
  }

  /** Restore the store snapshot + agent state; called inside `ManagedAgent.restoreSession`. */
  async restore(sessionId: string, options?: { repairRuntime?: boolean; silent?: boolean }): Promise<SessionData> {
    return restoreManagedSession(this.host, sessionId, options);
  }

  /**
   * Suspend writes while a restore applies the TARGET's model/effort to the host.
   *
   * `restoreManagedSession` adopts the target last; the setters that run before that would
   * otherwise persist the target's selection into the leaving session's file.
   */
  pauseWrites(): void {
    this.host.session.pausePersist();
  }

  resumeWrites(): void {
    this.host.session.resumePersist();
  }

  /**
   * Give up a restore stand-in after a failed load.
   *
   * Without this the refusal in {@link SessionService.setSessionDataPlaceholder} outlives the failed
   * switch and every later write on this agent is dropped.
   */
  clearRestorePlaceholder(): void {
    this.host.session.clearRestorePlaceholder();
  }

  /**
   * Backstop for fire-and-forget persists. Without it a rejected persist (e.g. a
   * media/dehydrate IO error thrown outside `saveToStore`) becomes an unhandled
   * rejection — and there is no global `unhandledRejection` handler, so the host
   * process would crash. Surface it as `session:save-error` instead.
   */
  private reportBackgroundPersistError(error: unknown, sessionId?: string): void {
    const message = errorMessage(error);
    // One fact, one row: this used to write the seam directly AND emit the same failure, so a
    // background persist error appeared twice (and only one of the two carried `event`).
    //
    // A failed write is asynchronous, so a `/resume` or `/new` can commit before it lands. Name the
    // session the write belonged to explicitly so the ROW says which conversation lost the write;
    // the envelope's default would name the target. The row still lands in the sink currently
    // bound (the target's file) — bindings follow the live session, and re-pointing the sink from a
    // background save would race the switch. The explicit id is what makes the row attributable.
    this.host.emitEvent(
      "session:save-error",
      { target: "session+uiMessages", error: message },
      sessionId !== undefined ? { sessionId } : undefined
    );
  }
}
