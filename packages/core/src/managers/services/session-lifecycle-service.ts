/**
 * Session-scoped lifecycle owner.
 *
 * A session switch is not a list of unrelated cleanups: it is one ordered transaction.
 * This service is the single place that stops producers before clearing their buffers and
 * resets the transient state they write into.
 */

import type { AgentStreamHub } from "../../agent/stream-hub/agent-stream-hub.js";
import type { ToolApprovalTable } from "../../agent/approval/tool-approval-table.js";
import type { TodoManager } from "../../agent/todo";
import type { AgentStatusController } from "../controllers/agent-status-controller.js";
import type { CompactionService } from "./compaction-service.js";
import type { MemoryService } from "./memory-service.js";
import type { ModeCoordinator } from "../mode-coordinator.js";
import type { RunCoordinator } from "../run-coordinator.js";
import type { UsageTracker } from "../telemetry/usage-tracker.js";

export type SessionLifecycleReason =
  "session-switch" | "session-new" | "session-resume" | "session-clear" | "agent-destroy";

/** Everything the lifecycle service needs from its owning agent. */
export interface SessionLifecycleHost {
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
   * This is the only reset path for `/clear`, session.new and session.resume entry points.
   * It deliberately does not clear the UI transcript, rotate the session, or touch ownership;
   * those remain part of the switch transaction in `session-lifecycle-commands.ts`.
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
}
