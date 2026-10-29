import type { AgentEvent } from "../../agent/agent-event-bus";
import type { AgentEventPayloadMap } from "../../runtime-types/agent-event-payloads.js";
import type { EmitAgentTelemetryFn } from "../../runtime-types/agent-events.js";

/** Telemetry event names (payload-map keys); excludes session-projection events. */
type TelemetryEventType = keyof AgentEventPayloadMap;

export type { EmitAgentTelemetryFn } from "../../runtime-types/agent-events.js";

/**
 * Telemetry emitted before the agent had a bus to dispatch on.
 *
 * `emitAgentTelemetry` used to return silently, so an event lost in the pre-wiring window was
 * indistinguishable from one that was never emitted. The count is exported so a validator can
 * assert the bootstrap deferral covers the window instead of trusting it.
 */
let droppedTelemetryEvents = 0;

export function getDroppedTelemetryEventCount(): number {
  return droppedTelemetryEvents;
}

/** Test-only reset (one process hosts several bootstraps in the validator suite). */
export function resetDroppedTelemetryEventCount(): void {
  droppedTelemetryEvents = 0;
}

/** Minimal surface for unified agent telemetry emission. */
export interface AgentTelemetryEmitter {
  readonly id: string;
  /** Present on a subagent: its events carry the parent link without every call site passing it. */
  readonly parentId?: string;
  dispatchEvent?: (event: AgentEvent) => void;
  getSessionData?(): { id: string } | null;
  /**
   * Current agent run id, when one is active (`null` while idle). Stamped onto the envelope so
   * consumers (the Event→Log bridge, extensions) read one run identity instead of keeping their own
   * state.
   */
  getCurrentRunId?(): string | null | undefined;
  /**
   * Session id an event from this agent should carry, when it is not `getSessionData()`.
   *
   * A subagent has no session of its own (it runs inside the parent's), so the owner resolves the
   * parent's id here. Returning undefined means "unknown" — the envelope then omits `sessionId`.
   */
  getEventSessionId?(): string | undefined;
}

export interface EmitAgentTelemetryOptions {
  /** Override agentId (default: emitter.id) */
  agentId?: string;
  parentId?: string;
  /** Override sessionId (default: `getEventSessionId()` / `getSessionData()?.id`, omitted when unknown) */
  sessionId?: string;
  /** Override the run id (default: `getCurrentRunId()`, omitted outside a run) */
  runId?: string;
}

/** Bind {@link emitAgentTelemetry} to a managed agent or other emitter. */
export function createEmitTelemetryFn(emitter: AgentTelemetryEmitter): EmitAgentTelemetryFn {
  // The parent link travels with the emitter: middleware and domain objects receive this bound fn
  // (`deps.emitEvent`), and a child's compaction/tool events must carry the parent too.
  const parentId = emitter.parentId;
  return (type, payload) =>
    emitAgentTelemetry(emitter, type, payload, parentId !== undefined ? { parentId } : undefined);
}

/**
 * Unified telemetry emission helper.
 * Injects `ts` and `sessionId` when session data is available.
 */
export function emitAgentTelemetry<T extends TelemetryEventType>(
  emitter: AgentTelemetryEmitter,
  type: T,
  payload?: AgentEventPayloadMap[T],
  options?: EmitAgentTelemetryOptions
): void {
  if (!emitter.dispatchEvent) {
    droppedTelemetryEvents += 1;
    return;
  }

  // Never fall back to the agent id: `sessionId` and `agentId` are different identifier spaces, and
  // stamping the agent id made a subagent's events claim a session that does not exist. Unknown is
  // reported as absent.
  const sessionId = options?.sessionId ?? emitter.getEventSessionId?.() ?? emitter.getSessionData?.()?.id;
  const runId = options?.runId ?? emitter.getCurrentRunId?.() ?? undefined;
  const body = (payload ?? {}) as AgentEventPayloadMap[T];

  emitter.dispatchEvent({
    type,
    ts: Date.now(),
    agentId: options?.agentId ?? emitter.id,
    parentId: options?.parentId,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(runId !== undefined ? { runId } : {}),
    payload: body,
  } as AgentEvent);
}
