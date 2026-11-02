/**
 * Typed payloads for {@link AgentEventType}.
 *
 * Wire shape uses `payload` (not a loose `data` bag). Field names for tools keep
 * existing snake_case keys (`tool_name`, `tool_call_id`) used by Event→Log and app timing.
 *
 * The map is COMPOSED from one file per family (`event-payloads/`). It used to be a single `type`
 * literal with all 77 keys, which left the file one key away from the 800-line ceiling and made an
 * 800-line scroll the only way to answer "what does this event carry". The intersection keeps every
 * key checked exactly as before (`keyof` is the union of the members' keys), so this split changes
 * no semantics — only where each family is written down.
 */

import type { AgentEventType } from "./agent-events.js";
import type { AgentEventPayloads } from "./event-payloads/agent.js";
import type { CompactionEventPayloads } from "./event-payloads/compaction.js";
import type { PlanEventPayloads } from "./event-payloads/plan.js";
import type { SessionEventPayloads } from "./event-payloads/session.js";
import type { SubagentEventPayloads } from "./event-payloads/subagent.js";
import type { ToolEventPayloads } from "./event-payloads/tools.js";

// The shared primitives stay available from this module: it is the one path consumers import, and
// moving them to a sibling file must not move their import site.
export type {
  EmptyAgentEventPayload,
  ModeChangeField,
  SessionDiagnosticArea,
  SessionSwitchReason,
  ToolApprovalSource,
} from "./event-payloads/payload-primitives.js";

export type AgentEventPayloadMap = SessionEventPayloads &
  AgentEventPayloads &
  ToolEventPayloads &
  CompactionEventPayloads &
  SubagentEventPayloads &
  PlanEventPayloads;

export type AgentEventPayload<T extends AgentEventType> = AgentEventPayloadMap[T];
