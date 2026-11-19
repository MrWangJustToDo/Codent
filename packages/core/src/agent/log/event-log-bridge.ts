import { truncateText } from "../../utils/text-truncation.js";

import { eventError } from "./event-error.js";
import {
  DEFAULT_EVENT_LOG_RULES,
  PROJECTION_EVENT_LOG_RULES,
  SPECIALIZED_EVENT_LOG,
  type EventLogRule,
} from "./event-log-rules.js";
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

/**
 * Session-projection / internal events: a snapshot that re-publishes on every change.
 *
 * Never writable, overrides included — letting a host policy re-enable one wrote a whole transcript
 * snapshot into a single log line. Derived from the table rather than kept as a second name list.
 */
const PROJECTION_EVENT_TYPES: ReadonlySet<string> = new Set(Object.keys(PROJECTION_EVENT_LOG_RULES));

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
  const payload = p(event);
  // A `cancelled` payload is not a fault: it must not go through the error path (that attaches the
  // payload's text as a synthesized exception — for a cancelled subagent that text is partial
  // narration). The level drops to `warn` for the same reason `agent:tool-error` does: a cancel is
  // not a failure, and `AGENT_LOG_LEVEL=error` used to keep cancels while hiding tool cancels.
  const cancelled = payload.cancelled === true;
  const configured = typeof rule.level === "function" ? rule.level(event) : rule.level;
  const level = configured === "error" && cancelled ? "warn" : configured;
  // Filter BEFORE summarizing: `summarizePayload` stringifies arbitrary tool input/output (up to
  // 50 KB each), and the seam dropped the result afterwards. Raising AGENT_LOG_LEVEL is exactly
  // when that work should not happen. Optional-call: a duck-typed sink used by validators/embedded
  // hosts may only implement `eventEntry`, and it must keep working.
  if (log.isLevelEnabled?.(level) === false) return;
  // Per-instance suppression belongs to the rule (see `EventLogRule.suppress`): the table cell is
  // static, but "was anyone asked" is a property of the event. Checked AFTER the level so a hidden
  // event does not consume a stateful suppression's bookkeeping — the handler-failure throttle
  // would otherwise stamp its window while `AGENT_LOG_LEVEL` hides the row, and raising the level
  // later swallowed the first real one.
  if (rule.suppress?.(event)) return;

  const data = summarizePayload(payload);
  // The run identity comes from the envelope, never from seam state: the producer stamps it once and
  // every consumer reads the same value.
  const run = event.runId;
  // `data` strings are bounded by `summarizePayload`; the message itself is truncated at the seam
  // (`AgentLog.log`) for EVERY writer. It is bounded again here because this text is also reused
  // as the `error` message below, and an error object's `message` is not bounded by the schema.
  message = truncateText(message, MAX_LOG_MESSAGE_CHARS);

  // One shape for every fault row: the LEVEL decides how loud a line is, never whether the
  // structured `entry.error` exists. Building it only for `level === "error"` meant every
  // warn-level fault (`agent:tool-error`, `session:save-error`, `agent:retry`) was invisible to a
  // reader filtering `entry.error`, while a warn-level `session:diagnostic` DID carry one — the
  // same fact in two shapes, decided by severity rather than by what happened.
  const payloadError = typeof payload.error === "string" ? payload.error : undefined;
  // A cancelled payload is not a fault: its `error` field is partial narration, not an exception.
  const faulted = !cancelled && (payloadError !== undefined || level === "error");
  let error: Error | undefined;
  if (faulted) {
    // The payload's own `error` is raw provider text (often the whole 4xx/5xx body); the seam
    // (`AgentLog.log`) bounds it, so it is deliberately not truncated again here — a second,
    // narrower bound would let the specialized handlers (which do not pass through this function)
    // keep their own behaviour.
    error = eventError(payloadError ?? message);
    // A producer that had an `Error` supplies its stack; `eventError` deliberately invents none.
    const stack = payload.stack;
    if (typeof stack === "string") error.stack = stack;
  }
  log.eventEntry(level, rule.category, event.type, message, data, error, run, event.sessionId);
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
    // The table's `false` cells are authoritative by default. A PROJECTION cell is never writable,
    // overrides included: a snapshot re-publishes on every change, so an override wrote a whole
    // transcript snapshot into a single log line. A TELEMETRY cell that is `false` by default
    // (`turn:start`, `turn:end`, `message:start`, `message:end`, `subagent:queue`) is a different
    // decision — "not logged unless a policy opts in" — so an explicit rule is honoured instead of
    // being silently inert.
    //
    // Checked BEFORE `resolveLog`: this runs on every streamed delta (`session:messages`) and every
    // stdout chunk (`tool:chunk`), and resolving the owning log walks the scope chain for an event
    // that can never produce a row.
    const override = policy?.events?.[event.type];
    if (
      DEFAULT_EVENT_LOG_RULES[event.type] === false &&
      (PROJECTION_EVENT_TYPES.has(event.type) || override === undefined || override === false)
    ) {
      return;
    }

    const log = resolveLog(event);
    if (!log) return;

    // Policy overrides must still win before the specialized handlers: those events have their own
    // multi-row formatting, but an explicit `false` means "never write this event" and an explicit
    // rule means "use this".
    if (override === false) return;
    if (override) {
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

    writeLog(log, rule, event, rule.formatMessage(event));
  });
}
