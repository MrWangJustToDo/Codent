/**
 * Agent-side session persistence: the sync fingerprint, save/persist entry points and the
 * restore transaction.
 *
 * `SessionService` owns the store and the serialized disk write; this class owns "what this agent
 * has already persisted" and the one best-effort error path every fire-and-forget caller shares.
 * `ManagedAgent.restoreSession` keeps only the lifecycle wrapper (ownership, session:switch, log
 * sink rebinding) around {@link SessionPersistence.restore}.
 */

import {
  createSessionSyncTracker,
  type SessionSaveReason,
  type SessionSyncTracker,
} from "../agent/persistence/session-sync-tracker.js";
import { errorMessage } from "../utils/errors.js";

import { getSessionPersistInput, restoreManagedSession, saveSessionUIMessages } from "./managed-agent-session.js";

import type { SessionHost } from "./managed-agent-session.js";
import type { SessionData } from "../agent/persistence/types.js";
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

  /** Persist `uiMessages` when an explicit trigger fires and the fingerprint changed. */
  maybeSave(uiMessages: UIMessage[], reason: SessionSaveReason): void {
    if (uiMessages.length === 0) return;
    if (!this.tracker.shouldPersist(uiMessages, { reason })) return;
    const sessionId = this.host.session.getSessionData()?.id;
    void saveSessionUIMessages(this.host, uiMessages, this.tracker, sessionId).catch((err) =>
      this.reportBackgroundPersistError(err)
    );
  }

  /** Force-persist `uiMessages` (explicit slash-command flushes). */
  save(uiMessages: UIMessage[]): void {
    const sessionId = this.host.session.getSessionData()?.id;
    void saveSessionUIMessages(this.host, uiMessages, this.tracker, sessionId).catch((err) =>
      this.reportBackgroundPersistError(err)
    );
  }

  /** Persist model/state only (usage, todos, mode); does not write `uiMessages`. */
  persistState(): void {
    const sessionId = this.host.session.getSessionData()?.id;
    void this.host.session
      .persistSession(() => ({
        ...getSessionPersistInput(this.host),
        ...(sessionId ? { sessionId } : {}),
      }))
      .catch((err) => this.reportBackgroundPersistError(err));
  }

  /** Restore the store snapshot + agent state; called inside `ManagedAgent.restoreSession`. */
  async restore(sessionId: string): Promise<SessionData> {
    return restoreManagedSession(this.host, sessionId, this.tracker);
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
  private reportBackgroundPersistError(error: unknown): void {
    const message = errorMessage(error);
    // One fact, one row: this used to write the seam directly AND emit the same failure, so a
    // background persist error appeared twice (and only one of the two carried `event`).
    this.host.emitEvent("session:save-error", { target: "session+uiMessages", error: message });
  }
}
