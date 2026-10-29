/**
 * Events whose log row is written by a dedicated handler instead of the generic rule table.
 *
 * These are the events where "one message per entry" is not enough: MCP logs one row per server
 * plus a config-source row, the memory events are silent except on failure, and the compaction
 * events have three different shapes. They used to sit in the rule table as `false`, which read as
 * "suppressed" and was in fact never consulted (the bridge's `switch` returned first) — seven dead
 * rows. The table now marks them `"specialized"` and this module is the one place the handlers live,
 * so the marker and the implementation cannot drift.
 */

import { eventError } from "./event-error.js";

import type { McpConfigSourceKind } from "../../runtime-types/mcp-status.js";
import type { AgentEvent } from "../agent-event-bus";
import type { AgentLog } from "../agent-log/agent-log.js";
import type { McpServerStatus } from "../mcp/manager.js";

/** Read payload fields for logging formatters. */
function p(event: AgentEvent): Record<string, unknown> {
  return event.payload as Record<string, unknown>;
}

/** A handler that writes its own rows for one event type. */
export type SpecializedEventLogHandler = (log: AgentLog, event: AgentEvent) => void;

/**
 * Write one row stamped with the originating event type.
 *
 * The generic rule path stamps `event` ("each entry stamped with the originating event type"),
 * but the specialized handlers used the bare `log.info` API and lost it — so the MCP / memory /
 * compaction rows could not be filtered by event at all. One helper, so a new handler cannot
 * forget it.
 */
function entry(
  log: AgentLog,
  event: AgentEvent,
  level: "debug" | "info" | "warn" | "error",
  category: "system" | "memory" | "compaction",
  message: string,
  data?: Record<string, unknown>,
  error?: Error
): void {
  log.eventEntry(level, category, event.type, message, data, error);
}

function logSessionMcp(log: AgentLog, event: AgentEvent): void {
  const configSourceKind = p(event).configSourceKind as McpConfigSourceKind | undefined;
  const configLoadedFrom = p(event).configLoadedFrom as string | undefined;
  // The source is the answer to "why did my mcp.json not apply?", so a session-options session
  // says so explicitly — without it the absence of a config path reads as "no config found".
  if (configSourceKind === "session-options") {
    entry(
      log,
      event,
      "info",
      "system",
      "MCP config: supplied by the session's create options (config file not consulted)"
    );
  } else if (configLoadedFrom) {
    entry(log, event, "info", "system", `MCP config: ${configLoadedFrom}`);
  }
  const servers = (p(event).servers as McpServerStatus[] | undefined) ?? [];
  if (servers.length === 0) {
    entry(log, event, "debug", "system", "No MCP servers configured");
    return;
  }

  for (const server of servers) {
    if (server.status === "connected") {
      entry(log, event, "info", "system", `MCP server: ${server.name} (${server.toolCount ?? 0} tools)`);
    } else {
      entry(log, event, "warn", "system", `MCP server failed: ${server.name} — ${server.error ?? "unknown"}`);
    }
  }
}

function logMemoryPrefetch(log: AgentLog, event: AgentEvent): void {
  const status = p(event).status as string | undefined;
  if (status === "error") {
    entry(log, event, "warn", "memory", `Memory prefetch failed: ${p(event).error ?? "unknown"}`);
  }
  // selected/empty/skip outcomes are silent — not actionable per-entry.
}

function logMemoryExtract(log: AgentLog, event: AgentEvent): void {
  const status = p(event).status as string | undefined;
  if (status === "error") {
    entry(log, event, "warn", "memory", `Memory extraction failed: ${p(event).error ?? "unknown"}`);
  }
  // start/complete/empty/queued/skip-short/skip-no-adapter are silent — not
  // actionable per-entry. LLM failures are not reported here either: the
  // side-query port logs them once, under its own category.
}

function logMemoryConsolidate(log: AgentLog, event: AgentEvent): void {
  const status = p(event).status as string | undefined;
  if (status === "error") {
    entry(log, event, "warn", "memory", `Memory consolidation failed: ${p(event).error ?? "unknown"}`);
  }
  // complete/start/skip are silent — not actionable per-entry.
}

function logCompactionAutoStart(log: AgentLog, event: AgentEvent): void {
  entry(log, event, "info", "compaction", "Auto-compacting context...");
}

function logCompactionAutoComplete(log: AgentLog, event: AgentEvent): void {
  entry(
    log,
    event,
    "info",
    "compaction",
    `Auto-compact: ${p(event).tokensBefore ?? "?"}→${p(event).tokensAfter ?? "?"} tokens`
  );
}

function logCompactionAutoError(log: AgentLog, event: AgentEvent): void {
  const error = (p(event).error as string | undefined) ?? "unknown";
  // The payload carries the message, not the exception: `eventError` keeps the text without
  // inventing a stack at the logger (which would point every reader at this file). Cache-cleanup
  // failures do not come through here any more — the callback is async and runs after the lease
  // finished, so it writes a direct `warn` row instead.
  entry(log, event, "error", "compaction", `Auto-compact failed: ${error}`, undefined, eventError(error));
}

// A manual `/compact` is the user's own action, so its lines say so — borrowing the "Auto-" prefix
// made the timeline unable to answer "did the loop compact, or did I?".
function logCompactionManualStart(log: AgentLog, event: AgentEvent): void {
  entry(log, event, "info", "compaction", "Compacting context (manual)...");
}

function logCompactionManualComplete(log: AgentLog, event: AgentEvent): void {
  entry(
    log,
    event,
    "info",
    "compaction",
    `Manual compact: ${p(event).tokensBefore ?? "?"}→${p(event).tokensAfter ?? "?"} tokens`
  );
}

function logCompactionManualError(log: AgentLog, event: AgentEvent): void {
  const error = (p(event).error as string | undefined) ?? "unknown";
  entry(log, event, "error", "compaction", `Manual compact failed: ${error}`, undefined, eventError(error));
}

const HANDLERS = {
  "session:mcp": logSessionMcp,
  "memory:prefetch": logMemoryPrefetch,
  "memory:extract": logMemoryExtract,
  "memory:consolidate": logMemoryConsolidate,
  "compaction:auto-start": logCompactionAutoStart,
  "compaction:auto-complete": logCompactionAutoComplete,
  "compaction:auto-error": logCompactionAutoError,
  "compaction:manual-start": logCompactionManualStart,
  "compaction:manual-complete": logCompactionManualComplete,
  "compaction:manual-error": logCompactionManualError,
} satisfies Record<string, SpecializedEventLogHandler>;

/** The event types that own a dedicated handler. One source with {@link SPECIALIZED_EVENT_LOG_HANDLERS}. */
export type SpecializedEventLogType = keyof typeof HANDLERS;

/** Dedicated handlers, keyed by event type (the bridge dispatches through this map). */
export const SPECIALIZED_EVENT_LOG_HANDLERS: Readonly<Record<SpecializedEventLogType, SpecializedEventLogHandler>> =
  HANDLERS;

/** Every event type with a dedicated handler, as a runtime value. */
export const SPECIALIZED_EVENT_LOG_TYPES = Object.keys(HANDLERS) as SpecializedEventLogType[];
