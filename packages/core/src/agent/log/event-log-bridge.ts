import { utf8ByteLength } from "../../utils/bytes.js";
import { truncateText } from "../../utils/text-truncation.js";

import { DEFAULT_EVENT_LOG_RULES, type EventLogRule } from "./event-log-rules.js";

import type { McpConfigSourceKind } from "../../runtime-types/mcp-status.js";
import type { AgentEvent, AgentEventBus, AgentEventType } from "../agent-event-bus";
import type { AgentLog } from "../agent-log/agent-log.js";
import type { McpServerStatus } from "../mcp/manager.js";

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
  return DEFAULT_EVENT_LOG_RULES[type];
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
    log.eventEntry("error", rule.category, event.type, message, data, new Error(errorMessage));
    return;
  }
  log.eventEntry(rule.level, rule.category, event.type, message, data);
}

// ============================================================================
// Custom handlers (events that need complex multi-entry logic)
// ============================================================================

function logSessionMcp(log: AgentLog, event: AgentEvent): void {
  const configSourceKind = p(event).configSourceKind as McpConfigSourceKind | undefined;
  const configLoadedFrom = p(event).configLoadedFrom as string | undefined;
  // The source is the answer to "why did my mcp.json not apply?", so a session-options session
  // says so explicitly — without it the absence of a config path reads as "no config found".
  if (configSourceKind === "session-options") {
    log.info("system", "MCP config: supplied by the session's create options (config file not consulted)");
  } else if (configLoadedFrom) {
    log.info("system", `MCP config: ${configLoadedFrom}`);
  }
  const servers = (p(event).servers as McpServerStatus[] | undefined) ?? [];
  if (servers.length === 0) {
    log.debug("system", "No MCP servers configured");
    return;
  }

  for (const server of servers) {
    if (server.status === "connected") {
      log.info("system", `MCP server: ${server.name} (${server.toolCount ?? 0} tools)`);
    } else {
      log.warn("system", `MCP server failed: ${server.name} — ${server.error ?? "unknown"}`);
    }
  }
}

function logMemoryPrefetch(log: AgentLog, event: AgentEvent): void {
  const status = p(event).status as string | undefined;
  if (status === "error") {
    log.warn("memory", `Memory prefetch failed: ${p(event).error ?? "unknown"}`);
  }
  // selected/empty/skip outcomes are silent — not actionable per-entry.
}

function logMemoryExtract(log: AgentLog, event: AgentEvent): void {
  const status = p(event).status as string | undefined;
  if (status === "error") {
    log.warn("memory", `Memory extraction failed: ${p(event).error ?? "unknown"}`);
  }
  // start/complete/empty/queued/skip-short/skip-no-adapter are silent — not
  // actionable per-entry. LLM failures are not reported here either: the
  // side-query port logs them once, under its own category.
}

function logMemoryConsolidate(log: AgentLog, event: AgentEvent): void {
  const status = p(event).status as string | undefined;
  if (status === "error") {
    log.warn("memory", `Memory consolidation failed: ${p(event).error ?? "unknown"}`);
  }
  // complete/start/skip are silent — not actionable per-entry.
}

function logCompactionAuto(log: AgentLog, event: AgentEvent): void {
  switch (event.type) {
    case "compaction:auto-start":
      log.info("compaction", "Auto-compacting context...");
      break;
    case "compaction:auto-complete":
      log.info("compaction", `Auto-compact: ${p(event).tokensBefore ?? "?"}→${p(event).tokensAfter ?? "?"} tokens`);
      break;
    case "compaction:auto-error": {
      const phase = p(event).phase as string | undefined;
      const error = (p(event).error as string | undefined) ?? "unknown";
      if (phase === "cache-cleanup") {
        log.warn("compaction", "Auto-compact cache cleanup failed", { error });
        return;
      }
      log.error("compaction", `Auto-compact failed: ${error}`, new Error(error));
      break;
    }
  }
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

    switch (event.type) {
      case "session:mcp":
        logSessionMcp(log, event);
        return;
      case "memory:prefetch":
        logMemoryPrefetch(log, event);
        return;
      case "memory:extract":
        logMemoryExtract(log, event);
        return;
      case "memory:consolidate":
        logMemoryConsolidate(log, event);
        return;
      case "compaction:auto-start":
      case "compaction:auto-complete":
      case "compaction:auto-error":
        logCompactionAuto(log, event);
        return;
    }

    const rule = resolveRule(event.type, policy);
    if (!rule) return;

    writeLog(log, rule, event, rule.formatMessage(event));
  });
}
