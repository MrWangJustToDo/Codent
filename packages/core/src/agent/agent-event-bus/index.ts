/**
 * Unified agent event bus — single registry, two dispatch modes
 * (observer `emit` / interceptor `intercept`), retained values, scoped routing,
 * and the metadata table that drives the `AgentSession` channel projection.
 */

export { DefaultAgentEventBus, createAgentEventBus } from "./agent-event-bus.js";
export { AGENT_EVENT_META } from "./meta.js";
export type {
  AgentEvent,
  AgentEventBus,
  AgentEventListener,
  AgentEventMeta,
  AgentEventMetaInput,
  AgentEventPayload,
  AgentEvents,
  AgentEventType,
  AgentEventWildcardListener,
  AgentExtensionUiEvent,
  EventInterceptor,
  InterceptableEvent,
} from "./types.js";
export type { AgentEventPayloadMap } from "../../runtime-types/agent-event-payloads.js";
