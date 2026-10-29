import type { AgentEvent } from "../agent-event-bus";

/**
 * Read a telemetry payload as a plain record.
 *
 * One definition for the three formatters that read it (event→log bridge, the rule table, the
 * specialized handlers): they describe the same event, and three copies of the cast is how one of
 * them starts reading a field the others dropped.
 */
export function readEventPayload(event: AgentEvent): Record<string, unknown> {
  return event.payload as Record<string, unknown>;
}
