/**
 * Events whose log row is written by a dedicated handler instead of the generic rule table.
 *
 * These are the events where "one message per entry" is not enough: MCP logs one row per server
 * plus a config-source row, the memory events are silent except on failure, and the auto-compaction
 * events have three different shapes. They used to sit in the rule table as `false`, which read as
 * "suppressed" and was in fact never consulted (the bridge's `switch` returned first) — seven dead
 * rows. The table now marks them `"specialized"` and this module is the one place the handlers live,
 * so the marker and the implementation cannot drift.
 */

import { toError } from "../../utils/errors.js";

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

function logCompactionAutoStart(log: AgentLog): void {
  log.info("compaction", "Auto-compacting context...");
}

function logCompactionAutoComplete(log: AgentLog, event: AgentEvent): void {
  log.info("compaction", `Auto-compact: ${p(event).tokensBefore ?? "?"}→${p(event).tokensAfter ?? "?"} tokens`);
}

function logCompactionAutoError(log: AgentLog, event: AgentEvent): void {
  const phase = p(event).phase as string | undefined;
  const error = (p(event).error as string | undefined) ?? "unknown";
  if (phase === "cache-cleanup") {
    log.warn("compaction", "Auto-compact cache cleanup failed", { error });
    return;
  }
  // `toError` keeps a non-Error payload (a plain string is what a provider often throws) from
  // losing its message when the log entry is built.
  log.error("compaction", `Auto-compact failed: ${error}`, toError(error));
}

const HANDLERS = {
  "session:mcp": logSessionMcp,
  "memory:prefetch": logMemoryPrefetch,
  "memory:extract": logMemoryExtract,
  "memory:consolidate": logMemoryConsolidate,
  "compaction:auto-start": logCompactionAutoStart,
  "compaction:auto-complete": logCompactionAutoComplete,
  "compaction:auto-error": logCompactionAutoError,
} satisfies Record<string, SpecializedEventLogHandler>;

/** The event types that own a dedicated handler. One source with {@link SPECIALIZED_EVENT_LOG_HANDLERS}. */
export type SpecializedEventLogType = keyof typeof HANDLERS;

/** Dedicated handlers, keyed by event type (the bridge dispatches through this map). */
export const SPECIALIZED_EVENT_LOG_HANDLERS: Readonly<Record<SpecializedEventLogType, SpecializedEventLogHandler>> =
  HANDLERS;

/** Every event type with a dedicated handler, as a runtime value. */
export const SPECIALIZED_EVENT_LOG_TYPES = Object.keys(HANDLERS) as SpecializedEventLogType[];
