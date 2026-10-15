/**
 * Unified agent event system — authoritative type map.
 *
 * `AgentEvents` is the single source of truth for observer event names and
 * payload types. It merges the former lifecycle/telemetry vocabulary
 * ({@link AgentEventPayloadMap}) with the session channel projection events.
 * Augment it via `declare module` to add events.
 *
 * Two dispatch modes share this registry:
 * - observer `emit` — synchronous, fire-and-forget, error-isolated;
 * - interceptor `intercept` — async, ordered, shared mutable event, cancel
 *   short-circuits (see {@link InterceptableEvent}/{@link EventInterceptor}).
 */

import type { AgentSessionChannel, AgentSessionSubagentSummary } from "../../agent-session/types.js";
import type { AgentEventPayloadMap } from "../../runtime-types/agent-event-payloads.js";
import type {
  AgentIterationState,
  AgentL1State,
  AgentMode,
  QueuedMessagesSnapshot,
  SessionInteractionsSnapshot,
  SessionJobsSnapshot,
  UsageChangeSnapshot,
} from "../../runtime-types/session-payloads.js";
import type { DispatchRank } from "../extension/dispatch-order.js";
import type {
  EventInterceptor,
  ExtensionInfo,
  ExtensionRenderPayload,
  ExtensionUiContext,
  InterceptableEvent,
} from "../extension/types.js";
import type { PlanModeState } from "../plan/plan-mode-controller.js";
import type { SummaryStreamEvent } from "../summary-stream/types.js";
import type { TodoItem } from "../todo/types.js";
import type { ToolPresentationInfo } from "../tools/presentation/types.js";
import type { StreamingChunk } from "../tools/util/streaming-callback.js";
import type { UIMessage } from "@tanstack/ai";

// ============================================================================
// Event map
// ============================================================================

/** Transport-agnostic extension-UI notification (session `extension-ui` channel). */
export type AgentExtensionUiEvent =
  | { type: "render"; surface: string; key: string; payload: ExtensionRenderPayload | null }
  | { type: "notify"; message: string; level?: "success" | "info" | "error" }
  | { type: "context"; context: ExtensionUiContext };

/**
 * Authoritative observer event map. Keys that are not part of
 * {@link AgentEventPayloadMap} are the session/channel projection events.
 */
export interface AgentEvents extends AgentEventPayloadMap {
  /** L1 agent state: status / name / error / pendingApproval / retry. */
  "agent:state": AgentL1State;
  /** Full UI message array. */
  "session:messages": UIMessage[];
  /** Steer / follow-up queue snapshot. */
  "session:queues": QueuedMessagesSnapshot;
  /** Token + cost usage snapshot. */
  "session:usage": UsageChangeSnapshot;
  /** Todo list + title. */
  "session:todos": { items: TodoItem[]; title: string | null };
  /** Plan mode state. */
  "session:plan": PlanModeState;
  /** Summary stream event (task/compact). */
  "session:summary": SummaryStreamEvent;
  /** Derived agent mode (plan phase + auto mode). */
  "session:mode": { mode: AgentMode; autoMode: boolean };
  /** Extension list snapshot. */
  "session:extensions": { extensions: ExtensionInfo[] };
  /** Tool presentation catalog: serializable descriptors (no functions) for every known tool. */
  "session:tool-presentation": { descriptors: ToolPresentationInfo[] };
  /** Pending approvals / `ask_user` derived from the conversation. */
  "session:interaction": SessionInteractionsSnapshot;
  /** Agent-loop progress for the current run (iteration vs budget). */
  "agent:iteration": AgentIterationState;
  /** Background command jobs started by this agent (summary only — no output). */
  "session:jobs": SessionJobsSnapshot;
  /**
   * Child agents (task delegations and internal workers), as the snapshot's `subagents` array.
   *
   * A retained list channel for the same reason `session:jobs` is one: the per-row
   * `subagent:created` / `subagent:destroyed` lifecycle events carry a single id, so a subscriber
   * that re-reads its cached snapshot on them gains and loses nothing off-process — the list had
   * no channel of its own and moved only on a full resync.
   */
  "session:subagents": { subagents: AgentSessionSubagentSummary[] };
  /** Extension UI notification. */
  "extension:ui": AgentExtensionUiEvent;
  /** Streaming tool output chunk. */
  "tool:chunk": { kind: "chunk"; chunk: StreamingChunk };
  /** Streaming tool output clear. */
  "tool:clear": { kind: "clear"; toolCallId: string };
}

export type AgentEventType = keyof AgentEvents;

export type AgentEventPayload<T extends AgentEventType> = AgentEvents[T];

// ============================================================================
// Envelope + metadata
// ============================================================================

/** Observer dispatch mode; interceptors are declared separately. */
export type AgentEventDispatchMode = "emit";

/** Declared runtime metadata for one observer event. */
export interface AgentEventMeta {
  /** Dispatch mode (observer events are always `emit`). */
  mode: AgentEventDispatchMode;
  /** `AgentSession` channel this event projects onto, when applicable. */
  channel?: AgentSessionChannel;
  /** Whether the owning scope exposes a retained current value for late subscribers. */
  retained?: boolean;
}

/** Caller-supplied envelope overrides (defaults derive from the emitting scope). */
export interface AgentEventMetaInput {
  agentId?: string;
  parentId?: string;
  sessionId?: string;
}

/** Typed envelope (discriminated on `type`) shared by the wire and subscribers. */
export type AgentEvent<T extends AgentEventType = AgentEventType> = {
  [K in T]: {
    type: K;
    /** Epoch ms when the event was emitted. */
    ts: number;
    agentId: string;
    /** For subagent events, the parent agent id. */
    parentId?: string;
    /** Disk/session id when available (not the agent id). */
    sessionId?: string;
    payload: AgentEvents[K];
  };
}[T];

export type AgentEventListener<T extends AgentEventType = AgentEventType> = (event: AgentEvent<T>) => void;
export type AgentEventWildcardListener = (event: AgentEvent) => void;

// ============================================================================
// Bus surface
// ============================================================================

export type { EventInterceptor, InterceptableEvent };

/**
 * Unified event bus. One registry, two dispatch modes.
 *
 * Scoping: `scope(id)` mints a child bus. An event emitted in a scope is
 * delivered to subscribers on that scope and every ancestor scope (the root
 * observes everything; siblings are isolated). Subagent scopes are children of
 * their parent agent scope, so `subagent:*` events up-flow automatically.
 */
export interface AgentEventBus {
  /** Identity of this bus scope. */
  readonly scopeId: string;

  /**
   * Subscribe to one observer event. Retained values replay immediately unless
   * `options.replay` is `false` (for callers that reconcile the initial value
   * themselves per-subscription).
   */
  on<T extends AgentEventType>(type: T, listener: AgentEventListener<T>, options?: { replay?: boolean }): () => void;
  /** Subscribe to every observer event in scope (interceptor events excluded). */
  on(type: "*", listener: AgentEventWildcardListener): () => void;
  on(
    type: AgentEventType | "*",
    listener: AgentEventListener | AgentEventWildcardListener,
    options?: { replay?: boolean }
  ): () => void;

  /** Current retained value for an event, if a provider is registered up the scope chain. */
  retainedValue<T extends AgentEventType>(type: T): AgentEvents[T] | undefined;

  /** Emit an observer event. Synchronous, fire-and-forget, errors isolated. */
  emit<T extends AgentEventType>(type: T, payload: AgentEvents[T], meta?: AgentEventMetaInput): void;

  /** Declare a retained current value for an event; returns an unsubscribe. */
  retain<T extends AgentEventType>(type: T, provider: () => AgentEvents[T]): () => void;

  /** Mint a child scope bus. */
  scope(id: string): AgentEventBus;

  /** Dispatch an interceptor event (async, ordered, shared mutable event). */
  intercept<T extends InterceptableEvent>(event: T): Promise<T["defaultReturn"] | undefined>;

  /**
   * Register an interceptor for an exact name or a `prefix:*` pattern. `rank` is the declaring
   * extension's dispatch position; omit it for a non-extension interceptor (order 0, inserted
   * after every ranked one).
   */
  onIntercept<T extends InterceptableEvent>(
    pattern: string,
    handler: EventInterceptor<T>,
    rank?: DispatchRank
  ): () => void;

  /** Whether any interceptor (in scope chain) matches `name` (fast-path guard). */
  hasInterceptors(name: string): boolean;
}
