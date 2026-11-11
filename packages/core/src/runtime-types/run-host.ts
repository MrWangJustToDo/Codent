/**
 * Port for the run lifecycle helpers (`agent/run/run-lifecycle.ts`).
 *
 * The composition root satisfies it structurally; manager-owned collaborators are type-only here,
 * so the helpers can live in the run domain without an `agent → managers` edge.
 */

import type { EmitAgentTelemetryFn } from "./agent-events.js";
import type { AgentStateEventType, AgentTransitionEvent, AgentState } from "./agent-state.js";
import type { AgentStatus } from "./agent-status.js";
import type { Epoch } from "./epoch.js";
import type { BackgroundWakeCause } from "../agent/jobs/background-work.js";
import type { RunCoordinator } from "../agent/run/run-coordinator.js";
import type { AgentUIChannel } from "../agent/ui/ui-channel.js";
import type { CompactionService } from "../managers/services/compaction-service.js";
import type { MemoryService } from "../managers/services/memory-service.js";
import type { UsageTracker } from "../managers/telemetry/usage-tracker.js";
import type { TextAdapterConfig } from "../models/adapter/adapter-factory.js";
import type { ModelMessage, UIMessage } from "@tanstack/ai";

export interface RunLifecycleHost {
  readonly id: string;
  parentId?: string;
  captureEpoch?: () => Epoch;
  getStatus: () => AgentStatus;
  /** The axes behind `getStatus`, when the host exposes them (needed where the projection hides a verdict). */
  getAgentState?: () => AgentState;
  setStatus: (status: AgentStatus, event?: AgentStateEventType) => void;
  transitionStatus?: (event: AgentTransitionEvent) => AgentStatus;
  syncPendingWait?: (messages: UIMessage[]) => void;
  setCurrentRunId: (runId: string | null) => void;
  recordStreamDuration: () => void;
  consumePrepareAsContinuation: () => boolean;
  clearPrepareAsContinuation: () => void;
  consumePrepareAsNewTurn: () => boolean;
  /**
   * This pump already recorded `prompt:submit` for the queued input it released itself, so
   * `prepareForRun` must not write a second row for the same message. Optional: a host that drains
   * no queue of its own never sets it.
   */
  consumePreparePromptRowsEmitted?: () => boolean;
  clearPreparePromptRowsEmitted?: () => void;
  takePendingWakeCause: () => BackgroundWakeCause | undefined;
  beginTurnFinalize: () => boolean;
  getStreamStartedAt: () => number;
  setStreamStartedAt: (value: number) => void;
  persistSession: () => void;
  getSessionData: () => { id?: string } | null;
  clearTurnContext: () => void;
  getMessagesForLLM: (canon?: ModelMessage[]) => ModelMessage[];
  collectExtensionPromptHooks: (prompt: string) => Promise<void>;
  emitEvent: EmitAgentTelemetryFn;
  resolveTextAdapter?: () => Promise<TextAdapterConfig | null>;
  usage: UsageTracker;
  getUI?: () => AgentUIChannel | undefined;
  run: RunCoordinator;
  getCompaction(): CompactionService;
  memory: MemoryService;
}
