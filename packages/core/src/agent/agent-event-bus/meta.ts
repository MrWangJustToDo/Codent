/**
 * Runtime metadata for {@link AgentEvents}.
 *
 * The `AgentSession` channel projection derives routing from this table instead
 * of hand-maintained per-channel wiring or a lifecycle include-list. Every
 * observer event MUST have an entry (completeness is compile-checked).
 */

import type { AgentEventMeta, AgentEventMetaTable, AgentEventType } from "./types.js";

/** Interceptor event keys. `prefix:*` patterns match open-ended (tool) names. */
export const INTERCEPTOR_EVENT_PATTERNS = [
  "tool:before:*",
  "tool:after:*",
  "tool:error:*",
  "before_agent_start",
  "session:start",
  "session:shutdown",
] as const;

export type InterceptorEventPattern = (typeof INTERCEPTOR_EVENT_PATTERNS)[number];

export const AGENT_EVENT_META: Record<AgentEventType, AgentEventMeta> = {
  // ==========================================================================
  // Session lifecycle
  // ==========================================================================
  "session:start": { mode: "emit" },
  "session:new": { mode: "emit" },
  "session:doc": { mode: "emit" },
  "session:skill": { mode: "emit" },
  "session:mcp": { mode: "emit", channel: "mcp", retained: true },
  "session:memory": { mode: "emit" },
  "session:restore": { mode: "emit" },
  "session:switch": { mode: "emit" },
  "session:save-error": { mode: "emit", channel: "lifecycle" },

  // ==========================================================================
  // Turn lifecycle
  // ==========================================================================
  "prompt:submit": { mode: "emit", channel: "lifecycle" },
  "prompt:before": { mode: "emit" },
  "turn:summary": { mode: "emit", channel: "lifecycle" },

  // ==========================================================================
  // Agent lifecycle / tools / approvals
  // ==========================================================================
  "agent:thinking": { mode: "emit", channel: "lifecycle" },
  "agent:tool-start": { mode: "emit", channel: "lifecycle" },
  "agent:tool-approval-request": { mode: "emit", channel: "lifecycle" },
  "agent:tool-approval-resolved": { mode: "emit", channel: "lifecycle" },
  "agent:tool-end": { mode: "emit", channel: "lifecycle" },
  "agent:tool-error": { mode: "emit", channel: "lifecycle" },
  "agent:abort": { mode: "emit", channel: "lifecycle" },
  "agent:retry": { mode: "emit", channel: "lifecycle" },
  "agent:stream-error": { mode: "emit", channel: "lifecycle" },
  "agent:stop": { mode: "emit", channel: "lifecycle" },
  "agent:extension-error": { mode: "emit", channel: "lifecycle" },

  // ==========================================================================
  // Memory
  // ==========================================================================
  "memory:prefetch": { mode: "emit" },
  "memory:extract": { mode: "emit" },
  "memory:consolidate": { mode: "emit" },

  // ==========================================================================
  // LLM
  // ==========================================================================
  "llm:request": { mode: "emit" },
  "llm:response": { mode: "emit" },

  // ==========================================================================
  // Compaction
  // ==========================================================================
  // Terminal compaction results carry the numbers / give-up state that status
  // transitions cannot express, so they project onto the lifecycle channel
  // (the `-start` events stay channel-less — status covers "compacting").
  "compaction:auto-start": { mode: "emit" },
  "compaction:auto-complete": { mode: "emit", channel: "lifecycle" },
  "compaction:auto-error": { mode: "emit", channel: "lifecycle" },
  "compaction:reactive-start": { mode: "emit" },
  "compaction:reactive-complete": { mode: "emit", channel: "lifecycle" },
  "compaction:reactive-error": { mode: "emit", channel: "lifecycle" },
  "compaction:reactive-max-retries": { mode: "emit", channel: "lifecycle" },

  // ==========================================================================
  // Subagents
  // ==========================================================================
  "subagent:created": { mode: "emit", channel: "lifecycle" },
  "subagent:queue": { mode: "emit", channel: "lifecycle" },
  "subagent:started": { mode: "emit", channel: "lifecycle" },
  "subagent:prefork-discarded": { mode: "emit", channel: "lifecycle" },
  "subagent:completed": { mode: "emit", channel: "lifecycle" },
  "subagent:error": { mode: "emit", channel: "lifecycle" },
  "subagent:destroyed": { mode: "emit", channel: "lifecycle" },
  "subagent:phase": { mode: "emit", channel: "lifecycle" },
  "subagent:progress-summary-error": { mode: "emit", channel: "lifecycle" },

  // ==========================================================================
  // Plan mode
  // ==========================================================================
  "plan:enter": { mode: "emit" },
  "plan:ready": { mode: "emit" },
  "plan:execute": { mode: "emit" },
  "plan:cancel-execution": { mode: "emit" },
  "plan:todo-replaced": { mode: "emit" },
  "plan:retro": { mode: "emit" },
  "plan:complete": { mode: "emit" },
  "plan:exit": { mode: "emit" },

  // ==========================================================================
  // Session channel projection (observer events feeding AgentSession channels)
  // ==========================================================================
  "agent:state": { mode: "emit", channel: "state", retained: true },
  "session:messages": { mode: "emit", channel: "messages", retained: true },
  "session:queues": { mode: "emit", channel: "queues", retained: true },
  "session:usage": { mode: "emit", channel: "usage", retained: true },
  "session:todos": { mode: "emit", channel: "todos", retained: true },
  "session:plan": { mode: "emit", channel: "plan", retained: true },
  "session:summary": { mode: "emit", channel: "summary" },
  "session:mode": { mode: "emit", channel: "mode", retained: true },
  "session:extensions": { mode: "emit", channel: "extensions", retained: true },
  "session:tool-presentation": { mode: "emit", channel: "tool-presentation", retained: true },
  "session:interaction": { mode: "emit", channel: "interaction", retained: true },
  "agent:iteration": { mode: "emit", channel: "iteration", retained: true },
  // Turn/message boundaries: observable facts about a run, not session channels. Two to four per
  // turn, so they are deliberately not default-logged (see DEFAULT_EVENT_LOG_RULES).
  "turn:end": { mode: "emit" },
  "message:start": { mode: "emit" },
  "message:end": { mode: "emit" },
  // Background command jobs. Retained so a late subscriber (the built-in jobs
  // extension at startup, or a reconnecting remote client) sees the current list
  // without waiting for the next transition. Deliberately NOT in
  // DEFAULT_EVENT_LOG_RULES: a job start/stop is not worth a log line per event.
  "session:jobs": { mode: "emit", channel: "jobs", retained: true },
  // Child-agent list. Retained for the same reason as `session:jobs`, and it is the
  // only channel that can add or drop a task row off-process — the `subagent:*`
  // lifecycle events carry one id each and are not a list.
  "session:subagents": { mode: "emit", channel: "subagents", retained: true },
  "extension:ui": { mode: "emit", channel: "extension-ui" },
  "tool:chunk": { mode: "emit", channel: "tool" },
  "tool:clear": { mode: "emit", channel: "tool" },
} satisfies AgentEventMetaTable;
