/**
 * Ports for the managed-session persistence helpers.
 *
 * The helpers (`getSessionPersistInput`, `restoreManagedSession`, `saveSessionUIMessages`) live in
 * `agent/session/`; this hub owns the callbacks they need from the owning agent. It is a port hub:
 * the manager-side collaborators are type-only so the domain layer can depend on this file without
 * an `agent → managers` edge.
 */

import type { ModeCoordinator } from "../agent/mode/mode-coordinator.js";
import type { ModeState } from "../agent/mode/mode-state.js";
import type { PlanModeController, PlanModeState } from "../agent/plan/plan-mode-controller.js";
import type { ResolvedCoreEnv } from "../env";
import type { EmitAgentTelemetryFn } from "./agent-events.js";
import type { Epoch } from "./epoch.js";
import type { AgentLog } from "../agent/agent-log";
import type { ToolApprovalTable } from "../agent/approval/tool-approval-table.js";
import type { ToolCompactCache } from "../agent/compaction/tool-compact/tool-compact-cache.js";
import type { SessionData } from "../agent/persistence/types.js";
import type { TodoManager } from "../agent/todo";
import type { AgentUIChannel } from "../agent/ui/ui-channel.js";
import type { SessionService } from "../managers/services/session-service.js";
import type { UsageTracker } from "../managers/telemetry/usage-tracker.js";
import type { TextAdapterConfig } from "../models/adapter/adapter-factory.js";
import type { ModelStyle, ReasoningEffort } from "../models/types.js";
import type { UIMessage, UIMessage as TanStackUIMessage } from "@tanstack/ai";

export interface SessionPersistInput {
  usage: UsageTracker;
  todoManager: TodoManager | null;
  /** Current plan-mode snapshot; null/undefined when off. */
  planMode?: PlanModeState | null;
  /** Auto-approve (skip all tool approvals) flag. */
  autoMode?: boolean;
  /** Reasoning effort level to persist with this session. */
  reasoningEffort?: ReasoningEffort;
  /**
   * Identity captured when the write was requested.
   *
   * Passed to the async auto-title so a `/new`/`/resume` during the side query can drop its usage
   * and name write without comparing session ids (see `runtime-types/epoch.ts`).
   */
  epoch?: Epoch;
  resolveTextAdapter?: () => Promise<TextAdapterConfig | null>;
  emitEvent?: EmitAgentTelemetryFn;
  /**
   * Report a title attempt's outcome (`session:title`).
   *
   * Injected as a fact emitters rather than an `AgentLog`: a failed title used to be written as a
   * `side-query` warning, so "no title" and "the model call broke" were one row and neither said the
   * title was missing.
   */
  emitSessionTitle?: (payload: { ok: boolean; name?: string; error?: string }, sessionId?: string) => void;
  /**
   * Invoked when the async auto-title resolves, so the agent can broadcast the
   * new display name (the title lands on `SessionData.name` first).
   */
  onTitleResolved?: (name: string) => void;
  uiMessages?: UIMessage[];
  /**
   * Session the caller intended to write. A queued persist may run after a `/resume`/`/new`
   * has adopted a different session; refusing the stale target prevents the old transcript (or
   * mode/todo state) from landing in the new session.
   */
  sessionId?: string;
}

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
  /** Capture the session/run generation before an async write (see `runtime-types/epoch.ts`). */
  captureEpoch?: () => Epoch;
  /** The restored transcript was adopted: reset the persistence baseline against it. */
  onSessionAdopted?: (uiMessages: TanStackUIMessage[]) => void;
  usage: UsageTracker;
  getTodoManager: () => TodoManager | null;
  /** Owning runtime's env, so plan files are read under the runtime root. */
  getCoreEnv: () => ResolvedCoreEnv;
  planMode: PlanModeController;
  /** Single mode read surface (mode reads must not inspect the controllers directly). */
  getModeState: () => ModeState;
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
  /** The agent's log, for side queries the helpers run on their own (session titles). */
  getLog?: () => AgentLog | undefined;
  /** Update the agent's display name (broadcast via the state channel). */
  setDisplayName?: (name: string) => void;
  /** Re-emit the L1 state snapshot (after swapping the on-disk session id). */
  refreshState?: () => void;
  /** Persist current state only (no transcript) — used when a restore corrects the model. */
  persistSession?: () => void;
  /** Adopt the model a resumed session was saved with (no-op under remote-provider). */
  applyPersistedModel?: (next: { model: string; modelStyle?: ModelStyle }) => AppliedPersistedModel;
  /** Re-resolve capabilities / context window / pricing for the configured model. */
  refreshModelMetadata?: () => Promise<void>;
  /** Record how many `media://` refs the restore could not hydrate (`0` clears it). */
  setMediaHydrationMisses?: (count: number) => void;
  /** Drop steer/follow-up queues without clearing the transcript (no-op before initChat). */
  clearQueuedMessages: () => void;
  /** Reconcile approval / ask_user pause from restored UIMessages. */
  syncInteractionStateFromUIMessages: (
    messages: TanStackUIMessage[],
    options?: { whenClear?: "idle" | "running" | "completed" }
  ) => void;
}

export type { SessionData };
