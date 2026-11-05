import type { AgentEvent } from "../../agent/agent-event-bus";
import type { AgentEventPayloadMap } from "../../runtime-types/agent-event-payloads.js";
import type {
  EmitAgentTelemetryFn,
  EmitAgentTelemetryOptions,
  EmitPayloadArgs,
  TelemetryEventType,
} from "../../runtime-types/agent-events.js";

export type { EmitAgentTelemetryFn, EmitAgentTelemetryOptions } from "../../runtime-types/agent-events.js";

/**
 * Args tuple for `emitAgentTelemetry`, with the payload requirement resolved from its type.
 *
 * Declared here (not as `[...EmitPayloadArgs<T>, options?]`) because spreading a conditional tuple
 * and appending an optional element is not reliably reduced by the checker.
 */
// One shape in `runtime-types`; a local copy would be the first place a new envelope field does
// not reach this entry point.
type TelemetryArgs<T> = EmitPayloadArgs<T>;

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

/** Bind {@link emitAgentTelemetry} to a managed agent or other emitter. */
export function createEmitTelemetryFn(emitter: AgentTelemetryEmitter): EmitAgentTelemetryFn {
  // The parent link travels with the emitter: middleware and domain objects receive this bound fn
  // (`deps.emitEvent`), and a child's compaction/tool events must carry the parent too.
  const parentId = emitter.parentId;
  return (type, ...args) =>
    dispatchAgentTelemetry(
      emitter,
      type,
      args[0],
      // A caller's override WINS over the emitter's parent link: explicit beats derived, and the
      // options element is the seam an asynchronous producer uses to name the session it belongs to.
      parentId !== undefined ? { parentId, ...args[1] } : args[1]
    );
}

/**
 * Unified telemetry emission helper — the strict entry point.
 *
 * The payload is mandatory for every event whose payload type has a required field
 * (`EmitPayloadArgs`), so a frame can no longer be dispatched as `payload: {}`. All the real work
 * lives in {@link dispatchAgentTelemetry}, which takes the loose shape the generic plumbing
 * (services/middleware forwarding a `(type, payload)` pair) needs.
 */
export function emitAgentTelemetry<T extends TelemetryEventType>(
  emitter: AgentTelemetryEmitter,
  type: T,
  ...args: TelemetryArgs<AgentEventPayloadMap[T]>
): void {
  dispatchAgentTelemetry(emitter, type, args[0], args[1]);
}

/**
 * Assemble and dispatch one telemetry frame.
 *
 * @internal Loose by design: `ManagedAgent.emitEvent` and `createEmitTelemetryFn` forward a
 * caller-supplied `(type, payload)` pair, which cannot satisfy a per-event conditional tuple. The
 * compile-time guarantee lives on the two public entry points; this is the single dispatch body.
 */
export function dispatchAgentTelemetry<T extends TelemetryEventType>(
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
  //
  // `sessionId` and `runId` are ONE identity. An asynchronous producer pins the session it belongs
  // to; the run that happens to be live when the frame is finally dispatched may belong to a
  // DIFFERENT session (a `/resume` committed in between), and stamping it made a departure's
  // failure line land under the target's run. So an explicit session id that is not the emitter's
  // current one suppresses the live-run fallback; when it matches (the common in-session save
  // error), the current run is still the right attribution. A caller that knows the run passes both.
  const explicitSessionId = options?.sessionId;
  const currentSessionId = emitter.getEventSessionId?.() ?? emitter.getSessionData?.()?.id;
  const sessionId = explicitSessionId ?? currentSessionId;
  const runId =
    options?.runId ??
    (explicitSessionId !== undefined && explicitSessionId !== currentSessionId
      ? undefined
      : (emitter.getCurrentRunId?.() ?? undefined));
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
