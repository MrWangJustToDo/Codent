/**
 * Session persist / restore helpers for {@link ManagedAgent}.
 */

import { normalizeSessionApprovals } from "../agent/approval/tool-approval-table.js";
import { readPlanFileAtRelativePath } from "../agent/plan/plan-store.js";

import type { ResolvedCoreEnv } from "../env";
import type { SessionPersistInput, SessionService } from "./services/session-service.js";
import type { EmitAgentTelemetryFn } from "./telemetry/emit-agent-telemetry.js";
import type { UsageTracker } from "./telemetry/usage-tracker.js";
import type { AgentLog } from "../agent/agent-log";
import type { ToolApprovalTable } from "../agent/approval/tool-approval-table.js";
import type { ToolCompactCache } from "../agent/compaction/tool-compact/tool-compact-cache.js";
import type { SessionSyncTracker } from "../agent/persistence/session-sync-tracker.js";
import type { SessionData } from "../agent/persistence/types.js";
import type { PlanModeController } from "../agent/plan/plan-mode-controller.js";
import type { TodoManager } from "../agent/todo";
import type { AgentUIChannel } from "../agent/ui/ui-channel.js";
import type { TextAdapterConfig } from "../models/adapter/adapter-factory.js";
import type { ModelStyle, ReasoningEffort } from "../models/types.js";
import type { UIMessage as TanStackUIMessage } from "@tanstack/ai";

export interface SessionHost {
  getUI?: () => AgentUIChannel | undefined;
  usage: UsageTracker;
  getTodoManager: () => TodoManager | null;
  /** Owning runtime's env, so plan files are read under the runtime root. */
  getCoreEnv: () => ResolvedCoreEnv;
  planMode: PlanModeController;
  isAutoModeEnabled: () => boolean;
  setAutoModeEnabled: (enabled: boolean) => void;
  /** Read the agent's current reasoning-effort config (for persistence). */
  getReasoningEffort: () => ReasoningEffort | undefined;
  /** Set reasoning-effort config (restore path). Optional — older hosts may omit. */
  setReasoningEffort?: (effort: ReasoningEffort | undefined) => void;
  session: SessionService;
  sessionSyncTracker: SessionSyncTracker;
  approvals: ToolApprovalTable;
  toolCompactCache: ToolCompactCache;
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
  /**
   * Adopt the model a resumed session was saved with (no-op under remote-provider).
   * The persisted record is kept in sync by {@link SessionService.setModelConfig}.
   */
  applyPersistedModel?: (next: { model: string; modelStyle?: ModelStyle }) => void;
  resetAdmittedTurnContext?: () => void;
  /**
   * Record how many `media://` refs the restore could not hydrate (`0` clears it).
   * The wire seam uses this to substitute text placeholders for refs no provider can fetch;
   * optional so hosts without a wire path keep compiling.
   */
  setMediaHydrationMisses?: (count: number) => void;
  /** Drop steer/follow-up queues without clearing the transcript (no-op before initChat). */
  clearQueuedMessages: () => void;
  /**
   * Stop an in-flight pump before its transcript is replaced. No-op when idle.
   * Without it a restore swaps the channel under a live pump, whose stale chunks
   * then interleave with the resumed history and get persisted as one session.
   */
  stopActiveRun?: (reason: string) => void;
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
    autoMode: planOn ? false : host.isAutoModeEnabled(),
    reasoningEffort: host.getReasoningEffort(),
    resolveTextAdapter: host.resolveTextAdapter,
    emitEvent: (type, data) => host.emitEvent(type, data),
    log: host.getLog?.(),
    // The auto-title path writes `SessionData.name`; mirror it onto the agent so
    // live UI / snapshots pick it up (previously only manual rename broadcast).
    onTitleResolved: (name) => host.setDisplayName?.(name),
    uiMessages,
  };
}

export async function saveSessionUIMessages(host: SessionHost, uiMessages: TanStackUIMessage[]): Promise<void> {
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
  const persisted = await host.session.persistSession(() => getSessionPersistInput(host, uiMessages));
  if (persisted) host.sessionSyncTracker.markPersisted(uiMessages);
}

export async function persistSessionModelState(host: SessionHost): Promise<void> {
  await host.session.persistSession(() => getSessionPersistInput(host));
}

export async function restoreManagedSession(host: SessionHost, sessionId: string): Promise<SessionData> {
  // The transcript is about to be replaced, so any run still pumping into the
  // current channel must stop first: its later chunks would interleave with the
  // restored history and its pump-complete persist would write that mixture as the
  // resumed session. No-op when idle, so a plain resume is unaffected.
  host.stopActiveRun?.("session-switch");
  host.toolCompactCache.clear();
  // Read-side dual of `session:save-error`: media files referenced by the
  // transcript can be gone (cache cleared / media dir removed). Hydration
  // degrades to the stored form; count the misses so they surface instead of
  // silently losing attachments.
  let mediaMissing = 0;
  const session = await host.session.restoreFromStore(sessionId, {
    usage: host.usage,
    todoManager: host.getTodoManager(),
    onMissingMedia: () => {
      mediaMissing += 1;
    },
  });

  const planSnapshot = session.planMode ? { ...session.planMode, steps: [...session.planMode.steps] } : null;
  if (planSnapshot && planSnapshot.phase !== "off" && !planSnapshot.planMarkdown?.trim() && planSnapshot.planFilePath) {
    const markdown = await readPlanFileAtRelativePath(planSnapshot.planFilePath, host.getCoreEnv());
    if (markdown?.trim()) {
      planSnapshot.planMarkdown = markdown;
    }
  }
  host.planMode.restoreState(planSnapshot);
  // Mutual exclusivity: plan phase wins over auto on restore.
  const planOn = host.planMode.getPhase() !== "off";
  const wantAuto = Boolean(session.autoMode ?? session.autoApprove);
  host.setAutoModeEnabled(planOn ? false : wantAuto);
  // Approvals are not stored separately: derive them from the restored message
  // log (the tool-call parts carry pending/approved/denied + reason), keeping
  // the decision timestamps recorded in the log.
  host.approvals.restore(
    normalizeSessionApprovals({ uiMessages: session.uiMessages, approvalTimes: session.approvalTimes })
  );

  // Adopt the model this session was saved with: the agent is created from the
  // ambient config (env / CLI flags), which may differ from what the session ran
  // on (e.g. after `/models`). Without this a resumed session silently reverts to
  // the default model.
  host.applyPersistedModel?.({
    model: session.model,
    ...(session.modelStyle ? { modelStyle: session.modelStyle } : {}),
  });

  // Restore the persisted reasoning-effort level so resumed sessions keep their
  // configured thinking depth. `setReasoningEffort` also invalidates the runner.
  host.setReasoningEffort?.(session.reasoningEffort);

  // Hydrate UI channel when present; hosts also apply uiMessages via resume APIs.
  if (host.getUI) {
    host.getUI()?.setMessages(session.uiMessages);
  }
  applyRestoredSessionChatState(host, session.uiMessages);
  host.resetAdmittedTurnContext?.();
  host.sessionSyncTracker.reset(session.uiMessages);
  // Resumed sessions may carry a different display name than the previously
  // viewed one — mirror it (and broadcast) so the header/snapshot stay in sync.
  if (session.name) {
    host.setDisplayName?.(session.name);
  }
  host.emitEvent("session:restore", {
    sessionId,
    messageCount: session.uiMessages.length,
    tokenEstimate: session.contextTokens ?? host.usage.getContextFillTokens() ?? 0,
    planPhase: host.planMode.getPhase(),
    autoMode: host.isAutoModeEnabled(),
    ...(mediaMissing > 0 ? { mediaMissing } : {}),
  });
  // A miss is not only a diagnostic: the transcript still holds a `media://` ref no provider can
  // fetch, so the wire seam must substitute a placeholder from the next run on. `0` clears it.
  host.setMediaHydrationMisses?.(mediaMissing);
  // The on-disk session (and thus `AgentL1State.sessionId`) just changed while the
  // agent kept its identity — re-emit state so live subscribers see the switch.
  host.refreshState?.();
  return session;
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
