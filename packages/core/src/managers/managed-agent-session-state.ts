/**
 * Session facet: identity writes, the sync tracker and the persistence entry points.
 *
 * The switch transaction lives in `SessionLifecycleService`; this facet is the agent-side view the
 * transaction mutates (`setSessionData` / placeholder) and the place every fire-and-forget save
 * goes through. Keeping it separate means `ManagedAgent` delegates instead of owning the tracker.
 */

import { SessionPersistence } from "./session-persistence.js";

import type { SessionHost } from "./managed-agent-session.js";
import type { SessionSaveReason } from "../agent/persistence/session-sync-tracker.js";
import type { SessionData } from "../agent/persistence/types.js";
import type { UIMessage } from "@tanstack/ai";

export interface SessionFacetOptions {
  /** True after the factory attached a manager; before that the log sink is bound by `add`. */
  hasManager: () => boolean;
  bindSessionLogSink: (sessionId: string) => void;
}

export class SessionFacet {
  readonly persistence: SessionPersistence;

  constructor(
    private readonly host: SessionHost,
    private readonly options: SessionFacetOptions
  ) {
    this.persistence = new SessionPersistence(host);
  }

  getSessionData(): SessionData | null {
    return this.host.session.getSessionData();
  }

  /** Adopt a session id; the log sink follows the identity when a manager is attached. */
  setSessionData(data: SessionData): void {
    const previousId = this.getSessionData()?.id;
    this.host.session.setSessionData(data);
    if (this.options.hasManager() && data.id && data.id !== previousId) this.options.bindSessionLogSink(data.id);
  }

  /** Adopt the restore stand-in; every persist dispatched while it is active is refused. */
  setSessionDataPlaceholder(data: SessionData): void {
    const previousId = this.getSessionData()?.id;
    this.host.session.setSessionDataPlaceholder(data);
    if (this.options.hasManager() && data.id && data.id !== previousId) this.options.bindSessionLogSink(data.id);
  }

  maybeSaveSessionUIMessages(uiMessages: UIMessage[], reason: SessionSaveReason): void {
    this.persistence.maybeSave(uiMessages, reason);
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
}
