/**
 * The four ports a session switch depends on.
 *
 * The old `SessionLifecycleHost` was a 38-member view of the whole agent: run control, transcript,
 * modes, sidecars and lease all in one object. That made every switch test construct an agent and
 * hid which subsystem a step actually touched. These ports group the same callbacks by owner; the
 * transaction reads like the phase it is in.
 */

import type { SessionSwitchReason } from "./agent-event-payloads.js";
import type { QueuedMessagesSnapshot } from "./session-payloads.js";
import type { ToolApprovalTable } from "../agent/approval/tool-approval-table.js";
import type { ModeCoordinator } from "../agent/mode/mode-coordinator.js";
import type { SessionStore } from "../agent/persistence/session-store.js";
import type { SessionData } from "../agent/persistence/types.js";
import type { AgentChatController } from "../agent/run/chat-controller.js";
import type { RunCoordinator } from "../agent/run/run-coordinator.js";
import type { SessionLease } from "../agent/session/session-lease.js";
import type { SessionPersistence } from "../agent/session/session-persistence.js";
import type { AgentStatusController } from "../agent/state/agent-status-controller.js";
import type { AgentStreamHub } from "../agent/stream-hub/agent-stream-hub.js";
import type { TodoManager } from "../agent/todo";
import type { CompactionService } from "../managers/services/compaction-service.js";
import type { MemoryService } from "../managers/services/memory-service.js";
import type { UsageTracker } from "../managers/telemetry/usage-tracker.js";
import type { UIMessage } from "@tanstack/ai";

/** Stop/abort/reset the run and its visible status. */
export interface SessionRunPort {
  readonly run: RunCoordinator;
  readonly statusController: AgentStatusController;
  stopActiveRun(reason: string): void;
  /**
   * The queue as it is right now. Captured SYNCHRONOUSLY at the start of the switch's stop half:
   * a still-live pump can drain the queue during a preceding await, and restoring an earlier
   * snapshot would deliver the same message twice.
   */
  peekQueuedInput(): QueuedMessagesSnapshot;
  /** Drop input queued while busy — a teardown has no turn to deliver it to. */
  clearQueuedInput(): QueuedMessagesSnapshot;
  abortManualCompaction(reason: string): void;
  cascadeAbortToChildren(reason?: string): void;
  discardPreforkRuns(): void;
  resetRunOutcome?(): void;
  clearErrorAndRetry(): void;
  clearPendingApprovals(): void;
  syncInteractionStateFromUIMessages?(messages: UIMessage[]): void;
}

/** Session data, persistence, log sink and the host-facing transcript/state publications. */
export interface SessionTranscriptPort {
  readonly sessionPersistence: SessionPersistence;
  getSessionData(): SessionData | null;
  setSessionData(data: SessionData): void;
  getSessionStore(): SessionStore | null;
  awaitPersistIdle(): Promise<void>;
  getChatController(): AgentChatController | undefined;
  emitSessionNew(sessionId: string, reason: "session-new"): void;
  emitSessionSwitch(
    fromSessionId: string,
    toSessionId: string,
    messageCount: number,
    reason?: SessionSwitchReason
  ): void;
  refreshState(): void;
  refreshSubagents?(): void;
  beginStateBatch?(): void;
  endStateBatch?(): void;
  beginSessionRestore?(): void;
  endSessionRestore?(): void;
  resetSessionSyncTracker(): void;
  resetIterationProgress(): void;
}

/** Plan/auto state, approvals and per-turn context — the conversation's policy state. */
export interface SessionModePort {
  readonly mode: ModeCoordinator;
  readonly approvals: ToolApprovalTable;
  resetTurnContext(): void;
  resetMediaHydrationMisses(): void;
}

/** Everything the switch ends or rebuilds beside the transcript: work, tools, children, logs. */
export interface SessionSidecarPort {
  getCompaction(): CompactionService;
  readonly memory: MemoryService;
  readonly usage: UsageTracker;
  readonly streamHub: AgentStreamHub;
  getTodoManager(): TodoManager | null;
  getToolCompactCache?(): { clear(): void };
  clearExtensionUi?(): void;
  /** Drop extension lifecycle notices that describe the conversation being left. */
  clearExtensionSessionNotices?(): void;
  destroyChildAgents(reason: string): void;
  clearTaskRuns(): void;
  /** Drop per-call `tool:before:*` outcomes from the conversation being left. */
  clearToolBeforeHooks?(): void;
  /**
   * Drop the session's background work and its facade.
   *
   * `sameSession` is a reload of the session that is still active (bootstrap restore, `/resume`
   * to the current id): the jobs are the SAME jobs, so state that dedupes their lifecycle rows
   * (e.g. `lastJobStatuses`) must survive. A real switch replaces the conversation and must clear it.
   */
  resetBackgroundWork(reason: string, options?: { sameSession?: boolean }): Promise<void> | void;
  resumeBackgroundWork?(): void;
  warn?(message: string, data?: Record<string, unknown>): void;
}

export interface SessionRuntime {
  readonly lease: SessionLease;
  readonly run: SessionRunPort;
  readonly transcript: SessionTranscriptPort;
  readonly mode: SessionModePort;
  readonly sidecars: SessionSidecarPort;
}
