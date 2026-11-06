/**
 * Session facet: identity writes, the sync tracker and the persistence entry points.
 *
 * The switch transaction lives in `SessionLifecycleService`; this facet is the agent-side view the
 * transaction mutates (`setSessionData` / placeholder) and the place every fire-and-forget save
 * goes through. Keeping it separate means `ManagedAgent` delegates instead of owning the tracker.
 */

import { SessionPersistence } from "./session-persistence.js";

import type { SessionHost } from "../../runtime-types/session-host.js";
import type { SessionSaveReason } from "../persistence/session-sync-tracker.js";
import type { SessionData } from "../persistence/types.js";
import type { UIMessage } from "@tanstack/ai";

export class SessionFacet {
  readonly persistence: SessionPersistence;

  constructor(private readonly host: SessionHost) {
    this.persistence = new SessionPersistence(host);
  }

  getSessionData(): SessionData | null {
    return this.host.session.getSessionData();
  }

  /** Adopt a session id; the workspace log file is independent of session identity. */
  setSessionData(data: SessionData): void {
    this.host.session.setSessionData(data);
  }

  /** Adopt the restore stand-in; every persist dispatched while it is active is refused. */
  setSessionDataPlaceholder(data: SessionData): void {
    this.host.session.setSessionDataPlaceholder(data);
  }

  maybeSaveSessionUIMessages(uiMessages: UIMessage[], reason: SessionSaveReason): Promise<boolean> | undefined {
    return this.persistence.maybeSave(uiMessages, reason);
  }

  /** Force-persist the transcript and report whether it landed (background delivery gate). */
  persistSessionUIMessagesNow(uiMessages: UIMessage[]): Promise<boolean> {
    return this.persistence.persistUiMessagesNow(uiMessages);
  }

  saveSessionUIMessages(uiMessages: UIMessage[]): void {
    this.persistence.save(uiMessages);
  }

  resetSessionSyncTracker(uiMessages?: UIMessage[]): void {
    this.persistence.resetTracker(uiMessages);
  }

  persistSession(): void {
    this.persistence.persistState();
  }

  persistSessionNow(): Promise<boolean> {
    return this.persistence.persistStateNow();
  }
}
