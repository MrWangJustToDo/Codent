import type { AgentEventPayloadMap } from "./agent-event-payloads.js";

// ============================================================================
// Event Types
// ============================================================================

/**
 * Agent telemetry event types (emitted via ManagedAgent.emitEvent /
 * emitAgentTelemetry). Derived from the payload map — the authoritative full
 * registry (including session-projection events) lives on `AgentEventBus`.
 */
export type AgentEventType = keyof AgentEventPayloadMap;

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
 * Args tuple for a telemetry event: the payload is mandatory when the payload type has a required
 * field. `payload?` used to accept the omission for EVERY event, so `emitEvent("job:changed")`
 * compiled and produced `payload: {}` — a frame whose consumers printed `Job ? started`. An
 * all-optional payload stays omittable.
 */
export type EmitPayloadArgs<T> = PayloadRequired<T> extends true ? [payload: T] : [payload?: T];

/** Callback shape for services/middleware that emit lifecycle telemetry. */
export type EmitAgentTelemetryFn = <T extends AgentEventType>(
  type: T,
  ...args: EmitPayloadArgs<AgentEventPayloadMap[T]>
) => void;
