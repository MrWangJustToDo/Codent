/**
 * Default event → AgentLog mapping for {@link bridgeTelemetryToAgentLog}.
 */

import { truncateText } from "../../utils/text-truncation.js";

import type { AgentEventPayloadMap } from "../../runtime-types/agent-event-payloads.js";
import type { AgentEvent, AgentEventType } from "../agent-event-bus";
import type { LogCategory, LogLevel } from "../agent-log/types.js";
import type { SubagentStopReason } from "../subagent/subagent-stop-reason.js";

/** Read payload fields for logging formatters. */
function p(event: AgentEvent): Record<string, unknown> {
  return event.payload as Record<string, unknown>;
}

/**
 * Append the parent `task` call binding so a subagent line is attributable to its call.
 *
 * Without it, two children of the same `task` call (a discarded eager one and the real
 * one) read as two unrelated subagents, and the pairing has to be reconstructed by
 * timestamp. Omitted when the subagent has no task binding (an internal worker).
 */
function taskBindingSuffix(payload: Record<string, unknown>): string {
  const id = payload.parentTaskToolCallId;
  return typeof id === "string" && id.length > 0 ? ` [task ${id}]` : "";
}

export interface EventLogRule {
  level: LogLevel;
  category: LogCategory;
  formatMessage: (event: AgentEvent) => string;
}

/**
 * Marker for an event whose rows are written by a dedicated handler
 * (`event-log-specialized.ts`) rather than by a `formatMessage` rule.
 *
 * Distinct from `false`: `false` means "this event is never logged", while this means "logged, but
 * the generic one-row formatter does not apply". Those seven rows used to be `false`, which was
 * never read — the bridge dispatched to its own `switch` first — so they documented the opposite of
 * the behavior.
 */
export const SPECIALIZED_EVENT_LOG = "specialized" as const;

/** A table cell: a generic rule, a dedicated-handler marker, or an explicit suppression. */
export type EventLogRuleEntry = EventLogRule | typeof SPECIALIZED_EVENT_LOG | false;

/**
 * Human wording for a stopped subagent, keyed by why it stopped.
 *
 * A cancel is not a failure (`subagent:error` is reused for it), and the three ways a
 * run can stop are not the same event: the user cancelled it, the parent's run was
 * discarded, or the parent agent stopped. The log used to print the user-cancel wording
 * for all three, which is how a discarded run's orphan came to be recorded as something
 * the operator never did.
 */
const SUBAGENT_STOP_WORDING: Record<SubagentStopReason, string> = {
  user: "Subagent cancelled",
  "parent-run": "Subagent stopped (parent run moved on)",
  "parent-stop": "Subagent stopped (parent agent stopped)",
  unknown: "Subagent aborted (no reason recorded)",
};

/**
 * Telemetry-only mapping. Typed against the payload map so every telemetry
 * event still requires an entry (compile-checked) while session-projection
 * events (e.g. `agent:state`) stay out of the log stream.
 */
const TELEMETRY_EVENT_LOG_RULES: Record<keyof AgentEventPayloadMap, EventLogRuleEntry> = {
  // ============================================================================
  // Session lifecycle
  // ============================================================================
  "session:start": {
    level: "info",
    category: "system",
    formatMessage: (event) => `Session started (cwd: ${p(event).cwd ?? "unknown"})`,
  },
  // A mid-process switch to a brand-new on-disk session (`session.new` / `/new`). Distinct from
  // `session:start`, which announces that *a* session started (process bootstrap, or one created by
  // the host); without this entry the new log dir gets no header at all, because the new id is only
  // written on first save — after which `/new` may leave the process before any persist.
  "session:new": {
    level: "info",
    category: "system",
    formatMessage: (event) => `Session started (new)${p(event).sessionId ? `: ${p(event).sessionId}` : ""}`,
  },
  "session:doc": {
    level: "info",
    category: "system",
    formatMessage: (event) => (p(event).message as string) ?? "Agent documentation loaded",
  },
  "session:skill": {
    level: "debug",
    category: "skill",
    formatMessage: (event) => `Loaded ${p(event).count ?? 0} skills`,
  },
  "session:mcp": SPECIALIZED_EVENT_LOG,
  "session:memory": {
    level: "info",
    category: "memory",
    formatMessage: (event) => {
      const memoryCount = p(event).memoryCount;
      const count = typeof memoryCount === "number" ? memoryCount : 0;
      return count > 0 ? `Memory initialized (${count} memories)` : "Memory initialized (empty)";
    },
  },
  "session:restore": {
    level: "info",
    category: "system",
    formatMessage: (event) => {
      const d = p(event);
      const missing =
        typeof d.mediaMissing === "number" && d.mediaMissing > 0 ? `, ${d.mediaMissing} media missing` : "";
      return `Session restored: ${d.messageCount ?? "?"} messages, ${d.tokenEstimate ?? "?"} tokens${missing}`;
    },
  },
  // The departure record, written to the session being left. Paired with `session:restore`, which
  // announces the arrival — without both, a log answers "was this session resumed from?" only by
  // inference, and "was another session resumed from it?" not at all.
  "session:switch": {
    level: "info",
    category: "system",
    formatMessage: (event) => {
      const d = p(event);
      const from = d.fromSessionId ?? "unknown";
      const count = typeof d.messageCount === "number" ? ` (${d.messageCount} messages)` : "";
      const to = d.toSessionId ? ` → ${d.toSessionId}` : "";
      return `Session switched: leaving ${from}${count}${to}`;
    },
  },
  "session:save-error": {
    level: "warn",
    category: "system",
    formatMessage: (event) => `Failed to save session ${p(event).target ?? "data"}: ${p(event).error ?? "unknown"}`,
  },

  // ============================================================================
  // Turn lifecycle
  // ============================================================================
  "prompt:submit": {
    level: "info",
    category: "chat",
    formatMessage: (event) => {
      const prompt = p(event).prompt as string | undefined;
      const preview = prompt ? truncateText(prompt, 80) : "";
      const msgCount = p(event).contextMessageCount ?? "?";
      return `Prompt: ${preview}  (${msgCount} context messages)`;
    },
  },
  "prompt:before": {
    level: "debug",
    category: "chat",
    formatMessage: (event) => {
      const hasTurn = p(event).hasTurnContext ? "turn+ctx" : "no-turn-ctx";
      return `Extension prompt hooks (${hasTurn})`;
    },
  },
  "turn:summary": {
    level: "info",
    category: "chat",
    formatMessage: (event) => {
      const d = p(event);
      const outcome = d.outcome ? ` (${d.outcome})` : "";
      const phases = d.phases ?? "?";
      const toolCalls = d.toolCalls ?? "?";
      const inTokens = d.inputTokens ?? "?";
      const outTokens = d.outputTokens ?? "?";
      const cost = typeof d.costUsd === "number" && d.costUsd > 0 ? `, $${d.costUsd.toFixed(4)}` : "";
      const ms = d.durationMs ?? "?";
      return `Turn complete${outcome}: ${phases} phases, ${toolCalls} tools, ${inTokens}→${outTokens} tokens${cost}, ${ms}ms`;
    },
  },
  "agent:thinking": {
    level: "debug",
    category: "agent",
    formatMessage: () => "Model reasoning started",
  },
  "agent:stop": {
    level: "info",
    category: "agent",
    formatMessage: (event) => `Agent stop (${p(event).reason ?? "unknown"})`,
  },
  "agent:extension-error": {
    level: "error",
    category: "system",
    formatMessage: (event) =>
      `Extension ${p(event).phase ?? ""} failed "${p(event).extensionId ?? event.agentId}": ${p(event).error ?? "unknown"}`.trim(),
  },
  "agent:abort": {
    level: "warn",
    category: "agent",
    formatMessage: (event) => `Agent aborted (${p(event).reason ?? "unknown"})`,
  },
  "agent:retry": {
    level: "warn",
    category: "llm",
    formatMessage: (event) => {
      const d = p(event);
      const head = `Retry ${d.attempt ?? "?"}/${d.maxAttempts ?? "?"} (${d.strategy ?? "unknown"})`;
      const wait = typeof d.delayMs === "number" ? ` in ${Math.round(d.delayMs / 1000)}s` : "";
      const err = d.error ? `: ${String(d.error).slice(0, 120)}` : "";
      return `${head}${wait}${err}`;
    },
  },
  "agent:stream-error": {
    level: "error",
    category: "agent",
    formatMessage: (event) => `Stream error: ${p(event).error ?? "unknown"}`,
  },

  // ============================================================================
  // LLM calls
  // ============================================================================
  "llm:request": {
    level: "debug",
    category: "llm",
    formatMessage: (event) => {
      const d = p(event);
      const iter = d.iteration != null ? ` [iter ${d.iteration}]` : "";
      return `LLM request: ${d.model ?? "?"}${iter} (${d.messagesCount ?? "?"} msgs, ${d.toolsCount ?? 0} tools)`;
    },
  },
  "llm:response": {
    level: "info",
    category: "llm",
    formatMessage: (event) => {
      const d = p(event);
      const fr = d.finishReason ?? "?";
      const iter = d.iteration != null ? ` [iter ${d.iteration}]` : "";
      const inT = d.inputTokens ?? "?";
      const outT = d.outputTokens ?? "?";
      const cache = d.cacheReadTokens ? ` (cache +${d.cacheReadTokens})` : "";
      const reasoning = d.reasoningTokens ? ` (reasoning ${d.reasoningTokens})` : "";
      const cost = typeof d.costUsd === "number" && d.costUsd > 0 ? ` $${d.costUsd.toFixed(4)}` : "";
      const firstToken = typeof d.firstTokenMs === "number" ? `, first token ${d.firstTokenMs}ms` : "";
      const round = typeof d.roundElapsedMs === "number" ? `, round ${d.roundElapsedMs}ms` : "";
      const ms = d.durationMs ?? "?";
      return `LLM response: ${fr}${iter}  ${inT}→${outT} tokens${cache}${reasoning}${cost}  ${ms}ms${firstToken}${round}`;
    },
  },

  // ============================================================================
  // Tools
  // ============================================================================
  "agent:tool-start": {
    level: "debug",
    category: "tool",
    // An eager pre-fork start is labelled: the same call id is started again by the tool
    // phase whenever the eager run was discarded, and two identical lines is what let a
    // discarded subagent hide in plain sight.
    formatMessage: (event) =>
      p(event).source === "prefork"
        ? `Tool start: ${p(event).tool_name ?? "unknown"} (pre-fork)`
        : `Tool start: ${p(event).tool_name ?? "unknown"}`,
  },
  "agent:tool-approval-request": {
    level: "info",
    category: "approval",
    formatMessage: (event) => `Approval requested: ${p(event).tool_name ?? "unknown"}`,
  },
  "agent:tool-approval-resolved": {
    level: "info",
    category: "approval",
    formatMessage: (event) => {
      const d = p(event);
      const reason = d.reason ? ` — ${d.reason}` : "";
      return `Approval resolved: ${d.tool_name ?? d.tool_call_id ?? "unknown"} (${d.decision ?? "?"})${reason}`;
    },
  },
  "agent:tool-end": {
    level: "debug",
    category: "tool",
    // A tool that caught its own abort returns normally, so its `tool-end` carries the
    // cancel verdict. Worded as a cancel for the same reason `agent:tool-error` is:
    // otherwise a user-stopped call is indistinguishable from a clean success here.
    formatMessage: (event) => {
      const name = p(event).tool_name ?? "unknown";
      const duration = p(event).duration_ms;
      const suffix = duration != null ? ` (${duration}ms)` : "";
      return p(event).cancelled === true ? `Tool cancelled: ${name}${suffix}` : `Tool end: ${name}${suffix}`;
    },
  },
  "agent:tool-error": {
    // A user abort arrives here as a failed tool call, so the message is worded as a cancel
    // when the payload says so — the level stays `warn` because `EventLogRule.level` is
    // static per event type, and a cancel is still worth seeing next to the real faults in
    // the log. What matters is that the line does not read as a tool fault.
    level: "warn",
    category: "tool",
    formatMessage: (event) =>
      p(event).cancelled === true
        ? `Tool cancelled: ${p(event).tool_name ?? "unknown"} — ${p(event).error ?? "unknown"}`
        : `Tool error: ${p(event).tool_name ?? "unknown"} — ${p(event).error ?? "unknown"}`,
  },

  // ============================================================================
  // Turn / message boundaries — observable, never default-logged (2-4 rows per turn would dominate
  // the timeline; a consumer that wants them persists them under its own scope).
  // ============================================================================
  "turn:start": false,
  "turn:end": false,
  "message:start": false,
  "message:end": false,

  // ============================================================================
  // Memory
  // ============================================================================
  "memory:prefetch": SPECIALIZED_EVENT_LOG,
  "memory:extract": SPECIALIZED_EVENT_LOG,
  "memory:consolidate": SPECIALIZED_EVENT_LOG,

  // ============================================================================
  // Compaction
  // ============================================================================
  "compaction:auto-start": SPECIALIZED_EVENT_LOG,
  "compaction:auto-complete": SPECIALIZED_EVENT_LOG,
  "compaction:auto-error": SPECIALIZED_EVENT_LOG,
  "compaction:reactive-start": {
    level: "info",
    category: "compaction",
    formatMessage: (event) =>
      `Reactive compact triggered (retry ${p(event).retry ?? "?"}/${p(event).maxRetries ?? "?"})`,
  },
  "compaction:reactive-complete": {
    level: "info",
    category: "compaction",
    formatMessage: (event) =>
      `Reactive compact: ${p(event).originalCount ?? "?"}→${p(event).compactedCount ?? "?"} messages, ` +
      `${p(event).tokensBefore ?? "?"}→${p(event).tokensAfter ?? "?"} tokens`,
  },
  "compaction:reactive-error": {
    level: "error",
    category: "compaction",
    formatMessage: (event) => `Reactive compact failed: ${p(event).error ?? "unknown"}`,
  },
  "compaction:reactive-max-retries": {
    level: "error",
    category: "compaction",
    formatMessage: () => "Reactive compact: max retries exceeded, giving up",
  },

  // ============================================================================
  // Subagents
  // ============================================================================
  "subagent:created": {
    level: "info",
    category: "system",
    formatMessage: (event) => `Subagent created: ${p(event).subagentId ?? event.agentId}${taskBindingSuffix(p(event))}`,
  },
  "subagent:started": {
    level: "info",
    category: "system",
    formatMessage: (event) =>
      `Subagent started: ${p(event).description ?? event.agentId}${taskBindingSuffix(p(event))}`,
  },
  /**
   * Not logged: the queue is UI state, re-published on every admission and discard, so a line per
   * emission would flood the timeline with a fact the task rows already show. `false` is the
   * "no log line" marker this table uses.
   */
  "subagent:queue": false,
  /** An eagerly started `task` run was thrown away — the line that names an orphan. */
  "subagent:prefork-discarded": {
    level: "warn",
    category: "system",
    formatMessage: (event) => {
      const ids = p(event).subagentIds;
      const spawned =
        Array.isArray(ids) && ids.length > 0 ? ` — aborted ${ids.join(", ")}` : " — no subagent spawned yet";
      return `Pre-fork discarded (${p(event).cause ?? "unknown"}): tool call ${p(event).toolCallId ?? "?"}${spawned}`;
    },
  },
  "subagent:completed": {
    level: "info",
    category: "system",
    // The summary is model-written and `task` runs with `SUBAGENT_NO_TRUNCATE`, so an inline copy is
    // an unbounded JSONL line. Truncated here, same as the payload previews.
    formatMessage: (event) => {
      const summary =
        typeof p(event).summary === "string" ? truncateText(p(event).summary as string, 200) : "(no summary)";
      return `Subagent completed: ${summary}${taskBindingSuffix(p(event))}`;
    },
  },
  "subagent:error": {
    level: "error",
    category: "system",
    // A cancelled subagent reuses this event, but the payload is then the partial
    // narration rather than a fault — worded as a cancel so the log does not read as
    // a failure with a whole paragraph of prose as its error. The level stays `error`
    // because `EventLogRule.level` is static per event type, matching how
    // `agent:tool-error` handles the same two-way payload.
    formatMessage: (event) =>
      p(event).cancelled === true
        ? `${SUBAGENT_STOP_WORDING[(p(event).stopReason as SubagentStopReason) ?? "unknown"]}: ${
            p(event).subagentId ?? event.agentId
          }${taskBindingSuffix(p(event))}`
        : `Subagent error: ${p(event).error ?? "unknown"}${taskBindingSuffix(p(event))}`,
  },
  "subagent:progress-summary-error": {
    level: "warn",
    category: "system",
    formatMessage: (event) =>
      `Progress summary failed for subagent ${p(event).subagentId ?? event.agentId}: ${p(event).error ?? "unknown"}`,
  },
  "subagent:destroyed": {
    level: "info",
    category: "system",
    formatMessage: (event) =>
      `Subagent destroyed: ${p(event).subagentId ?? event.agentId}${taskBindingSuffix(p(event))}`,
  },
  "subagent:phase": {
    level: "debug",
    category: "agent",
    formatMessage: (event) => `Subagent phase → ${p(event).phase ?? "?"}`,
  },

  // ============================================================================
  // Plan mode
  // ============================================================================
  "plan:enter": {
    level: "info",
    category: "agent",
    formatMessage: () => "Plan mode: planning (read-only)",
  },
  "plan:ready": {
    level: "info",
    category: "agent",
    formatMessage: (event) => `Plan ready (${p(event).stepCount ?? "?"} steps) — /mode execute to run`,
  },
  "plan:execute": {
    level: "info",
    category: "agent",
    formatMessage: (event) => {
      const steps = p(event).stepCount ?? "?";
      const replaced = p(event).replacedExistingTodos ? " (replaced existing todos)" : "";
      return `Plan execution started (${steps} steps)${replaced}`;
    },
  },
  "plan:cancel-execution": {
    level: "info",
    category: "agent",
    formatMessage: () => "Plan execution paused — back to ready (read-only)",
  },
  "plan:todo-replaced": {
    level: "info",
    category: "agent",
    formatMessage: (event) => `Plan todos replaced previous list (${p(event).stepCount ?? "?"} steps)`,
  },
  "plan:retro": {
    level: "info",
    category: "agent",
    formatMessage: () => "Plan retrospective — review against the plan, then complete_plan or /mode done",
  },
  "plan:complete": {
    level: "info",
    category: "agent",
    formatMessage: () => "Plan complete — plan mode off",
  },
  "plan:exit": {
    level: "info",
    category: "agent",
    formatMessage: () => "Plan mode off",
  },
};

/** Default event → log rule lookup (session-projection events are intentionally absent). */
export const DEFAULT_EVENT_LOG_RULES: Partial<Record<AgentEventType, EventLogRuleEntry>> = TELEMETRY_EVENT_LOG_RULES;
