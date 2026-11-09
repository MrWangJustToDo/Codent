/**
 * Session persist / restore helpers for {@link ManagedAgent}.
 */

import { isReasoningEffort, supportedReasoningEfforts } from "../../models/types.js";
import { errorMessage } from "../../utils/errors.js";
import { normalizeSessionApprovals } from "../approval/tool-approval-table.js";
import { readPlanFileAtRelativePath } from "../plan/plan-store.js";
import { settleInterruptedToolCalls } from "../stream/incomplete-tool-calls.js";
import { cancelInterruptedBackgroundTasks } from "../subagent/task-background.js";
import { cancelInterruptedBackgroundCommands } from "../tools/builtin/shell/run-command-tool.js";

import type { SessionHost, SessionPersistInput } from "../../runtime-types/session-host.js";
import type { SessionSyncTracker } from "../persistence/session-sync-tracker.js";
import type { SessionData } from "../persistence/types.js";
import type { UIMessage as TanStackUIMessage } from "@tanstack/ai";

/**
 * Marks an error thrown before the restore applied anything to the HOST.
 *
 * The distinction is what makes a failed `/resume` non-destructive: if the target could not even be
 * read, the agent still holds the leaving transcript untouched, and re-reading that transcript from
 * disk would replace newer in-memory messages with a stale record (a persist that failed earlier).
 * A failure AFTER the apply phase does need the disk reload, because the target's model/mode/UI have
 * already been written onto the host.
 */
export const RESTORE_READ_FAILED = Symbol.for("@codent/core/restore-read-failed");

export function isRestoreReadFailure(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as Record<symbol, unknown>)[RESTORE_READ_FAILED] === true
  );
}

/** Tag an error thrown while READING the target, so recovery knows nothing was applied. */
export function markRestoreReadFailure<T>(error: T): T {
  if (typeof error === "object" && error !== null) {
    Object.defineProperty(error, RESTORE_READ_FAILED, { value: true, configurable: true });
  }
  return error;
}

export function getSessionPersistInput(host: SessionHost, uiMessages?: TanStackUIMessage[]): SessionPersistInput {
  const mode = host.getModeState().snapshot();
  return {
    usage: host.usage,
    todoManager: host.getTodoManager(),
    planMode: mode.plan,
    // Mutual exclusivity: never persist auto while plan is active.
    autoMode: mode.planPhase === "off" && mode.auto,
    reasoningEffort: host.getReasoningEffort(),
    epoch: host.captureEpoch?.(),
    resolveTextAdapter: host.resolveTextAdapter,
    emitEvent: (type, ...args) => host.emitEvent(type, ...args),
    emitSessionTitle: (payload, sessionId) =>
      host.emitEvent("session:title", payload, sessionId !== undefined ? { sessionId } : undefined),
    // The auto-title path writes `SessionData.name`; mirror it onto the agent so
    // live UI / snapshots pick it up (previously only manual rename broadcast).
    onTitleResolved: (name) => host.setDisplayName?.(name),
    uiMessages,
  };
}

export async function saveSessionUIMessages(
  host: SessionHost,
  uiMessages: TanStackUIMessage[],
  tracker: SessionSyncTracker,
  sessionId: string | undefined = host.session.getSessionData()?.id
): Promise<boolean> {
  if (uiMessages.length === 0) return false;
  // Only mark persisted when the write actually landed. Marking a failed save
  // would make the fingerprint match, so every later persist of the same content
  // is skipped as a no-op and the loss never converges (the store's own baseline
  // still points at the older successful save).
  //
  // The input is resolved lazily: this call may sit behind another queued persist,
  // and by the time it runs the ambient state may have moved on (a mode switch
  // during the same turn). Re-reading it here keeps the newest state on the last
  // write; the message snapshot stays exactly the caller's.
  // Coalesced: several synthetic injections in one model call write the newest transcript
  // once instead of once per injection (the channel is append-only, so it is a superset).
  const persisted = await host.session.persistSession(
    () => ({
      ...getSessionPersistInput(host, uiMessages),
      ...(sessionId ? { sessionId } : {}),
    }),
    { coalesceUiMessages: true }
  );
  if (persisted) tracker.markPersisted(uiMessages);
  return persisted;
}

export async function restoreManagedSession(
  host: SessionHost,
  sessionId: string,
  options: { repairRuntime?: boolean; silent?: boolean } = {}
): Promise<SessionData> {
  // The caller's session lifecycle stops a live pump before this helper is entered; the
  // production switch owns that ordering in exactly one place.
  host.getToolCompactCache().clear();
  // Read-side dual of `session:save-error`: media files referenced by the
  // transcript can be gone (cache cleared / media dir removed). Hydration
  // degrades to the stored form; count the misses so they surface instead of
  // silently losing attachments.
  let mediaMissing = 0;
  // READ. Nothing is adopted here: a failure below must leave the agent on the session it is
  // actually running (the caller's unload half already stopped that session's producers).
  const restored = await host.session.readSessionForRestore(sessionId, {
    onMissingMedia: () => {
      mediaMissing += 1;
    },
  });
  const { session } = restored;

  // A process crash can leave a valid `input-complete` tool part on disk with no output
  // (or a truncated arg stream). No run exists to settle it, so the UI would render an
  // executing spinner forever and `isToolInFlight` would keep resurfacing it. Settle both
  // in-flight and incomplete calls before the channel and approvals are restored.
  //
  // A background `task` is the one part that carries an output and still cannot be running: it wrote
  // its `running` handle at start, and a session end drops the ledger that would ever settle it. That
  // pass runs FIRST — the generic one skips any part with an output, so it would leave the handle.
  const restoredMessages =
    options.repairRuntime === false ? restored.uiMessages : cancelInterruptedBackgroundCommands(restored.uiMessages);
  const taskMessages =
    options.repairRuntime === false ? restoredMessages : cancelInterruptedBackgroundTasks(restoredMessages);
  const uiMessages = options.repairRuntime === false ? taskMessages : settleInterruptedToolCalls(taskMessages);
  // The repairs happen after `readSessionForRestore` wrote the canonical form, and `tracker.reset`
  // below is given the REPAIRED array — so without this write the settled transcript would only
  // ever exist in memory (the tracker would consider it persisted and every later save a no-op),
  // while the file kept a `running` handle that `session_read` and other processes still report.
  // The helpers are copy-on-write, so reference equality means "nothing to repair".
  if (uiMessages !== restored.uiMessages) {
    await host.session.saveRestoredMessages(session, uiMessages);
  }

  const planSnapshot = session.planMode ? { ...session.planMode, steps: [...session.planMode.steps] } : null;
  if (planSnapshot && planSnapshot.phase !== "off" && !planSnapshot.planMarkdown?.trim() && planSnapshot.planFilePath) {
    const markdown = await readPlanFileAtRelativePath(planSnapshot.planFilePath, host.getCoreEnv());
    if (markdown?.trim()) {
      planSnapshot.planMarkdown = markdown;
    }
  }
  // Approvals are not stored separately: derive them from the restored message
  // log (the tool-call parts carry pending/approved/denied + reason), keeping the
  // decision timestamps recorded in the log.
  const approvals = normalizeSessionApprovals({ uiMessages, approvalTimes: session.approvalTimes });
  // Mutual exclusivity: plan phase wins over auto on restore.
  const wantAuto = Boolean(session.autoMode ?? session.autoApprove);

  // Adopt the model this session was saved with: the agent is created from the
  // ambient config (env / CLI flags), which may differ from what the session ran
  // on (e.g. after `/models`). Without this a resumed session silently reverts to
  // the default model.
  //
  // This is the last step that can fail (its `setModel` runs the config schema), so it runs
  // BEFORE mode/approvals/channel are pointed at the target. `applyPersistedModel` preflights that
  // schema and keeps the current model on a rejection; without the preflight, a session written by
  // another build left the leaving session carrying the target's plan phase (and therefore its
  // auto-approve flag) and its approval table, while `getSessionData()` still named the leaving one.
  //
  // Nothing here is rolled back locally. A failure before the commit means the target was never
  // adopted, so the agent is still on the session it was on — and the caller recovers it by running
  // THIS SAME load against that session (`SessionLifecycleService.recoverLeavingSession`). Its disk
  // record is authoritative because `unload` already stopped the run and drained every queued write.
  // A hand-maintained snapshot of model/effort/mode/approvals/transcript would be a second copy of
  // the same state, and the copy that can drift.
  const requestedModel = session.model;
  const appliedModel = host.applyPersistedModel?.({
    model: session.model,
    ...(session.modelStyle ? { modelStyle: session.modelStyle } : {}),
  });
  const modelChanged = appliedModel?.changed ?? false;
  // The persisted id was not adopted (the catalog did not offer it). Recorded on `session:restore`
  // because the restore suppresses `model:change` (emitting it here would write a target fact with
  // a departure envelope) — without this the substitution had no durable record at all.
  const modelFallback = appliedModel !== undefined && appliedModel.model !== requestedModel;
  // The effective model, not necessarily the requested one: an unavailable persisted id falls
  // back to the session's creation model. Adopting the raw record afterwards overwrote that
  // fallback, so the live state and the disk disagreed and every later resume repeated it.
  //
  // This is `record differs`, not `runtime changed`: when the fallback IS the model the runtime
  // was created with, `setModel` is a no-op (`changed: false`) while the restored record still
  // names the retired id.
  const modelRecordCorrected =
    appliedModel !== undefined &&
    (session.model !== appliedModel.model ||
      (appliedModel.modelStyle !== undefined && session.modelStyle !== appliedModel.modelStyle));
  if (modelRecordCorrected && appliedModel) {
    session.model = appliedModel.model;
    if (appliedModel.modelStyle) session.modelStyle = appliedModel.modelStyle;
  }

  // Restore the persisted reasoning-effort level so resumed sessions keep their
  // configured thinking depth. `setReasoningEffort` also invalidates the runner.
  // A level written by a build that knew one more value must not abort the restore.
  if (session.reasoningEffort === undefined || isReasoningEffort(session.reasoningEffort)) {
    host.setReasoningEffort?.(session.reasoningEffort);
  } else {
    // A level this build does not know (written by another version) must not fall through to the
    // LEAVING session's config: `getSessionPersistInput` always writes the live effort, so keeping
    // it copies one session's depth into the target on the next save. Clear it explicitly.
    host.setReasoningEffort?.(undefined);
  }

  // ---------------------------------------------------------------------------
  // ADOPTION — synchronous from here to the commit below.
  //
  // The session data is adopted LAST, after the channel, tracker, mode and approvals all point at
  // the target; the previous order adopted inside the read, so a later failure left one session's
  // data with the other's transcript — and the next save rewrote the target's log with the stale
  // transcript.
  // ---------------------------------------------------------------------------
  // Mutual exclusivity: plan phase wins over auto on restore.
  if (host.mode) {
    host.mode.restore(planSnapshot, wantAuto);
  } else {
    host.planMode.restoreState(planSnapshot);
    host.setAutoModeEnabled(planSnapshot?.phase !== "off" ? false : wantAuto);
  }
  host.getApprovals().restore(approvals);

  // Hydrate UI channel when present; hosts also apply uiMessages via resume APIs.
  // Bump the UI generation first so a run that started on the session being left
  // cannot append its late chunks to the restored transcript.
  if (host.getUI) {
    const ui = host.getUI();
    ui?.setMessages(uiMessages);
  }
  applyRestoredSessionChatState(host, uiMessages);

  // COMMIT — the one adoption. A throw here propagates untouched: unlike the block above there is
  // no coherent state to roll back to, and the caller reports the load as failed.
  host.session.adoptRestoredSession(restored, {
    usage: host.usage,
    todoManager: host.getTodoManager(),
  });
  // ---------------------------------------------------------------------------
  // POST-COMMIT — best effort. The switch has happened: a metadata refresh or a listener throwing
  // must not report the load as failed (the caller's rollback would release a session it is using).
  // ---------------------------------------------------------------------------
  try {
    // The baseline belongs to the transcript that was actually adopted; the lease owns that moment
    // (bootstrap already committed the claim, so it must not depend on a second generation bump).
    // Inside the post-commit block: a throwing sink/baseline must not prevent `lease.commit()` in
    // the caller after the data was already swapped.
    host.onSessionAdopted?.(uiMessages);
    // `mode.restore` ran before the adoption (the commit must be last), so `restoreTodos` overwrote
    // the plan-bound repair with the persisted value. Re-assert it now that the target's list is in
    // place; otherwise an `executing` session with `todoPlanBound: false` can never reach `retro`
    // and `complete_plan`'s verification gate is unreachable.
    host.planMode.reapplyTodoBinding?.();
    // The persisted model is not the bootstrap one, so its metadata was never resolved: capabilities
    // would be "unknown" (permissive → media sent to a text-only endpoint) and the context window
    // unset (compaction trigger loses its clamp).
    if (modelChanged) await host.refreshModelMetadata?.();
    // A persisted effort belongs to the model it was chosen for. `setModel` drops an unsupported
    // level on an explicit switch, but the restore writes the persisted value AFTER the model, so
    // an unavailable model that fell back to another one kept a depth its replacement does not
    // offer. Only POSITIVE evidence may clear: `supportedReasoningEfforts` falls back to the known
    // set when metadata is silent, whereas the menu predicate (`offerable…`) returns `[]` for
    // "unknown" and would delete a user's explicit depth on every resume. `silent` is a failed
    // resume's recovery: it must not write corrections to the session that never left.
    if (!options.silent) {
      const info = host.getModelInfo?.() ?? null;
      const effort = host.getReasoningEffort();
      if (info && effort !== undefined && !supportedReasoningEfforts(info).includes(effort)) {
        host.setReasoningEffort?.(undefined);
      }
    }
    // Make the fallback converge on disk once: the corrected `SessionData` was adopted above, but
    // without a write the next resume reads the old id again.
    if (modelChanged || modelRecordCorrected) host.persistSession?.();
    // Resumed sessions may carry a different display name than the previously viewed one — mirror it
    // (and broadcast) so the header/snapshot stay in sync.
    if (session.name) {
      host.setDisplayName?.(session.name);
    }
    const mode = host.getModeState().snapshot();
    // `silent` is the failed-/resume recovery: it re-opens the session that never left, and a
    // `session:restore` row there read as "the switch succeeded" in the timeline while the command
    // had returned an error. The failure itself is already reported by the caller.
    if (!options.silent) {
      // Report the EFFECTIVE depth: a level the model no longer offers was cleared above.
      const effectiveEffort = host.getReasoningEffort();
      host.emitEvent("session:restore", {
        sessionId,
        messageCount: uiMessages.length,
        tokenEstimate: session.contextTokens ?? host.usage.getContextFillTokens() ?? 0,
        planPhase: mode.planPhase,
        autoMode: mode.auto,
        model: session.model,
        ...(effectiveEffort ? { reasoningEffort: effectiveEffort } : {}),
        ...(modelFallback ? { modelFallback: true } : {}),
        ...(mediaMissing > 0 ? { mediaMissing } : {}),
      });
    }
    // A miss is not only a diagnostic: the transcript still holds a `media://` ref no provider can
    // fetch, so the wire seam must substitute a placeholder from the next run on. `0` clears it.
    host.setMediaHydrationMisses?.(mediaMissing);
    // The on-disk session (and thus `AgentL1State.sessionId`) just changed while the agent kept its
    // identity — re-emit state so live subscribers see the switch.
    host.refreshState?.();
  } catch (error) {
    host.emitEvent("session:diagnostic", {
      area: "session",
      level: "warn",
      message: "post-restore step failed",
      details: { sessionId },
      error: errorMessage(error),
    });
  }

  return { ...session, uiMessages };
}

/**
 * Align mid-session restore with Host.create: drop leftover queues and
 * reconcile approval / client-tool waiting from the restored transcript.
 */
export function applyRestoredSessionChatState(
  host: Pick<SessionHost, "clearQueuedMessages" | "syncInteractionStateFromUIMessages">,
  uiMessages: TanStackUIMessage[]
): void {
  host.clearQueuedMessages();
  host.syncInteractionStateFromUIMessages(uiMessages);
}
