import type { AgentEventPayloadMap } from "./agent-event-payloads.js";

// ============================================================================
// Event Types
// ============================================================================

/**
 * Telemetry event types (emitted via ManagedAgent.emitEvent / emitAgentTelemetry).
 *
 * Deliberately NOT named `AgentEventType`: the authoritative full registry (telemetry + session
 * projection events) lives on `AgentEventBus`, and two same-named types in one package meant a
 * consumer could hold the narrower one while calling the wider bus API (`AgentEventPayload<...>`
 * failing its own constraint was the first symptom). Anything host-facing uses the bus type.
 */
export type TelemetryEventType = keyof AgentEventPayloadMap;

/**
 * Keys of a payload type whose value is required (not `undefined`-able).
 *
 * Whether an event's payload may be omitted is a property of the payload TYPE, not of the call
 * site: a payload with at least one required field can never have a meaningful `undefined`.
 */
type RequiredPayloadKeys<T> = {
  [K in keyof T]-?: undefined extends T[K] ? never : [T[K]] extends [never] ? never : K;
}[keyof T];

/** Whether omitting the payload for a payload type would produce an incomplete frame. */
export type PayloadRequired<T> = [RequiredPayloadKeys<T>] extends [never] ? false : true;

/**
 * Envelope overrides an asynchronous producer must be able to state.
 *
 * `sessionId` is the load-bearing one: a persist/title/side-query continuation resolves after the
 * agent may have adopted another session, and the funnel's default ("the agent's CURRENT session")
 * would file the row under the target's log.
 */
export interface EmitAgentTelemetryOptions {
  /** Override agentId (default: emitter.id). */
  agentId?: string;
  parentId?: string;
  /** Override sessionId (default: `getEventSessionId()` / `getSessionData()?.id`, omitted when unknown). */
  sessionId?: string;
  /** Override the run id (default: `getCurrentRunId()`, omitted outside a run). */
  runId?: string;
}

/**
 * Args tuple for a telemetry event: the payload is mandatory when the payload type has a required
 * field. `payload?` used to accept the omission for EVERY event, so `emitEvent("job:changed")`
 * compiled and produced `payload: {}` — a frame whose consumers printed `Job ? started`. An
 * all-optional payload stays omittable.
 *
 * The options element is part of the shared contract so every host of this function (services,
 * middleware, the session store) can state the envelope for work that outlived its session —
 * previously only `ManagedAgent.emitEvent` could, and the narrower seam dropped the fact.
 */
export type EmitPayloadArgs<T> =
  PayloadRequired<T> extends true
    ? [payload: T, options?: EmitAgentTelemetryOptions]
    : [payload?: T, options?: EmitAgentTelemetryOptions];

/** Callback shape for services/middleware that emit lifecycle telemetry. */
export type EmitAgentTelemetryFn = <T extends TelemetryEventType>(
  type: T,
  ...args: EmitPayloadArgs<AgentEventPayloadMap[T]>
) => void;
