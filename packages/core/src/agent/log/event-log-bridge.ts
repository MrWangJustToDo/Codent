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
  // `data` strings are bounded; `message` was not. Several rules interpolate a raw provider error
  // (`Stream error: ${error}`), and a gateway that answers with an HTML/JSON body turned one log
  // line into an arbitrarily long blob. Truncated here so EVERY rule is covered at once (the full
  // text, when it matters, is already in `data.error` under the same 500-char cap).
  message = truncateText(message, MAX_LOG_MESSAGE_CHARS);

  // A `cancelled` payload is not a fault: it must not go through the error path (that attaches the
  // payload's text as a synthesized exception — for a cancelled subagent that text is partial
  // narration). The level drops to `warn` for the same reason `agent:tool-error` does: a cancel is
  // not a failure, and `AGENT_LOG_LEVEL=error` used to keep cancels while hiding tool cancels.
  if (rule.level === "error") {
    if (p(event).cancelled === true) {
      log.eventEntry("warn", rule.category, event.type, message, data, undefined, run);
      return;
    }
    const errorMessage = (p(event).error as string | undefined) ?? message;
    const error = eventError(errorMessage);
    // A producer that had an `Error` supplies its stack; `eventError` deliberately invents none.
    const stack = p(event).stack;
    if (typeof stack === "string") error.stack = stack;
    log.eventEntry("error", rule.category, event.type, message, data, error, run);
    return;
  }
  log.eventEntry(rule.level, rule.category, event.type, message, data, undefined, run);
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

    // Policy overrides must win before the specialized handlers: those events have their own
    // multi-row formatting, but an explicit `false` still means "never write this event" and an
    // explicit rule still means "use this".
    const override = policy?.events?.[event.type];
    if (override === false) return;
    if (override) {
      if (override.suppress?.(event)) return;
      writeLog(log, override, event, override.formatMessage(event));
      return;
    }

    // The table can also silence a specialized event. Without this check the handler ran first, so
    // flipping a `"specialized"` cell to `false` looked like a suppression and wrote rows anyway —
    // fail-open on the one decision the table is supposed to own.
    if (DEFAULT_EVENT_LOG_RULES[event.type] === false) return;

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
