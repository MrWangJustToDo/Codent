/**
 * Default event → AgentLog mapping for {@link bridgeTelemetryToAgentLog}.
 */

import { truncateText } from "../../utils/text-truncation.js";

import { readEventPayload as p } from "./payload.js";

import type { AgentEventPayloadMap } from "../../runtime-types/agent-event-payloads.js";
import type { AgentEvent, AgentEventType } from "../agent-event-bus";
import type { LogCategory, LogLevel } from "../agent-log/types.js";
import type { SubagentStopReason } from "../subagent/subagent-stop-reason.js";

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
  /**
   * Conditional suppression for THIS event instance.
   *
   * A table cell is static per event type; some facts are only worth a row in one variant. The
   * canonical case is an approval the agent answered itself: in auto/plan-execution mode nobody was
   * asked, so the request/resolve pair is machinery (the `agent:tool-*` rows already carry the call)
   * and recording it made 22% of a real session's log. The predicate lives with the rule — NOT at
   * the emit site — because an emitter must always emit and the policy decides what is recorded.
   */
  suppress?: (event: AgentEvent) => boolean;
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
  "session:diagnostic": SPECIALIZED_EVENT_LOG,
  "session:bootstrap-summary": {
    level: "info",
    category: "system",
    formatMessage: (event) => {
      const d = p(event);
      const failed = typeof d.failed === "number" && d.failed > 0 ? `, ${d.failed} failed` : "";
      return `Bootstrap complete: ${d.active ?? 0}/${d.attempted ?? 0} extensions active${failed}`;
    },
  },
  "session:deleted": {
    level: "info",
    category: "system",
    formatMessage: (event) => `Session deleted${p(event).sessionId ? `: ${p(event).sessionId}` : ""}`,
  },
  "session:title": SPECIALIZED_EVENT_LOG,
  "session:reset": {
    level: "info",
    category: "agent",
    formatMessage: (event) => {
      const d = p(event);
      return `Session reset (${d.reason ?? "unknown"})${d.previousStatus ? ` from ${d.previousStatus}` : ""}`;
    },
  },

  // ============================================================================
  // Turn lifecycle
  // ============================================================================
  "model:change": {
    level: "info",
    category: "agent",
    formatMessage: (event) => {
      const d = p(event);
      const style = d.style ? ` (${d.style})` : "";
      const fallback = d.fallback === true ? " — requested model unavailable, kept the previous one" : "";
      return `Model: ${d.from ?? "?"} → ${d.to ?? "?"}${style}${fallback}`;
    },
  },
  // `session:mode` is a projection (suppressed by policy); this is its append-only counterpart.
  // Without the row, a run of approvals that never asked a human reads exactly like one that did.
  "mode:change": {
    level: "info",
    category: "agent",
    formatMessage: (event) => {
      const d = p(event);
      if (d.field === "effort") {
        return `Reasoning effort: ${typeof d.reasoningEffort === "string" ? d.reasoningEffort : "default"}`;
      }
      return d.auto === true ? "Auto mode on" : "Auto mode off";
    },
  },
  "prompt:submit": {
    level: "info",
    category: "chat",
    formatMessage: (event) => {
      const prompt = p(event).prompt as string | undefined;
      const preview = prompt ? truncateText(prompt, 80) : "";
      const msgCount = p(event).contextMessageCount ?? "?";
      // A released steer/follow-up is a prompt too, but it did not start the turn — say so.
      const queued = p(event).source === "queued" ? " (queued)" : "";
      return `Prompt${queued}: ${preview}  (${msgCount} context messages)`;
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
  "side-query:mode": {
    level: "debug",
    category: "side-query",
    formatMessage: (event) => {
      const d = p(event);
      // A MODE DECISION, not a completed query: the request has not been issued yet. The old name
      // (`side-query:mode`) claimed a completion, so a decision followed by a failure read as
      // "completed" then "failed".
      return `Side query (${d.purpose ?? "?"}) using ${d.mode ?? "?"} mode: ${d.reason ?? "decided"}`;
    },
  },
  "side-query:error": {
    level: "warn",
    category: "side-query",
    formatMessage: (event) => {
      const d = p(event);
      return `Side query (${d.purpose ?? "?"}) failed in ${d.mode ?? "?"} mode: ${d.error ?? "unknown"}`;
    },
  },
  "turn:summary": {
    level: "info",
    category: "chat",
    formatMessage: (event) => {
      const d = p(event);
      // A parked turn is not a finished one: "Turn complete" on an approval wait is how the
      // majority-paused summaries ended up describing turns that had not ended.
      const headline =
        d.paused === true ? "Turn paused (waiting for input)" : `Turn complete${d.outcome ? ` (${d.outcome})` : ""}`;
      const phases = d.phases ?? "?";
      const toolCalls = d.toolCalls ?? "?";
      const inTokens = d.inputTokens ?? "?";
      const outTokens = d.outputTokens ?? "?";
      const cost = typeof d.costUsd === "number" && d.costUsd > 0 ? `, $${d.costUsd.toFixed(4)}` : "";
      const ms = d.durationMs ?? "?";
      return `${headline}: ${phases} phases, ${toolCalls} tools, ${inTokens}→${outTokens} tokens${cost}, ${ms}ms`;
    },
  },
  "agent:thinking": {
    level: "debug",
    category: "agent",
    formatMessage: (event) => {
      const d = p(event);
      const iter = d.iteration != null ? ` [iter ${d.iteration}]` : "";
      const model = typeof d.model === "string" ? ` ${d.model}` : "";
      return `Model reasoning started${iter}${model}`;
    },
  },
  "agent:stop": {
    level: "info",
    category: "agent",
    formatMessage: (event) => `Agent stop (${p(event).reason ?? "unknown"})`,
  },
  "agent:status": SPECIALIZED_EVENT_LOG,
  "extension:log": SPECIALIZED_EVENT_LOG,
  "hooks:echo": SPECIALIZED_EVENT_LOG,
  "agent:extension-error": {
    level: "error",
    category: "system",
    formatMessage: (event) => {
      const d = p(event);
      // The id is absent for a file that failed to import or a factory that threw before it had one;
      // printing a sentinel there ("disk"/"config") named an extension that does not exist.
      const phase = d.phase ? `${d.phase} ` : "";
      const id = typeof d.extensionId === "string" && d.extensionId ? ` "${d.extensionId}"` : "";
      return `Extension ${phase}failed${id}: ${d.error ?? "unknown"}`;
    },
  },
  "agent:event-handler-error": {
    level: "warn",
    category: "hooks",
    formatMessage: (event) => {
      const d = p(event);
      const what =
        d.kind === "observer" ? "event observer threw; frame dropped" : "interceptor threw; continuing without it";
      return `${what}: ${d.pattern ?? "*"} (${d.event ?? "?"})`;
    },
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
      const calls = typeof d.iterations === "number" && d.iterations > 1 ? ` (${d.iterations} model calls)` : "";
      const ms = d.durationMs ?? "?";
      return `LLM response: ${fr}${iter}${calls}  ${inT}→${outT} tokens${cache}${reasoning}${cost}  ${ms}ms${firstToken}${round}`;
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
    // Auto/plan execution answers this in the same tick: nobody is asked, and `agent:tool-start`
    // still records the call. Keeping the pair made 1,330 of one real session's 6,034 lines.
    //
    // The request suppresses on `auto` (what the pump knew when it asked) while the resolution
    // suppresses on `source` (what actually decided). A mode toggle between the two can therefore
    // leave one row without its twin; matching on `source` here is impossible without buffering the
    // request until the decision arrives, and `mode:change` is the row that explains the window.
    suppress: (event) => p(event).auto === true,
    formatMessage: (event) => `Approval requested: ${p(event).tool_name ?? "unknown"}`,
  },
  "agent:tool-approval-resolved": {
    level: "info",
    category: "approval",
    // Same fact as the request row above — suppressed by the decision's source, which the request
    // could not know. A human answer and a command-safety verdict keep their rows.
    suppress: (event) => p(event).source === "auto",
    formatMessage: (event) => {
      const d = p(event);
      const by = d.source === "policy" ? ", by policy" : "";
      const reason = d.reason ? ` — ${d.reason}` : "";
      return `Approval resolved: ${d.tool_name ?? d.tool_call_id ?? "unknown"} (${d.decision ?? "?"}${by})${reason}`;
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
  "agent:client-tool-result": {
    level: "info",
    category: "tool",
    formatMessage: (event) => {
      const d = p(event);
      const output = d.output as { answer?: unknown; cancelled?: unknown } | undefined;
      const answer = typeof output?.answer === "string" ? output.answer : "";
      const suffix = answer ? ` — ${truncateText(answer, 120)}` : output?.cancelled === true ? " — cancelled" : "";
      return `Client tool result: ${d.tool_name ?? d.tool_call_id ?? "unknown"}${suffix}`;
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
  "tool:projection-error": {
    level: "warn",
    category: "tool",
    formatMessage: (event) =>
      `Tool output projection failed (${p(event).tool_name ?? "unknown"}): ${p(event).error ?? "unknown"}`,
  },
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
  "compaction:manual-start": SPECIALIZED_EVENT_LOG,
  "compaction:manual-complete": SPECIALIZED_EVENT_LOG,
  "compaction:manual-error": SPECIALIZED_EVENT_LOG,
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
  "compaction:cache-cleanup-error": {
    level: "warn",
    category: "compaction",
    formatMessage: (event) => `Post-compact cache cleanup failed: ${p(event).error ?? "unknown"}`,
  },
  "job:changed": SPECIALIZED_EVENT_LOG,
  "run:wake": {
    level: "debug",
    category: "agent",
    formatMessage: (event) => `Wake turn (${p(event).cause ?? "unknown"})`,
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
      // The child's own cost, because the parent's `llm:response` rows cover only the parent's calls
      // (a worker runs its whole loop in ONE `chat()`), so this is the only row where a delegated
      // run's billing is visible.
      const cost = typeof p(event).costUsd === "number" ? ` $${(p(event).costUsd as number).toFixed(4)}` : "";
      return `Subagent completed: ${summary}${cost}${taskBindingSuffix(p(event))}`;
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

/**
 * Session-projection events: snapshots of state a host reads from a session channel.
 *
 * They are the second half of the registry (`AgentEvents` minus the telemetry map), and they must be
 * decisions rather than omissions: a snapshot re-publishes on every change, so recording one is the
 * fastest way to make the timeline unreadable. Typed as an exhaustive `false` map so a new projection
 * event cannot land without the author stating it.
 */
export const PROJECTION_EVENT_LOG_RULES: Record<Exclude<AgentEventType, keyof AgentEventPayloadMap>, false> = {
  "agent:state": false,
  "session:messages": false,
  "session:queues": false,
  "session:usage": false,
  "session:todos": false,
  "session:plan": false,
  "session:summary": false,
  "session:mode": false,
  "session:extensions": false,
  "session:tool-presentation": false,
  "session:interaction": false,
  "agent:iteration": false,
  "session:jobs": false,
  "session:subagents": false,
  "extension:ui": false,
  "tool:chunk": false,
  "tool:clear": false,
};

/** Default event → log rule lookup (projection events are explicit suppressions). */
export const DEFAULT_EVENT_LOG_RULES: Partial<Record<AgentEventType, EventLogRuleEntry>> = {
  ...TELEMETRY_EVENT_LOG_RULES,
  ...PROJECTION_EVENT_LOG_RULES,
};
