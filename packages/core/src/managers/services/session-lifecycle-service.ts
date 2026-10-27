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
import type { UIMessage } from "@tanstack/ai";

export type SessionLifecycleReason = "session-switch" | "session-new" | "session-resume" | "agent-destroy";

/** Everything the lifecycle service needs from its owning agent. */
export interface SessionLifecycleHost {
  readonly sessionPersistence: SessionPersistence;
  getSessionData(): SessionData | null;
  setSessionData(data: SessionData): void;
  getSessionStore(): SessionStore | null;
  awaitSessionPersistIdle(): Promise<void>;
  getChatController(): AgentChatController | undefined;
  acquireSessionOwnership(sessionId: string): boolean;
  releaseSessionOwnership(sessionId: string): void;
  bindSessionLogSink(sessionId?: string, options?: { sessionBoundary?: boolean }): void;
  emitSessionNew(sessionId: string, reason: "session-new"): void;
  emitSessionSwitch(fromSessionId: string, toSessionId: string, messageCount: number): void;
  refreshState(): void;
  refreshSubagents(): void;
  beginStateBatch?(): void;
  endStateBatch?(): void;
  syncInteractionStateFromUIMessages?(messages: UIMessage[]): void;
  resetRunOutcome?(): void;
  /** Projection cache keyed by toolCallId; entries are conversation-scoped. */
  getToolCompactCache?(): { clear(): void };
  readonly mode: ModeCoordinator;
  readonly approvals: ToolApprovalTable;
  readonly run: RunCoordinator;
  getCompaction(): CompactionService;
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
  resetSessionSyncTracker(): void;
  resetIterationProgress(): void;
  resetCommandJobs(reason: string): void;
}

export class SessionLifecycleService {
  /** Serializes complete session transitions; each switch has multiple awaits and one owner. */
  private switchInFlight: Promise<unknown> = Promise.resolve();
  /** Set by {@link settle}; prevents a teardown window from admitting a new switch. */
  private disposed = false;

  constructor(private readonly host: SessionLifecycleHost) {}

  private serializeSwitch<T>(operation: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("Agent is being destroyed; session switch refused."));
    const run = this.switchInFlight.then(operation, operation);
    this.switchInFlight = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * Stop accepting switches and wait for an already-admitted transition to finish.
   *
   * Teardown calls this before closing persistence and releasing ownership: otherwise a
   * `resume`/`new` that started just before destroy can adopt a session, bind a log sink, and
   * reattach producers after the sink was flushed and the claim was released.
   */
  async settle(): Promise<void> {
    this.disposed = true;
    await this.switchInFlight;
  }

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
   * This is the reset half of the session transaction. `newSession()` and `resume()` compose it
   * with transcript rotation / restore, ownership and log-sink rebinding.
   */
  reset(reason: SessionLifecycleReason = "session-switch"): void {
    this.host.beginStateBatch?.();
    try {
      this.stop(reason);
      this.resetTransientState(reason, "full");
    } finally {
      this.host.endStateBatch?.();
    }
  }

  /**
   * Clear transient session state, in one order for both scopes.
   *
   * `full` is the `reset()` / new-session path: it also clears the persisted-looking parts
   * (mode, approvals, usage, todos). `resume` is the after-restore path, which must NOT clear
   * those before a successful load — a failed target would otherwise reset the current session's
   * mode/approvals/usage/todos even though the session did not switch.
   *
   * The two scopes used to be two hand-maintained lists of the same calls; every new transient
   * field had to be added to both. One ordered list with scoped calls makes the invariant
   * structural (the shared order below is identical in both paths).
   */
  private resetTransientState(reason: SessionLifecycleReason, scope: "full" | "resume"): void {
    const full = scope === "full";
    if (full) {
      this.host.mode.reset();
      this.host.approvals.clear();
    }
    this.host.run.resetRunState();
    this.host.run.resetTurnLifecycle();
    this.host.getCompaction().resetReactiveCompactRetries();
    this.host.statusController.resetToIdle();
    this.host.clearErrorAndRetry();
    if (full) this.host.clearPendingApprovals();
    this.host.memory.resetState();
    if (full) {
      this.host.usage.reset();
      this.host.resetMediaHydrationMisses();
      this.host.getTodoManager()?.reset();
      this.host.getToolCompactCache?.().clear();
    }
    this.host.streamHub.clearAll();
    this.host.resetTurnContext();
    if (full) this.host.resetSessionSyncTracker();
    this.host.resetIterationProgress();
    this.host.resetRunOutcome?.();
    this.host.resetCommandJobs(reason);
  }

  /**
   * Start a brand-new disk session and rotate the agent onto it.
   *
   * The previous session is left intact on disk: creating a conversation never clears one. Its
   * latest transcript is drained (the caller can resume it) before the new id is adopted.
   */
  async newSession(reason: "session-new" = "session-new"): Promise<SessionData> {
    return this.serializeSwitch(() => this.runTransition(() => this.newSessionInner(reason)));
  }

  /** Publish one final L1 frame after a complete unload/load transaction. */
  private async runTransition<T>(operation: () => Promise<T>): Promise<T> {
    this.host.beginStateBatch?.();
    try {
      return await operation();
    } finally {
      this.host.endStateBatch?.();
    }
  }

  /**
   * Unload the current conversation before loading the next one.
   *
   * This is the shared first half of `new` and `resume`: stop every producer and drain the
   * write it may have queued. It deliberately does not publish L1 state; the caller commits
   * the target and {@link runTransition} publishes one final frame.
   */
  private async unloadCurrent(reason: SessionLifecycleReason): Promise<void> {
    this.stop(reason);
    await this.host.awaitSessionPersistIdle();
  }

  private async newSessionInner(reason: "session-new"): Promise<SessionData> {
    const store = this.host.getSessionStore();
    if (!store) throw new Error("Session store not available");

    const current = this.host.getSessionData();
    const next = store.create({
      modelStyle: current?.modelStyle ?? "openai",
      model: current?.model ?? "unknown",
    });
    if (!this.host.acquireSessionOwnership(next.id)) {
      throw new Error(`Session "${next.id}" is already active in another live session and cannot be started here.`);
    }

    let adopted = false;
    try {
      // Unload the current conversation. The previous session stays on disk untouched:
      // starting a new conversation is not a clear.
      await this.unloadCurrent(reason);

      // Adopt the new session before applying the reset. The reset then operates on the
      // target's empty state, and the state batch suppresses the intermediate frames that
      // used to carry the old session id.
      this.host.setSessionData(next);
      adopted = true;
      this.host.getChatController()?.clearTranscript();
      this.resetTransientState(reason, "full");
      this.host.refreshSubagents?.();
      if (current?.id) this.host.releaseSessionOwnership(current.id);
      this.host.emitSessionNew(next.id, reason);
      this.host.refreshState();
      return next;
    } catch (error) {
      if (!adopted) {
        this.host.releaseSessionOwnership(next.id);
      } else {
        // The switch committed when `setSessionData(next)` ran. A later reset step failing does
        // not un-switch it, so the departure claim must be released here exactly as the resume
        // path does — otherwise the old id stays "active in another live session" for the life
        // of the agent and can never be resumed. Point writers at the adopted id too.
        if (current?.id) this.host.releaseSessionOwnership(current.id);
        this.host.bindSessionLogSink(next.id);
      }
      throw error;
    }
  }

  /**
   * Switch to an existing disk session.
   *
   * Ownership is acquired before any state is touched. The old claim is released only after a
   * successful restore; a failed restore either releases the target (nothing moved) or treats the
   * adopted data as the completed switch and releases the old claim.
   */
  async resume(sessionId: string): Promise<SessionData> {
    return this.serializeSwitch(() => this.runTransition(() => this.resumeInner(sessionId)));
  }

  private async resumeInner(sessionId: string): Promise<SessionData> {
    if (!this.host.acquireSessionOwnership(sessionId)) {
      throw new Error(`Session "${sessionId}" is already active in another live session and cannot be resumed here.`);
    }

    const leavingId = this.host.getSessionData()?.id;
    let restored = false;
    try {
      // Drain whatever was already queued before the abort, then drain again after it:
      // `stop()` can synchronously queue a `pump-complete` write through
      // `interruptCurrentRun`, and that write must settle before `restore` replaces the
      // active session.
      await this.host.awaitSessionPersistIdle();
      // stop() may queue a final pump-complete write; unloadCurrent drains it.
      await this.unloadCurrent("session-resume");

      this.host.bindSessionLogSink(sessionId);
      const session = await this.host.sessionPersistence.restore(sessionId);
      // Clear volatile state only after the target load succeeded. This avoids a
      // partial reset of the current session when the target is missing/unreadable.
      this.resetTransientState("session-resume", "resume");
      // The reset makes the status idle; re-apply the restored interaction state so a
      // session that was waiting on approval/ask_user does not come back as idle.
      this.host.syncInteractionStateFromUIMessages?.(session.uiMessages);
      this.host.refreshSubagents?.();
      restored = true;

      if (leavingId && leavingId !== sessionId) {
        // `session:restore` above belongs to the target. The departure entry belongs to the
        // session being left, so temporarily point the sink back before emitting it.
        this.host.bindSessionLogSink(leavingId, { sessionBoundary: false });
        try {
          this.host.emitSessionSwitch(leavingId, sessionId, session.uiMessages.length);
        } finally {
          this.host.bindSessionLogSink(sessionId);
        }
        this.host.releaseSessionOwnership(leavingId);
      }
      this.host.bindSessionLogSink();
      this.host.refreshState();
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
