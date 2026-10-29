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
import { hookEchoesEnabled } from "./hooks-echo.js";
import { readEventPayload as p, summarizePayload } from "./payload.js";

import type { SessionDiagnosticArea } from "../../runtime-types/agent-event-payloads.js";
import type { McpConfigSourceKind } from "../../runtime-types/mcp-status.js";
import type { AgentEvent } from "../agent-event-bus";
import type { AgentLog } from "../agent-log/agent-log.js";
import type { LogCategory, LogLevel } from "../agent-log/types.js";
import type { McpServerStatus } from "../mcp/manager.js";

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
  category: LogCategory,
  message: string,
  data?: Record<string, unknown>,
  error?: Error
): void {
  log.eventEntry(level, category, event.type, message, data, error, event.runId);
}

/** Runtime list of the log categories, for narrowing a payload value. */
const LOG_CATEGORIES = [
  "agent",
  "chat",
  "llm",
  "tool",
  "approval",
  "compaction",
  "skill",
  "memory",
  "hooks",
  "system",
  "side-query",
] as const satisfies readonly LogCategory[];

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
  // failures do not come through here — that callback is async and runs after the lease finished,
  // so it has its own event (`compaction:cache-cleanup-error`).
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

/**
 * Status transitions whose meaning is already carried by a dedicated event.
 *
 * These used to be written at `debug` ("still recorded either way"), which is why they stayed 31% of
 * the file under the default level: the approval they bracket had its own two rows. Suppressing them
 * removes a duplicate, not a fact — `aborted`/`error` and any unexplained transition still land.
 *
 * `client-tool-wait` / `client-tool-resume` are NOT in this set: `ask_user` is a client tool, so it
 * emits neither `agent:tool-start` nor `agent:tool-end`, and `session:interaction` is a projection
 * (suppressed). Suppressing both transitions made a pause on a user question leave no trace at all.
 */
const MECHANICAL_STATUS_TRIGGERS: ReadonlySet<string> = new Set([
  "approvals-pending",
  "approvals-cleared",
  "chunk:text",
  "chunk:tool",
  "chunk:reasoning",
  "run-prepare",
  "run-start",
  "run-finish",
  "run-abort",
  "run-error",
  "reconcile",
  "reconcile-after-run",
  "apply-outcome",
  "detached-terminal",
  "reset",
  "recovery-retry",
  "external-error",
  "compaction-end",
  "before-tool-call",
]);

/** Terminal outcomes a reader scans for, whatever moved the status there. */
const NOTABLE_STATUSES: ReadonlySet<string> = new Set(["error", "aborted"]);

function logAgentStatus(log: AgentLog, event: AgentEvent): void {
  const d = p(event);
  const to = typeof d.to === "string" ? d.to : "unknown";
  const trigger = typeof d.trigger === "string" ? d.trigger : undefined;
  if (!NOTABLE_STATUSES.has(to)) {
    // A transition nobody explained is worth a row; the pump's bookkeeping is not.
    if (trigger) {
      if (trigger.startsWith("compaction:")) return;
      if (MECHANICAL_STATUS_TRIGGERS.has(trigger)) return;
    }
  }
  entry(log, event, "info", "agent", `Status: ${typeof d.from === "string" ? d.from : "?"} → ${to}`, {
    from: d.from,
    to,
    ...(trigger ? { trigger } : {}),
  });
}

/**
 * Which log category a subsystem's note belongs to.
 *
 * Area → category, not event → category: the diag event is one wire shape for a dozen subsystems,
 * and the on-disk vocabulary (`memory`, `skill`, `hooks`, …) has to keep grouping them as it did
 * when each site picked its own category. The mapping is exhaustive over `SessionDiagnosticArea`
 * on purpose — a new area must decide its bucket instead of silently landing in `system`.
 */
const DIAGNOSTIC_CATEGORY: Record<SessionDiagnosticArea, LogCategory> = {
  doc: "agent",
  skill: "skill",
  memory: "memory",
  extension: "system",
  compaction: "compaction",
  middleware: "agent",
  capability: "agent",
  tool: "tool",
  stream: "agent",
  context: "agent",
  jobs: "system",
  session: "system",
  model: "agent",
};

const LOG_LEVELS: ReadonlySet<string> = new Set(["debug", "info", "warn", "error"]);

function logSessionDiagnostic(log: AgentLog, event: AgentEvent): void {
  const d = p(event);
  const area = typeof d.area === "string" ? (d.area as SessionDiagnosticArea) : "session";
  const level = typeof d.level === "string" && LOG_LEVELS.has(d.level) ? (d.level as LogLevel) : "warn";
  const category = DIAGNOSTIC_CATEGORY[area] ?? "system";
  const message = `[${area}] ${typeof d.message === "string" ? d.message : "diag"}`;
  // `details` is a shallow scalar map by type, and it still goes through the same summarizer as
  // every other payload: the previous handler wrote it verbatim, so a nested value bypassed the
  // size cap (the auto-compact `segmentTokens` array was the first to grow).
  const details =
    d.details !== undefined && typeof d.details === "object" && d.details !== null
      ? summarizePayload(d.details as Record<string, unknown>)
      : undefined;
  const errorText = typeof d.error === "string" ? eventError(d.error) : undefined;
  entry(log, event, level, category, message, details, errorText);
}

function logSessionTitle(log: AgentLog, event: AgentEvent): void {
  const d = p(event);
  if (d.ok === true) {
    entry(log, event, "info", "system", `Session title: ${typeof d.name === "string" ? d.name : "(unnamed)"}`);
    return;
  }
  entry(log, event, "warn", "system", `Session title failed: ${typeof d.error === "string" ? d.error : "unknown"}`);
}

function logExtensionLog(log: AgentLog, event: AgentEvent): void {
  const d = p(event);
  const level = d.level === "debug" || d.level === "warn" || d.level === "error" ? d.level : "info";
  const extensionId = typeof d.extensionId === "string" ? d.extensionId : "unknown";
  const message = typeof d.message === "string" ? d.message : "";
  // `ctx.logger.log(level, category, msg)` may name a category; an unknown one falls back to the
  // historical `hooks` bucket instead of inventing a value the reader cannot filter on.
  const category =
    typeof d.category === "string" && (LOG_CATEGORIES as readonly string[]).includes(d.category)
      ? (d.category as LogCategory)
      : "hooks";
  entry(log, event, level, category, `[extension:${extensionId}] ${message}`);
}

/**
 * Opt-in hook echoes (`MY_AGENT_LOG_HOOKS`).
 *
 * The flag is read in policy (`hooks-echo.ts`), and the emitter asks the same predicate before it
 * builds a payload: the event is observable, so emitting one per hook call leaks them to every
 * `observeAny` subscriber even when nothing is recorded.
 */
function logHookEcho(log: AgentLog, event: AgentEvent): void {
  if (!hookEchoesEnabled()) return;
  const d = p(event);
  const middleware = typeof d.middleware === "string" ? d.middleware : "anonymous";
  const hook = typeof d.hook === "string" ? d.hook : "?";
  entry(log, event, "debug", "hooks", `middleware:${middleware}:${hook}`, {
    ...(d.phase !== undefined ? { phase: d.phase } : {}),
    ...(d.iteration !== undefined ? { iteration: d.iteration } : {}),
  });
}

const HANDLERS = {
  "session:mcp": logSessionMcp,
  "session:diagnostic": logSessionDiagnostic,
  "session:title": logSessionTitle,
  "agent:status": logAgentStatus,
  "extension:log": logExtensionLog,
  "hooks:echo": logHookEcho,
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
