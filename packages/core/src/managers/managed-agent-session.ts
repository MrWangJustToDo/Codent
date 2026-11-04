/**
 * Session persist / restore helpers for {@link ManagedAgent}.
 */

import { normalizeSessionApprovals } from "../agent/approval/tool-approval-table.js";
import { createSessionSyncTracker, type SessionSyncTracker } from "../agent/persistence/session-sync-tracker.js";
import { readPlanFileAtRelativePath } from "../agent/plan/plan-store.js";
import { settleInterruptedToolCalls } from "../agent/stream/incomplete-tool-calls.js";
import { cancelInterruptedBackgroundTasks } from "../agent/subagent/task-background.js";
import { cancelInterruptedBackgroundCommands } from "../agent/tools/builtin/shell/run-command-tool.js";
import { isReasoningEffort } from "../models/types.js";
import { errorMessage } from "../utils/errors.js";

import type { ResolvedCoreEnv } from "../env";
import type { ModeCoordinator } from "./mode-coordinator.js";
import type { SessionPersistInput, SessionService } from "./services/session-service.js";
import type { EmitAgentTelemetryFn } from "./telemetry/emit-agent-telemetry.js";
import type { UsageTracker } from "./telemetry/usage-tracker.js";
import type { AgentLog } from "../agent/agent-log";
import type { ToolApprovalTable } from "../agent/approval/tool-approval-table.js";
import type { ToolCompactCache } from "../agent/compaction/tool-compact/tool-compact-cache.js";
import type { SessionData } from "../agent/persistence/types.js";
import type { PlanModeController } from "../agent/plan/plan-mode-controller.js";
import type { TodoManager } from "../agent/todo";
import type { AgentUIChannel } from "../agent/ui/ui-channel.js";
import type { TextAdapterConfig } from "../models/adapter/adapter-factory.js";
import type { ModelStyle, ReasoningEffort } from "../models/types.js";
import type { UIMessage as TanStackUIMessage } from "@tanstack/ai";

/** The model actually in force after adopting (or rejecting) a persisted selection. */
export interface AppliedPersistedModel {
  /** Whether the effective model/style differs from the one the agent was created with. */
  changed: boolean;
  /**
   * The model to record on the session. This is the persisted id when it is still offered, or the
   * fallback (`config.model`) when the catalog no longer lists it — recording the requested id in
   * that case is what made every later resume repeat the same fallback.
   */
  model: string;
  modelStyle?: ModelStyle;
}

export interface SessionHost {
  getUI?: () => AgentUIChannel | undefined;
  usage: UsageTracker;
  getTodoManager: () => TodoManager | null;
  /** Owning runtime's env, so plan files are read under the runtime root. */
  getCoreEnv: () => ResolvedCoreEnv;
  planMode: PlanModeController;
  /** Mode owner; optional for hosts that only need the plan/auto fields below. */
  mode?: ModeCoordinator;
  isAutoModeEnabled: () => boolean;
  setAutoModeEnabled: (enabled: boolean) => void;
  /** Read the agent's current reasoning-effort config (for persistence). */
  getReasoningEffort: () => ReasoningEffort | undefined;
  /** Set reasoning-effort config (restore path). Optional — older hosts may omit. */
  setReasoningEffort?: (effort: ReasoningEffort | undefined) => void;
  session: SessionService;
  getApprovals: () => ToolApprovalTable;
  getToolCompactCache: () => ToolCompactCache;
  resolveTextAdapter?: () => Promise<TextAdapterConfig | null>;
  emitEvent: EmitAgentTelemetryFn;
  /**
   * The agent's log, for side queries the helpers run on their own (session
   * titles). Optional so hosts without logging keep compiling.
   */
  getLog?: () => AgentLog | undefined;
  /** Update the agent's display name (broadcast via the state channel). */
  setDisplayName?: (name: string) => void;
  /** Re-emit the L1 state snapshot (after swapping the on-disk session id). */
  refreshState?: () => void;
  /** Persist current state only (no transcript) — used when a restore corrects the model. */
  persistSession?: () => void;
  /**
   * Adopt the model a resumed session was saved with (no-op under remote-provider).
   * The persisted record is kept in sync by {@link SessionService.setModelConfig}.
   *
   * @returns whether the effective model changed (the caller then resolves its metadata).
   */
  applyPersistedModel?: (next: { model: string; modelStyle?: ModelStyle }) => AppliedPersistedModel;
  /**
   * Re-resolve capabilities / context window / pricing for the configured model.
   * Optional so hosts that only restore sessions keep compiling.
   */
  refreshModelMetadata?: () => Promise<void>;
  /**
   * Record how many `media://` refs the restore could not hydrate (`0` clears it).
   * The wire seam uses this to substitute text placeholders for refs no provider can fetch;
   * optional so hosts without a wire path keep compiling.
   */
  setMediaHydrationMisses?: (count: number) => void;
  /** Drop steer/follow-up queues without clearing the transcript (no-op before initChat). */
  clearQueuedMessages: () => void;
  /** Reconcile approval / ask_user pause from restored UIMessages. */
  syncInteractionStateFromUIMessages: (
    messages: TanStackUIMessage[],
    options?: { whenClear?: "idle" | "running" | "completed" }
  ) => void;
}

export function getSessionPersistInput(host: SessionHost, uiMessages?: TanStackUIMessage[]): SessionPersistInput {
  const planOn = host.planMode.getPhase() !== "off";
  return {
    usage: host.usage,
    todoManager: host.getTodoManager(),
    planMode: host.planMode.getState(),
    // Mutual exclusivity: never persist auto while plan is active.
    autoMode: host.mode?.getPersistedAutoMode() ?? (planOn ? false : host.isAutoModeEnabled()),
    reasoningEffort: host.getReasoningEffort(),
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
): Promise<void> {
  if (uiMessages.length === 0) return;
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
}

export async function restoreManagedSession(
  host: SessionHost,
  sessionId: string,
  tracker: SessionSyncTracker = createSessionSyncTracker()
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
  const restoredMessages = cancelInterruptedBackgroundCommands(restored.uiMessages);
  const taskMessages = cancelInterruptedBackgroundTasks(restoredMessages);
  const uiMessages = settleInterruptedToolCalls(taskMessages);
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
    host.setAutoModeEnabled(host.planMode.getPhase() === "off" && wantAuto);
  }
  host.getApprovals().restore(approvals);

  // Hydrate UI channel when present; hosts also apply uiMessages via resume APIs.
  // Bump the UI generation first so a run that started on the session being left
  // cannot append its late chunks to the restored transcript.
  if (host.getUI) {
    const ui = host.getUI();
    ui?.advanceSessionGeneration();
    ui?.setMessages(uiMessages);
  }
  applyRestoredSessionChatState(host, uiMessages);
  tracker.reset(uiMessages);

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
    // `mode.restore` ran before the adoption (the commit must be last), so `restoreTodos` overwrote
    // the plan-bound repair with the persisted value. Re-assert it now that the target's list is in
    // place; otherwise an `executing` session with `todoPlanBound: false` can never reach `retro`
    // and `complete_plan`'s verification gate is unreachable.
    host.planMode.reapplyTodoBinding?.();
    // The persisted model is not the bootstrap one, so its metadata was never resolved: capabilities
    // would be "unknown" (permissive → media sent to a text-only endpoint) and the context window
    // unset (compaction trigger loses its clamp).
    if (modelChanged) await host.refreshModelMetadata?.();
    // Make the fallback converge on disk once: the corrected `SessionData` was adopted above, but
    // without a write the next resume reads the old id again.
    if (modelChanged || modelRecordCorrected) host.persistSession?.();
    // Resumed sessions may carry a different display name than the previously viewed one — mirror it
    // (and broadcast) so the header/snapshot stay in sync.
    if (session.name) {
      host.setDisplayName?.(session.name);
    }
    host.emitEvent("session:restore", {
      sessionId,
      messageCount: uiMessages.length,
      tokenEstimate: session.contextTokens ?? host.usage.getContextFillTokens() ?? 0,
      planPhase: host.planMode.getPhase(),
      autoMode: host.isAutoModeEnabled(),
      model: session.model,
      ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
      ...(modelFallback ? { modelFallback: true } : {}),
      ...(mediaMissing > 0 ? { mediaMissing } : {}),
    });
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
