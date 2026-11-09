/**
 * Port for the chat pump (`agent/run/chat-controller.ts`).
 *
 * The controller orchestrates one conversation turn; it needs this narrow slice of the owning
 * agent, not the whole composition root. `ManagedAgent` satisfies it structurally.
 */

import type { EmitAgentTelemetryFn } from "./agent-events.js";
import type { AgentState } from "./agent-state.js";
import type { AgentStatus, RunFinalizeReason } from "./agent-status.js";
import type { Epoch } from "./epoch.js";
import type { SessionDiagnosticArea } from "./event-payloads/payload-primitives.js";
import type { ApprovalRequirement } from "../agent/approval/approval-requirement.js";
import type { ToolApprovalTable } from "../agent/approval/tool-approval-table.js";
import type { CompactionController } from "../agent/compaction/compaction-controller.js";
import type { ToolCompactCache } from "../agent/compaction/tool-compact/tool-compact-cache.js";
import type { ToolBeforeHookOutcome } from "../agent/extension/tool-before-hook.js";
import type { BackgroundWakeCause } from "../agent/jobs/background-work.js";
import type { ModeState } from "../agent/mode/mode-state.js";
import type { AgentPolicyFacts } from "../agent/mode/policy-facts.js";
import type { SessionSaveReason } from "../agent/persistence/session-sync-tracker.js";
import type { PlanModeController } from "../agent/plan/plan-mode-controller.js";
import type { RunCoordinator } from "../agent/run/run-coordinator.js";
import type { AgentStatusController } from "../agent/state/agent-status-controller.js";
import type { AgentUIChannel } from "../agent/ui/ui-channel.js";
import type { ResolvedCoreEnv } from "../env";
import type { RunFinalizer } from "../managers/run-finalizer.js";
import type { AgentToolService } from "../managers/services/agent-tool-service.js";
import type { UsageTracker } from "../managers/telemetry/usage-tracker.js";
import type { UIMessage } from "@tanstack/ai";

export interface AgentChatHost {
  readonly id: string;
  readonly usage: UsageTracker;
  readonly run: RunCoordinator;
  readonly runFinalizer: RunFinalizer;
  readonly statusController: AgentStatusController;
  readonly compactions: CompactionController;
  readonly planMode: PlanModeController;
  readonly toolService: AgentToolService;
  captureEpoch: () => Epoch;
  getStatus(): AgentStatus;
  /** The explicit axes behind `getStatus()`. Read the AXIS when a projection is ambiguous. */
  getAgentState(): AgentState;
  getApprovals(): ToolApprovalTable;
  getModeState(): ModeState;
  getPolicyFacts(): AgentPolicyFacts;
  getApprovalRequirement(toolName: string): ApprovalRequirement | undefined;
  getCoreEnv(): ResolvedCoreEnv;
  getToolCompactCache(): ToolCompactCache;
  /** Drop the channel→wire projection cache (a transcript clear must not hit a stale wire). */
  invalidateWireProjection?(): void;
  getUI?(): AgentUIChannel | undefined;
  getCurrentRunId?(): string | null;
  setUIChannel(channel: AgentUIChannel): void;
  setError(error: string): void;
  setPendingApprovalCount(count: number): void;
  setClientToolWaiting: (active: boolean) => "applied" | "switching" | "compacting" | "destroyed";
  setPendingWakeCause(cause: BackgroundWakeCause): void;
  isSessionSwitching(): boolean;
  /** Set by `ManagedAgent.markDestroyed`; late async continuations must not start work. */
  isDestroyed(): boolean;
  abort(reason?: string, options?: { userCancel?: boolean }): void;
  emitEvent: EmitAgentTelemetryFn;
  emitDiagnostic(
    area: SessionDiagnosticArea,
    message: string,
    options?: {
      level?: "debug" | "info" | "warn" | "error";
      data?: Record<string, string | number | boolean | null | readonly number[]>;
      error?: string;
    }
  ): void;
  finalizeRun(reason: RunFinalizeReason): void;
  resetTurnLifecycle(): void;
  markNextPrepareAsContinuation(): void;
  clearPrepareAsContinuation(): void;
  markNextPrepareAsNewTurn(): void;
  clearPrepareAsNewTurn(): void;
  maybeSaveSessionUIMessages(messages: UIMessage[], reason: SessionSaveReason): void;
  runToolBeforeHook(toolCallId: string, toolName: string, args: unknown): Promise<ToolBeforeHookOutcome>;
  wakeForBackgroundWork(cause?: BackgroundWakeCause): Promise<void>;
}
