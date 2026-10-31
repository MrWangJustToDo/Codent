/**
 * Session-scoped lifecycle owner.
 *
 * A session switch is not a list of unrelated cleanups: it is one ordered transaction.
 * This service is the single place that stops producers before clearing their buffers and
 * resets the transient state they write into.
 */

import { errorMessage } from "../../utils/errors.js";

import type { CompactionService } from "./compaction-service.js";
import type { MemoryService } from "./memory-service.js";
import type { ToolApprovalTable } from "../../agent/approval/tool-approval-table.js";
import type { SessionStore } from "../../agent/persistence/session-store.js";
import type { SessionData } from "../../agent/persistence/types.js";
import type { AgentStreamHub } from "../../agent/stream-hub/agent-stream-hub.js";
import type { TodoManager } from "../../agent/todo";
import type { SessionSwitchReason } from "../../runtime-types/agent-event-payloads.js";
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
  emitSessionSwitch(
    fromSessionId: string,
    toSessionId: string,
    messageCount: number,
    reason?: SessionSwitchReason
  ): void;
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
  /** Drop input queued while the agent was busy — a teardown has no turn to deliver it to. */
  clearQueuedInput(): void;
  abortManualCompaction(reason: string): void;
  cascadeAbortToChildren(reason?: string): void;
  discardPreforkRuns(): void;
  clearErrorAndRetry(): void;
  clearPendingApprovals(): void;
  resetMediaHydrationMisses(): void;
  resetTurnContext(): void;
  /** Drop extension render slots: they describe the conversation being replaced. */
  clearExtensionUi?(): void;
  resetSessionSyncTracker(): void;
  resetIterationProgress(): void;
  /** Drop per-task phase records and any pre-fork seat registered for the left conversation. */
  clearTaskRuns(): void;
  /**
   * Destroy the subagents that belonged to the conversation being replaced.
   *
   * A switch is not a stop: aborting them leaves every child registered (with its UI channel and
   * full exploration transcript) until the ROOT agent is destroyed, so a long-lived host kept one
   * copy per historical `task` — and the parent rebuilt its subagent list from all of them on every
   * child status change. Tasks are deliberately `autoDestroy: false` (the preview outlives the
   * run), which makes this the only place that can release them without losing the live preview.
   */
  destroyChildAgents(reason: string): void;
  resetCommandJobs(reason: string): void;
  /** Non-fatal diagnostics (post-commit step failures that must not fail the switch). */
  warn?(message: string, data?: Record<string, unknown>): void;
}

export class SessionLifecycleService {
  /** Serializes complete session transitions; each switch has multiple awaits and one owner. */
  private switchInFlight: Promise<unknown> = Promise.resolve();
  /** Set by {@link settle}; prevents a teardown window from admitting a new switch. */
  private disposed = false;
  /**
   * Admitted transitions that have not settled. Counted at ADMISSION (synchronously), not when
   * `runTransition` starts a microtask later: a send/compact arriving in that gap used to see
   * "not switching" and write into the session being left.
   */
  private pendingSwitches = 0;

  constructor(private readonly host: SessionLifecycleHost) {}

  private serializeSwitch<T>(operation: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("Agent is being destroyed; session switch refused."));
    this.pendingSwitches += 1;
    const run = this.switchInFlight.then(operation, operation);
    this.switchInFlight = run.then(
      () => {
        this.pendingSwitches -= 1;
      },
      () => {
        this.pendingSwitches -= 1;
      }
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
    // A manual compaction has no pump, so `stopActiveRun` does not clear its queue; and a
    // compaction aborted by this switch can settle AFTER the caller starts awaiting the restore,
    // where `resumeAfterCompaction()` would drain input into the session being replaced (or start
    // a turn on the new one). Drop it here, where every switch path passes.
    this.host.clearQueuedInput();
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
    // Extension render slots describe the conversation, not the agent: a plan board or file tree
    // published for the old transcript must not survive into the new one (and must not be replayed
    // to a later subscriber as that session's initial state).
    this.host.clearExtensionUi?.();
    if (full) this.host.resetSessionSyncTracker();
    this.host.resetIterationProgress();
    // Session-scoped, like the iteration progress above: a completed task keeps its row for the
    // preview, but the conversation it belonged to is gone. Destroying them (not just aborting)
    // is what releases the child's UI channel, log sink and tool state; `clearTaskRuns` below then
    // drops the phase records/pre-fork seats that pointed at them.
    this.host.destroyChildAgents(reason);
    this.host.clearTaskRuns();
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

  /**
   * Whether a new/resume transaction is admitted and not yet settled (including queued ones).
   *
   * The window spans the whole unload → load transaction, including a second switch queued behind
   * the first. Every interaction offered inside it is dropped (not redirected into the target and
   * not queued for a turn whose transcript is being replaced): see `AgentChatController`'s
   * `dropIfSwitching`.
   */
  isTransitioning(): boolean {
    return this.pendingSwitches > 0;
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
   * Switch to an existing disk session: `unload` the current conversation, then `load` the target.
   *
   * Two phases, one commit:
   *
   * - **unload** stops every producer and drains the write it may have queued. It does NOT adopt
   *   anything, so a failed load leaves the leaving session intact and active.
   * - **load** reads + hydrates the target, prepares mode/approvals/model, and adopts it LAST
   *   (`restoreManagedSession`'s commit). Everything that can fail runs before that adoption.
   * - **recovery** is the same load applied to the departure: a load that does not commit is a
   *   failed load, and re-opening the session that is still active is what restores its model,
   *   mode, approvals and transcript (see {@link recoverLeavingSession}).
   *
   * Ownership is acquired up front and handed over only after the commit; the old claim is released
   * at the same moment, so "active in another live session" always describes a real holder.
   */
  async resume(sessionId: string, reason: SessionSwitchReason = "resume"): Promise<SessionData> {
    return this.serializeSwitch(() => this.runTransition(() => this.resumeInner(sessionId, reason)));
  }

  private async resumeInner(sessionId: string, reason: SessionSwitchReason): Promise<SessionData> {
    if (!this.host.acquireSessionOwnership(sessionId)) {
      throw new Error(`Session "${sessionId}" is already active in another live session and cannot be resumed here.`);
    }

    // Snapshot the departure BEFORE the load: the count belongs to the session being left, and once
    // the load commits `getSessionData()` is the target.
    const leaving = this.host.getSessionData();
    const leavingId = leaving?.id;
    const leavingMessageCount = leaving?.uiMessages.length ?? 0;

    try {
      // Drain what was already queued, then unload: `stop()` can synchronously queue a
      // `pump-complete` write through `interruptCurrentRun`, and both writes must settle before the
      // restore replaces the active session.
      await this.host.awaitSessionPersistIdle();
      await this.unloadCurrent("session-resume");

      // Restore-time logs belong to the target. A load that never commits re-points the sink at the
      // still-active leaving session in the catch below.
      this.host.bindSessionLogSink(sessionId);
      const session = await this.host.sessionPersistence.restore(sessionId);

      // COMMITTED: the restore adopted the target last, so the old claim is free from here on.
      if (leavingId && leavingId !== sessionId) this.host.releaseSessionOwnership(leavingId);

      try {
        // Clear the leaving run's volatile state. The `resume` scope keeps mode/approvals/usage/todos —
        // the restore just adopted those.
        this.resetTransientState("session-resume", "resume");
        // The reset makes the status idle; re-apply the restored interaction state so a session that
        // was waiting on approval/ask_user does not come back as idle.
        this.host.syncInteractionStateFromUIMessages?.(session.uiMessages);
        this.host.refreshSubagents?.();

        if (leavingId && leavingId !== sessionId) {
          // The departure entry belongs to the session being left, so point the sink back for this one
          // line, then re-attach the target WITHOUT a second boundary (the target's boundary was
          // written when its sink was bound above).
          this.host.bindSessionLogSink(leavingId, { sessionBoundary: false });
          try {
            this.host.emitSessionSwitch(leavingId, sessionId, leavingMessageCount, reason);
          } finally {
            this.host.bindSessionLogSink(sessionId, { sessionBoundary: false });
          }
        }
        this.host.refreshState();
      } catch (error) {
        // Past the commit the switch HAS happened. Surfacing this as a failed resume made the host
        // report a failure for a state it is actually in; report and keep the switch instead.
        this.host.warn?.("session resume post-commit step failed", {
          error: errorMessage(error),
        });
      }
      return session;
    } catch (error) {
      // No commit ⇒ the leaving session is still the active one. Give the target claim back,
      // re-point the log sink at the departure (the recovery's own `session:restore` row belongs to
      // it), then RE-OPEN it through the same load path the switch uses.
      //
      // A post-commit failure keeps the switch (the state is already coherent); it simply surfaces.
      //
      // A bootstrap stand-in must be dropped too: it refuses every write by design, so leaving it
      // behind after a failed load would turn one failed resume into a silently unsaved session.
      this.host.sessionPersistence.clearRestorePlaceholder();
      if (this.host.getSessionData()?.id !== sessionId) {
        this.host.releaseSessionOwnership(sessionId);
        this.host.bindSessionLogSink(leavingId, { sessionBoundary: false });
        await this.recoverLeavingSession(leavingId);
      }
      throw error;
    }
  }

  /**
   * Re-open the session a failed `/resume` never left.
   *
   * A switch is unload → load. A load that does not commit is simply a failed load, and the
   * recovery is the SAME load applied to the session that is still active — not a hand-maintained
   * snapshot of model / effort / mode / approvals / transcript, which would be a second copy of
   * that state and the copy that can drift. The departure's disk record is authoritative because
   * `unloadCurrent` stopped the run and drained every queued write before the target was read, so a
   * failed load cannot have produced newer state worth preserving.
   *
   * A session that was never written (fresh, no content yet) has nothing to reload; nothing was
   * adopted for it either, so it stays as it was.
   */
  private async recoverLeavingSession(leavingId: string | undefined): Promise<void> {
    if (!leavingId) return;
    try {
      await this.host.sessionPersistence.restore(leavingId);
    } catch (error) {
      // Best-effort: the host still gets the original failure, and the in-memory state is already
      // the departure's (the target was never adopted). The report is itself contained so a broken
      // logger cannot replace the actionable error.
      try {
        this.host.warn?.("failed to re-open the previous session after a failed resume", {
          error: errorMessage(error),
        });
      } catch {
        // Nothing else to do.
      }
    }
  }
}
