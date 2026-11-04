/**
 * Session-scoped lifecycle owner.
 *
 * A session switch is not a list of unrelated cleanups: it is one ordered transaction.
 * This service is the single place that stops producers before clearing their buffers and
 * resets the transient state they write into.
 */

import { errorMessage } from "../../utils/errors.js";

import type { SessionRuntime } from "../session-runtime.js";
import type { SessionData } from "../../agent/persistence/types.js";
import type { SessionSwitchReason } from "../../runtime-types/agent-event-payloads.js";

export type SessionLifecycleReason = "session-switch" | "session-new" | "session-resume" | "agent-destroy";

export class SessionLifecycleService {
  /** Serializes complete session transitions; each switch has multiple awaits and one owner. */
  private switchInFlight: Promise<unknown> = Promise.resolve();
  /** Set by {@link settle}; prevents a teardown window from admitting a new switch. */
  private disposed = false;
  /**
   * The background-work reset started by the last {@link resetTransientState}.
   *
   * The reset kills processes and removes records asynchronously; the switch awaits it before
   * completing, or a re-resume of the leaving id can race a late deletion against a fresh restore.
   */
  private pendingBackgroundReset: Promise<void> = Promise.resolve();
  /**
   * Admitted transitions that have not settled. Counted at ADMISSION (synchronously), not when
   * `runTransition` starts a microtask later: a send/compact arriving in that gap used to see
   * "not switching" and write into the session being left.
   */
  private pendingSwitches = 0;

  constructor(private readonly rt: SessionRuntime) {}

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
    this.rt.run.abortManualCompaction(reason);
    this.rt.run.stopActiveRun(reason);
    // A manual compaction has no pump, so `stopActiveRun` does not clear its queue; and a
    // compaction aborted by this switch can settle AFTER the caller starts awaiting the restore,
    // where `resumeAfterCompaction()` would drain input into the session being replaced (or start
    // a turn on the new one). Drop it here, where every switch path passes.
    this.rt.run.clearQueuedInput();
    this.rt.run.cascadeAbortToChildren(reason);
    this.rt.run.discardPreforkRuns();
    this.rt.sidecars.streamHub.endAllCommands();
  }

  /**
   * Stop producers and clear all transient session state.
   *
   * This is the reset half of the session transaction. `newSession()` and `resume()` compose it
   * with transcript rotation / restore, ownership and log-sink rebinding.
   */
  reset(reason: SessionLifecycleReason = "session-switch"): void {
    this.rt.transcript.beginStateBatch?.();
    try {
      this.stop(reason);
      this.resetTransientState(reason, "full");
    } finally {
      this.rt.transcript.endStateBatch?.();
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
      this.rt.mode.mode.reset();
      this.rt.mode.approvals.clear();
    }
    // Status FIRST: `resetRunState()` aborts the previous run, and its abort listener rewrites any
    // ACTIVE status to `aborted`. Aborting before the reset made every resume from an approval
    // pause (and every `/new` while parked) log a cancellation that never happened — the run was
    // merely being unloaded. With the status already `idle` the listener has nothing to change.
    this.rt.run.statusController.resetToIdle();
    this.rt.run.run.resetRunState();
    this.rt.run.run.resetTurnLifecycle();
    this.rt.sidecars.getCompaction().resetReactiveCompactRetries();
    this.rt.run.clearErrorAndRetry();
    if (full) this.rt.run.clearPendingApprovals();
    this.rt.sidecars.memory.resetState();
    if (full) {
      this.rt.sidecars.usage.reset();
      this.rt.mode.resetMediaHydrationMisses();
      this.rt.sidecars.getTodoManager()?.reset();
      this.rt.sidecars.getToolCompactCache?.().clear();
    }
    this.rt.sidecars.streamHub.clearAll();
    this.rt.mode.resetTurnContext();
    // Extension render slots describe the conversation, not the agent: a plan board or file tree
    // published for the old transcript must not survive into the new one (and must not be replayed
    // to a later subscriber as that session's initial state).
    this.rt.sidecars.clearExtensionUi?.();
    if (full) this.rt.transcript.resetSessionSyncTracker();
    this.rt.transcript.resetIterationProgress();
    // Session-scoped, like the iteration progress above: a completed task keeps its row for the
    // preview, but the conversation it belonged to is gone. Destroying them (not just aborting)
    // is what releases the child's UI channel, log sink and tool state; `clearTaskRuns` below then
    // drops the phase records/pre-fork seats that pointed at them.
    this.rt.sidecars.destroyChildAgents(reason);
    this.rt.sidecars.clearTaskRuns();
    this.rt.run.resetRunOutcome?.();
    this.pendingBackgroundReset = Promise.resolve(this.rt.sidecars.resetBackgroundWork(reason));
  }

  /** Await the background-work reset started by the last transient reset (switch transactions only). */
  private async settleTransientReset(): Promise<void> {
    await this.pendingBackgroundReset;
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
    this.rt.transcript.beginStateBatch?.();
    try {
      return await operation();
    } finally {
      this.rt.transcript.endStateBatch?.();
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
    await this.rt.transcript.awaitPersistIdle();
  }

  private async newSessionInner(reason: "session-new"): Promise<SessionData> {
    const store = this.rt.transcript.getSessionStore();
    if (!store) throw new Error("Session store not available");

    const current = this.rt.transcript.getSessionData();
    const next = store.create({
      modelStyle: current?.modelStyle ?? "openai",
      model: current?.model ?? "unknown",
    });
    if (!this.rt.lease.claim(next.id)) {
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
      this.rt.transcript.setSessionData(next);
      adopted = true;
      // Commit the claim at the adoption point: the departure claim is released here, exactly once.
      this.rt.lease.commit();
      this.rt.transcript.getChatController()?.clearTranscript();
      this.resetTransientState(reason, "full");
      // The reset kills background jobs/tasks asynchronously; the switch is not complete until
      // they are gone (an immediate re-resume must not race a late record deletion).
      await this.settleTransientReset();
      this.rt.transcript.refreshSubagents?.();
      this.rt.transcript.emitSessionNew(next.id, reason);
      this.rt.transcript.refreshState();
      return next;
    } catch (error) {
      if (!adopted) {
        this.rt.lease.abortClaim();
      } else {
        // The switch committed when `setSessionData(next)` ran (and the lease released the
        // departure). A later reset step failing does not un-switch it; just point writers at the
        // adopted id.
        this.rt.transcript.bindSessionLogSink(next.id);
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
    const session = await this.serializeSwitch(() => this.runTransition(() => this.resumeInner(sessionId, reason)));
    // AFTER the transaction, for two reasons the in-transaction call could not satisfy: the reset
    // drops the facade, and `wakeForBackgroundCompletion` refuses while `isSessionSwitching()` is
    // true. Rebuilding it here is exactly the "next session builds a fresh one" lifecycle.
    this.rt.sidecars.resumeBackgroundWork?.();
    return session;
  }

  /**
   * Run a clone/fork as ONE switch transaction.
   *
   * Preparing a branch (drain the queued persist, snapshot the live channel, dehydrate media,
   * write the new session) is several awaits. Doing that before calling `resume()` left it
   * outside the lock: a `/resume` or `/new` admitted in that window could replace the source
   * mid-read, and the branch then wrote the OLD metadata with the NEW messages. The commit half
   * calls `resumeInner` directly — going through `resume()` here would queue behind this very
   * transaction and deadlock.
   */
  async branchTransaction(
    reason: SessionSwitchReason,
    prepare: () => Promise<{ ok: true; sessionId: string } | { ok: false; error: string }>
  ): Promise<{ ok: true; session: SessionData } | { ok: false; error: string }> {
    return this.serializeSwitch(async () => {
      const prepared = await prepare();
      if (!prepared.ok) return prepared;
      const session = await this.runTransition(() => this.resumeInner(prepared.sessionId, reason));
      return { ok: true, session };
    });
  }

  private async resumeInner(sessionId: string, reason: SessionSwitchReason): Promise<SessionData> {
    if (!this.rt.lease.claim(sessionId)) {
      throw new Error(`Session "${sessionId}" is already active in another live session and cannot be resumed here.`);
    }

    // Snapshot the departure BEFORE the load: the count belongs to the session being left, and once
    // the load commits `getSessionData()` is the target.
    const leaving = this.rt.transcript.getSessionData();
    const leavingId = leaving?.id;
    const leavingMessageCount = leaving?.uiMessages.length ?? 0;

    try {
      // Drain what was already queued, then unload: `stop()` can synchronously queue a
      // `pump-complete` write through `interruptCurrentRun`, and both writes must settle before the
      // restore replaces the active session.
      await this.rt.transcript.awaitPersistIdle();
      await this.unloadCurrent("session-resume");

      // Restore-time logs belong to the target. A load that never commits re-points the sink at the
      // still-active leaving session in the catch below.
      this.rt.lease.beginRestore();
      this.rt.transcript.beginSessionRestore?.();
      let session: SessionData;
      try {
        session = await this.rt.transcript.sessionPersistence.restore(sessionId);
      } finally {
        this.rt.transcript.endSessionRestore?.();
      }

      // COMMITTED: the restore adopted the target last. The lease releases the departure claim and
      // advances the generation here, exactly once.
      this.rt.lease.commit();

      try {
        // Clear the leaving run's volatile state. The `resume` scope keeps mode/approvals/usage/todos —
        // the restore just adopted those.
        this.resetTransientState("session-resume", "resume");
        await this.settleTransientReset();
        // The reset makes the status idle; re-apply the restored interaction state so a session that
        // was waiting on approval/ask_user does not come back as idle.
        this.rt.run.syncInteractionStateFromUIMessages?.(session.uiMessages);
        this.rt.transcript.refreshSubagents?.();

        if (leavingId && leavingId !== sessionId) {
          // The departure entry belongs to the session being left, so point the sink back for this one
          // line, then re-attach the target WITHOUT a second boundary (the target's boundary was
          // written when its sink was bound above).
          this.rt.transcript.bindSessionLogSink(leavingId, { sessionBoundary: false });
          try {
            this.rt.transcript.emitSessionSwitch(leavingId, sessionId, leavingMessageCount, reason);
          } finally {
            this.rt.transcript.bindSessionLogSink(sessionId, { sessionBoundary: false });
          }
        }
        this.rt.transcript.refreshState();
      } catch (error) {
        // Past the commit the switch HAS happened. Surfacing this as a failed resume made the host
        // report a failure for a state it is actually in; report and keep the switch instead.
        this.rt.sidecars.warn?.("session resume post-commit step failed", {
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
      this.rt.transcript.sessionPersistence.clearRestorePlaceholder();
      if (this.rt.transcript.getSessionData()?.id !== sessionId) {
        this.rt.lease.abortClaim();
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
   *
   * Deliberately does NOT run `resetTransientState`: that is the `resume` half of a COMPLETED
   * switch, and its `resetBackgroundWork` kills the session's running background jobs and tasks. Here the
   * session did not change, so the jobs belong to the conversation the user is still looking at —
   * killing them would turn a failed `/resume` into collateral damage. `unloadCurrent` already
   * ended the aborted run's streams and cascaded the abort to its children; what it leaves
   * (ended buffers, aborted children, extension slots) describes this same conversation.
   */
  private async recoverLeavingSession(leavingId: string | undefined): Promise<void> {
    if (!leavingId) return;
    try {
      await this.rt.transcript.sessionPersistence.restore(leavingId);
    } catch (error) {
      // Best-effort: the host still gets the original failure, and the in-memory state is already
      // the departure's (the target was never adopted). The report is itself contained so a broken
      // logger cannot replace the actionable error.
      try {
        this.rt.sidecars.warn?.("failed to re-open the previous session after a failed resume", {
          error: errorMessage(error),
        });
      } catch {
        // Nothing else to do.
      }
    }
  }
}
