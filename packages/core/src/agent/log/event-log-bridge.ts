import { utf8ByteLength } from "../../utils/bytes.js";
import { truncateText } from "../../utils/text-truncation.js";

import { eventError } from "./event-error.js";
import { DEFAULT_EVENT_LOG_RULES, SPECIALIZED_EVENT_LOG, type EventLogRule } from "./event-log-rules.js";
import { SPECIALIZED_EVENT_LOG_HANDLERS } from "./event-log-specialized.js";

import type { AgentEvent, AgentEventBus, AgentEventType } from "../agent-event-bus";
import type { AgentLog } from "../agent-log/agent-log.js";

export type { EventLogRule } from "./event-log-rules.js";

/** Read payload fields for logging formatters. */
function p(event: AgentEvent): Record<string, unknown> {
  return event.payload as Record<string, unknown>;
}

// ============================================================================
// Payload summarization — logs carry sizes + previews, never full payloads
// ============================================================================

/** Keys whose values are known-large payloads (tool inputs/outputs, prompts). */
const PAYLOAD_KEYS = new Set(["tool_input", "tool_output", "tool_result", "input", "output", "prompt", "result"]);

/** Field-name suffixes that are safe to keep as-is (scalar observability data). */
const KEEP_FIELD_RE =
  /(?:bytes|tokens|_ms|ms$|count$|ids?$|names?$|model$|style$|status$|phase$|reason$|error$|strategy$|attempt$|summary$|description$|cwd$|usage$|cost$|durationMs$|duration_ms$|finishReason$|messageCount$|stepCount$|tokenEstimate$|prompt$)/i;

const PREVIEW_MAX_CHARS = 200;
const KEEP_STRING_MAX_CHARS = 120;
const KEEP_STRING_HARD_MAX_CHARS = 500;

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Summarize any value into `<key>Bytes` + `<key>Preview` (≤200 chars). */
function summarizeEntry(out: Record<string, unknown>, key: string, value: unknown): void {
  const text = asText(value);
  out[`${key}Bytes`] = utf8ByteLength(text);
  out[`${key}Preview`] = text.length > PREVIEW_MAX_CHARS ? text.slice(0, PREVIEW_MAX_CHARS) : text;
}

/**
 * Reduce an event payload into log-safe `data`:
 * - drops the redundant `eventType` (already expressed by the message);
 * - known-large payload fields and unknown objects become `{field}Bytes` + `{field}Preview`;
 * - scalar observability fields (bytes/tokens/ms/ids/names/counts/…) pass through;
 * - long unmatched strings are summarized; kept strings are hard-capped.
 */
export function summarizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "eventType") continue;

    if (PAYLOAD_KEYS.has(key)) {
      // Normalize payload field names: tool_input→input, tool_output→output.
      const name = key === "tool_input" ? "input" : key === "tool_output" || key === "tool_result" ? "output" : key;
      summarizeEntry(out, name, value);
      continue;
    }

    if (value !== null && typeof value === "object") {
      summarizeEntry(out, key, value);
      continue;
    }

    if (typeof value === "string") {
      if (value.length <= KEEP_STRING_MAX_CHARS || KEEP_FIELD_RE.test(key)) {
        out[key] = truncateText(value, KEEP_STRING_HARD_MAX_CHARS);
      } else {
        summarizeEntry(out, key, value);
      }
      continue;
    }

    out[key] = value;
  }
  return out;
}

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

  // A `cancelled` payload is not a fault, so it must not be written through the error
  // path: that attaches the payload's `error` text as a synthesized `Error` — for a
  // cancelled subagent that text is its partial narration, and the entry then carried
  // a whole paragraph as a stack-bearing exception. The level stays at the rule's
  // (the rule table is static per event type; `agent:tool-error` keeps `warn` for the
  // same reason), only the fault-shaped error object is dropped.
  if (rule.level === "error") {
    if (p(event).cancelled === true) {
      log.eventEntry("error", rule.category, event.type, message, data);
      return;
    }
    const errorMessage = (p(event).error as string | undefined) ?? message;
    log.eventEntry("error", rule.category, event.type, message, data, eventError(errorMessage));
    return;
  }
  log.eventEntry(rule.level, rule.category, event.type, message, data);
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
