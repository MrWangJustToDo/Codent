/**
 * Session-scoped lifecycle owner.
 *
 * A session switch is not a list of unrelated cleanups: it is one ordered transaction.
 * This service is the single place that stops producers before clearing their buffers and
 * resets the transient state they write into.
 */

import type { CompactionService } from "./compaction-service.js";
import type { MemoryService } from "./memory-service.js";
import type { ToolApprovalTable } from "../../agent/approval/tool-approval-table.js";
import type { SessionStore } from "../../agent/persistence/session-store.js";
import type { SessionData } from "../../agent/persistence/types.js";
import type { AgentStreamHub } from "../../agent/stream-hub/agent-stream-hub.js";
import type { TodoManager } from "../../agent/todo";
import type { AgentChatController } from "../controllers/agent-chat-controller.js";
import type { AgentStatusController } from "../controllers/agent-status-controller.js";
import type { ModeCoordinator } from "../mode-coordinator.js";
import type { RunCoordinator } from "../run-coordinator.js";
import type { SessionPersistence } from "../session-persistence.js";
import type { UsageTracker } from "../telemetry/usage-tracker.js";

export type SessionLifecycleReason =
  "session-switch" | "session-new" | "session-resume" | "session-clear" | "agent-destroy";

/** Everything the lifecycle service needs from its owning agent. */
export interface SessionLifecycleHost {
  readonly sessionPersistence: SessionPersistence;
  getSessionData(): SessionData | null;
  setSessionData(data: SessionData): void;
  getSessionStore(): SessionStore | null;
  clearPersistedSession(): Promise<boolean>;
  getChatController(): AgentChatController | undefined;
  acquireSessionOwnership(sessionId: string): boolean;
  releaseSessionOwnership(sessionId: string): void;
  bindSessionLogSink(sessionId?: string): void;
  emitSessionNew(sessionId: string, reason: string): void;
  emitSessionSwitch(fromSessionId: string, toSessionId: string, messageCount: number): void;
  refreshState(): void;
  readonly mode: ModeCoordinator;
  readonly approvals: ToolApprovalTable;
  readonly run: RunCoordinator;
  readonly compaction: CompactionService;
  readonly statusController: AgentStatusController;
  readonly memory: MemoryService;
  readonly usage: UsageTracker;
  readonly streamHub: AgentStreamHub;
  getTodoManager(): TodoManager | null;
  stopActiveRun(reason: string): void;
  abortManualCompaction(reason: string): void;
  cascadeAbortToChildren(reason?: string): void;
  discardPreforkRuns(): void;
  clearErrorAndRetry(): void;
  clearPendingApprovals(): void;
  resetMediaHydrationMisses(): void;
  resetTurnContext(): void;
}

export class SessionLifecycleService {
  constructor(private readonly host: SessionLifecycleHost) {}

  /**
   * Stop every producer that can still write session-scoped state.
   *
   * Order is the contract: abort work first, settle command previews, then let the caller clear
   * buffers. A producer started after the buffer is cleared must be impossible.
   */
  stop(reason: SessionLifecycleReason = "session-switch"): void {
    this.host.abortManualCompaction(reason);
    this.host.stopActiveRun(reason);
    this.host.cascadeAbortToChildren(reason);
    this.host.discardPreforkRuns();
    this.host.streamHub.endAllCommands();
  }

  /**
   * Stop producers and clear all transient session state.
   *
   * This is the reset path for session.new and agent reset; session.resume uses `stop()` and
   * restores its own state. It deliberately does not clear the UI transcript, rotate the
   * session, or touch ownership; those remain part of the switch transaction in
   * `session-lifecycle-commands.ts`.
   */
  reset(reason: SessionLifecycleReason = "session-switch"): void {
    this.stop(reason);

    this.host.mode.reset();
    this.host.approvals.clear();
    this.host.run.resetRunState();
    this.host.run.resetTurnLifecycle();
    this.host.compaction.resetReactiveCompactRetries();
    this.host.statusController.resetToIdle();
    this.host.clearErrorAndRetry();
    this.host.clearPendingApprovals();
    this.host.memory.resetState();
    this.host.usage.reset();
    this.host.resetMediaHydrationMisses();
    this.host.getTodoManager()?.reset();
    this.host.streamHub.clearAll();
    this.host.resetTurnContext();
  }

  /**
   * Start a brand-new disk session and rotate the agent onto it.
   *
   * The old transcript is blanked before the new id is adopted so a queued write cannot resolve
   * against the new session.
   */
  async newSession(reason: "session-new" | "session-clear" = "session-new"): Promise<SessionData> {
    const store = this.host.getSessionStore();
    if (!store) throw new Error("Session store not available");

    const current = this.host.getSessionData();
    this.reset(reason);

    if (current?.id) this.host.releaseSessionOwnership(current.id);
    await this.host.clearPersistedSession();
    this.host.getChatController()?.clearMessages({ persistEmpty: false });

    const next = store.create({
      modelStyle: current?.modelStyle ?? "openai",
      model: current?.model ?? "unknown",
    });
    this.host.setSessionData(next);
    this.host.acquireSessionOwnership(next.id);
    this.host.emitSessionNew(next.id, "clear");
    this.host.refreshState();
    return next;
  }

  /**
   * Switch to an existing disk session.
   *
   * Ownership is acquired before any state is touched. The old claim is released only after a
   * successful restore; a failed restore either releases the target (nothing moved) or treats the
   * adopted data as the completed switch and releases the old claim.
   */
  async resume(sessionId: string): Promise<SessionData> {
    if (!this.host.acquireSessionOwnership(sessionId)) {
      throw new Error(`Session "${sessionId}" is already active in another live session and cannot be resumed here.`);
    }

    const leavingId = this.host.getSessionData()?.id;
    let restored = false;
    try {
      this.stop("session-resume");
      this.host.streamHub.clearAll();

      if (leavingId && leavingId !== sessionId) {
        this.host.emitSessionSwitch(leavingId, sessionId, this.host.getSessionData()?.uiMessages.length ?? 0);
      }

      this.host.bindSessionLogSink(sessionId);
      const session = await this.host.sessionPersistence.restore(sessionId);
      restored = true;

      if (leavingId && leavingId !== sessionId) this.host.releaseSessionOwnership(leavingId);
      this.host.bindSessionLogSink();
      return session;
    } catch (err) {
      const switched = this.host.getSessionData()?.id === sessionId;
      if (!restored && !switched) {
        this.host.releaseSessionOwnership(sessionId);
        this.host.bindSessionLogSink();
      }
      if (switched) {
        if (leavingId && leavingId !== sessionId) this.host.releaseSessionOwnership(leavingId);
        this.host.sessionPersistence.resetTracker(this.host.getSessionData()?.uiMessages);
        this.host.streamHub.clearAll();
        this.host.bindSessionLogSink();
      }
      throw err;
    }
  }
}
