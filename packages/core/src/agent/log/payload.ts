import { utf8ByteLength } from "../../utils/bytes.js";
import { truncateText } from "../../utils/text-truncation.js";

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
/** Upper bound for an entry's human-readable message (the `data` previews are bounded separately). */
export const MAX_LOG_MESSAGE_CHARS = 400;
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
 * Reduce an event payload (or a diagnostic's `details`) into log-safe `data`:
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
