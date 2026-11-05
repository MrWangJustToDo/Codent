import { truncateText } from "../../utils/text-truncation.js";

import { eventError } from "./event-error.js";
import { DEFAULT_EVENT_LOG_RULES, SPECIALIZED_EVENT_LOG, type EventLogRule } from "./event-log-rules.js";
import { SPECIALIZED_EVENT_LOG_HANDLERS } from "./event-log-specialized.js";
import { MAX_LOG_MESSAGE_CHARS, readEventPayload as p, summarizePayload } from "./payload.js";

import type { AgentEvent, AgentEventBus, AgentEventType } from "../agent-event-bus";
import type { AgentLog } from "../agent-log/agent-log.js";

export type { EventLogRule } from "./event-log-rules.js";

// ============================================================================
// Policy
// ============================================================================

export interface EventLogPolicy {
  /** Master switch for event-driven logging */
  enabled?: boolean;
  /** Per-event overrides; set to `false` to suppress logging for an event type */
  events?: Partial<Record<AgentEventType, EventLogRule | false>>;
}

export type EventLogResolver = (event: AgentEvent) => AgentLog | null | undefined;

function resolveRule(type: AgentEventType, policy?: EventLogPolicy): EventLogRule | false | undefined {
  const override = policy?.events?.[type];
  if (override === false) return false;
  if (override) return override;
  const rule = DEFAULT_EVENT_LOG_RULES[type];
  // A specialized row is dispatched before this lookup; keeping the marker out of the return type
  // means a future call site cannot mistake it for a formatter.
  return rule === SPECIALIZED_EVENT_LOG ? undefined : rule;
}

function writeLog(log: AgentLog, rule: EventLogRule, event: AgentEvent, message: string): void {
  const data = summarizePayload(p(event));
  // The run identity comes from the envelope, never from seam state: the producer stamps it once and
  // every consumer reads the same value.
  const run = event.runId;
  // `data` strings are bounded by `summarizePayload`; the message itself is truncated at the seam
  // (`AgentLog.log`) for EVERY writer. It is bounded again here because this text is also reused
  // as the `error` message below, and an error object's `message` is not bounded by the schema.
  message = truncateText(message, MAX_LOG_MESSAGE_CHARS);

  // A `cancelled` payload is not a fault: it must not go through the error path (that attaches the
  // payload's text as a synthesized exception — for a cancelled subagent that text is partial
  // narration). The level drops to `warn` for the same reason `agent:tool-error` does: a cancel is
  // not a failure, and `AGENT_LOG_LEVEL=error` used to keep cancels while hiding tool cancels.
  if (rule.level === "error") {
    if (p(event).cancelled === true) {
      log.eventEntry("warn", rule.category, event.type, message, data, undefined, run, event.sessionId);
      return;
    }
    // The payload's own `error` is raw provider text (often the whole 4xx/5xx body); it becomes
    // `entry.error.message`. The seam (`AgentLog.log`) bounds every writer's error message, so this
    // is deliberately not truncated here — a second, narrower bound would let the specialized
    // handlers (which do not pass through this function) keep their own behaviour.
    const errorMessage = (p(event).error as string | undefined) ?? message;
    const error = eventError(errorMessage);
    // A producer that had an `Error` supplies its stack; `eventError` deliberately invents none.
    const stack = p(event).stack;
    if (typeof stack === "string") error.stack = stack;
    log.eventEntry("error", rule.category, event.type, message, data, error, run, event.sessionId);
    return;
  }
  log.eventEntry(rule.level, rule.category, event.type, message, data, undefined, run, event.sessionId);
}

/**
 * Bridge unified {@link AgentEventBus} events into per-agent {@link AgentLog}
 * entries. Centralizes lifecycle logging so emit sites do not duplicate log
 * calls. This is the only `"*"` observer consumer in core.
 */
export function bridgeTelemetryToAgentLog(
  bus: AgentEventBus,
  resolveLog: EventLogResolver,
  policy?: EventLogPolicy
): () => void {
  const enabled = policy?.enabled ?? true;
  if (!enabled) return () => {};

  return bus.on("*", (event) => {
    const log = resolveLog(event);
    if (!log) return;

    // The table's `false` cells are authoritative, BEFORE any override. They are the projection /
    // internal events (`session:messages`, `tool:chunk`, …), and letting a host policy re-enable
    // one wrote a whole transcript snapshot into a single log line. The table already says "never".
    if (DEFAULT_EVENT_LOG_RULES[event.type] === false) return;

    // Policy overrides must still win before the specialized handlers: those events have their own
    // multi-row formatting, but an explicit `false` means "never write this event" and an explicit
    // rule means "use this".
    const override = policy?.events?.[event.type];
    if (override === false) return;
    if (override) {
      if (override.suppress?.(event)) return;
      writeLog(log, override, event, override.formatMessage(event));
      return;
    }

    const specialized = (
      SPECIALIZED_EVENT_LOG_HANDLERS as Record<string, ((l: AgentLog, e: AgentEvent) => void) | undefined>
    )[event.type];
    if (specialized) {
      specialized(log, event);
      return;
    }

    const rule = resolveRule(event.type, policy);
    if (!rule) return;
    // Per-instance suppression belongs to the rule (see `EventLogRule.suppress`): the table cell is
    // static, but "was anyone asked" is a property of the event.
    if (rule.suppress?.(event)) return;

    writeLog(log, rule, event, rule.formatMessage(event));
  });
}
