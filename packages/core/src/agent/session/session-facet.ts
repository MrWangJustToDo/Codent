/**
 * Session facet: the agent-side view of session identity + persistence.
 *
 * Three layers are intentional and each owns a distinct question — do not flatten them without
 * moving the question:
 * - `SessionFacet` (here): what `ManagedAgent` exposes (`setSessionData` / placeholder, and the
 *   fire-and-forget save entry points).
 * - `SessionPersistence` (`session-persistence.ts`): what THIS agent has already persisted (tracker,
 *   coalescing, the "refuse a write aimed at another session" guard).
 * - `SessionService` (`managers/services/session-service.ts`): the store itself (read/restore/rotate)
 *   and the serialized write.
 *
 * The switch transaction lives in `SessionLifecycleService`; this file never decides a switch.
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
