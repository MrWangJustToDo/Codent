/**
 * Agent-side session persistence: the sync fingerprint, save/clear/persist entry points and the
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

  /** Force-persist `uiMessages` (slash commands such as `/clear`). */
  save(uiMessages: UIMessage[]): void {
    const sessionId = this.host.session.getSessionData()?.id;
    void saveSessionUIMessages(this.host, uiMessages, this.tracker, sessionId).catch((err) =>
      this.reportBackgroundPersistError(err)
    );
  }

  /** Persist an empty transcript as the session content (`/clear`). */
  clear(): void {
    void this.clearNow().catch((err) => this.reportBackgroundPersistError(err));
  }

  /**
   * Await the forced empty write. `/clear` calls this BEFORE rotating sessions, so the old
   * session is actually blanked instead of the queued thunk resolving against the new one.
   */
  async clearNow(): Promise<boolean> {
    const sessionId = this.host.session.getSessionData()?.id;
    const persisted = await this.host.session.persistSession(() => ({
      ...getSessionPersistInput(this.host),
      ...(sessionId ? { sessionId } : {}),
      uiMessages: [],
      forceEmptyMessages: true,
    }));
    if (persisted) this.tracker.reset([]);
    return persisted;
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
   * Backstop for fire-and-forget persists. Without it a rejected persist (e.g. a
   * media/dehydrate IO error thrown outside `saveToStore`) becomes an unhandled
   * rejection — and there is no global `unhandledRejection` handler, so the host
   * process would crash. Surface it as `session:save-error` instead.
   */
  private reportBackgroundPersistError(error: unknown): void {
    const message = errorMessage(error);
    this.host.getLog?.()?.warn("system", "background session persist failed", { error: message });
    this.host.emitEvent("session:save-error", { target: "session+uiMessages", error: message });
  }
}
