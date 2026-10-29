/**
 * Runtime metadata for {@link AgentEvents}.
 *
 * The `AgentSession` channel projection derives routing from this table instead
 * of hand-maintained per-channel wiring or a lifecycle include-list. Every
 * observer event MUST have an entry (completeness is compile-checked).
 */

import type { AgentEventMetaTable } from "./types.js";

export const AGENT_EVENT_META = {
  // ==========================================================================
  // Session lifecycle
  // ==========================================================================
  "session:start": { mode: "emit", visibility: "observable" },
  "session:new": { mode: "emit", visibility: "observable" },
  "session:doc": { mode: "emit", visibility: "observable" },
  "session:skill": { mode: "emit", visibility: "observable" },
  "session:mcp": { mode: "emit", channel: "mcp", retained: true, visibility: "observable" },
  "session:memory": { mode: "emit", visibility: "observable" },
  "session:restore": { mode: "emit", visibility: "observable" },
  "session:switch": { mode: "emit", visibility: "observable" },
  "session:save-error": { mode: "emit", channel: "lifecycle", visibility: "observable" },
  // Bootstrap diagnostics: recorded by the policy table, not published on a session channel (the
  // pre-registration window has no subscriber yet, and hosts do not render them).
  "session:diagnostic": { mode: "emit", visibility: "observable" },
  "session:bootstrap-summary": { mode: "emit", visibility: "observable" },
  "session:title": { mode: "emit", visibility: "observable" },
  "session:deleted": { mode: "emit", visibility: "observable" },
  "session:reset": { mode: "emit", visibility: "observable" },

  // ==========================================================================
  // Turn lifecycle
  // ==========================================================================
  "prompt:submit": { mode: "emit", channel: "lifecycle", visibility: "observable" },
  "prompt:before": { mode: "emit", visibility: "observable" },
  "turn:summary": { mode: "emit", channel: "lifecycle", visibility: "observable" },
  "run:wake": { mode: "emit", visibility: "observable" },
  "job:changed": { mode: "emit", visibility: "observable" },

  // ==========================================================================
  // Agent lifecycle / tools / approvals
  // ==========================================================================
  "agent:thinking": { mode: "emit", channel: "lifecycle", visibility: "observable" },
  "agent:tool-start": { mode: "emit", channel: "lifecycle", visibility: "observable" },
  "agent:tool-approval-request": { mode: "emit", channel: "lifecycle", visibility: "observable" },
  "agent:tool-approval-resolved": { mode: "emit", channel: "lifecycle", visibility: "observable" },
  "agent:tool-end": { mode: "emit", channel: "lifecycle", visibility: "observable" },
  "agent:client-tool-result": { mode: "emit", channel: "lifecycle", visibility: "observable" },
  "agent:tool-error": { mode: "emit", channel: "lifecycle", visibility: "observable" },
  "tool:projection-error": { mode: "emit", visibility: "observable" },
  "agent:abort": { mode: "emit", channel: "lifecycle", visibility: "observable" },
  "agent:retry": { mode: "emit", channel: "lifecycle", visibility: "observable" },
  "agent:stream-error": { mode: "emit", channel: "lifecycle", visibility: "observable" },
  "agent:stop": { mode: "emit", channel: "lifecycle", visibility: "observable" },
  // Status transitions are their own event so the log policy (not `setStatus`) decides whether one
  // is recorded. `agent:state` stays the retained snapshot a host reads.
  "agent:status": { mode: "emit", visibility: "observable" },
  "agent:extension-error": { mode: "emit", channel: "lifecycle", visibility: "observable" },
  "agent:event-handler-error": { mode: "emit", visibility: "observable" },
  // `extension:log` is observable by construction: internal events are withheld from wildcard
  // delivery, and the log consumer IS the wildcard subscriber (see `event-visibility.ts`).
  "extension:log": { mode: "emit", visibility: "observable" },
  "hooks:echo": { mode: "emit", visibility: "observable" },
  "model:change": { mode: "emit", visibility: "observable" },
  "mode:change": { mode: "emit", visibility: "observable" },

  // ==========================================================================
  // Memory
  // ==========================================================================
  "memory:prefetch": { mode: "emit", visibility: "observable" },
  "memory:extract": { mode: "emit", visibility: "observable" },
  "memory:consolidate": { mode: "emit", visibility: "observable" },

  // ==========================================================================
  // LLM
  // ==========================================================================
  "llm:request": { mode: "emit", visibility: "observable" },
  "llm:response": { mode: "emit", visibility: "observable" },
  "side-query:mode": { mode: "emit", visibility: "observable" },
  "side-query:error": { mode: "emit", visibility: "observable" },

  // ==========================================================================
  // Compaction
  // ==========================================================================
  // Terminal compaction results carry the numbers / give-up state that status
  // transitions cannot express, so they project onto the lifecycle channel
  // (the `-start` events stay channel-less — status covers "compacting").
  "compaction:auto-start": { mode: "emit", visibility: "observable" },
  "compaction:auto-complete": { mode: "emit", channel: "lifecycle", visibility: "observable" },
  "compaction:auto-error": { mode: "emit", channel: "lifecycle", visibility: "observable" },
  // A manual `/compact` gets its own name rather than borrowing the auto one: the log line is how
  // the user tells "the loop compacted itself" from "I asked for this".
  "compaction:manual-start": { mode: "emit", visibility: "observable" },
  "compaction:manual-complete": { mode: "emit", channel: "lifecycle", visibility: "observable" },
  "compaction:manual-error": { mode: "emit", channel: "lifecycle", visibility: "observable" },
  "compaction:reactive-start": { mode: "emit", visibility: "observable" },
  "compaction:reactive-complete": { mode: "emit", channel: "lifecycle", visibility: "observable" },
  "compaction:reactive-error": { mode: "emit", channel: "lifecycle", visibility: "observable" },
  "compaction:reactive-max-retries": { mode: "emit", channel: "lifecycle", visibility: "observable" },
  "compaction:cache-cleanup-error": { mode: "emit", visibility: "observable" },

  // ==========================================================================
  // Subagents
  // ==========================================================================
  "subagent:created": { mode: "emit", channel: "lifecycle", visibility: "observable" },
  "subagent:queue": { mode: "emit", channel: "lifecycle", visibility: "observable" },
  "subagent:started": { mode: "emit", channel: "lifecycle", visibility: "observable" },
  "subagent:prefork-discarded": { mode: "emit", channel: "lifecycle", visibility: "observable" },
  "subagent:completed": { mode: "emit", channel: "lifecycle", visibility: "observable" },
  "subagent:error": { mode: "emit", channel: "lifecycle", visibility: "observable" },
  "subagent:destroyed": { mode: "emit", channel: "lifecycle", visibility: "observable" },
  "subagent:phase": { mode: "emit", channel: "lifecycle", visibility: "observable" },
  "subagent:progress-summary-error": { mode: "emit", channel: "lifecycle", visibility: "observable" },

  // ==========================================================================
  // Plan mode
  // ==========================================================================
  "plan:enter": { mode: "emit", visibility: "observable" },
  "plan:ready": { mode: "emit", visibility: "observable" },
  "plan:execute": { mode: "emit", visibility: "observable" },
  "plan:cancel-execution": { mode: "emit", visibility: "observable" },
  "plan:todo-replaced": { mode: "emit", visibility: "observable" },
  "plan:retro": { mode: "emit", visibility: "observable" },
  "plan:complete": { mode: "emit", visibility: "observable" },
  "plan:exit": { mode: "emit", visibility: "observable" },

  // ==========================================================================
  // Session channel projection (observer events feeding AgentSession channels)
  // ==========================================================================
  "agent:state": { mode: "emit", channel: "state", retained: true, visibility: "observable" },
  "session:messages": { mode: "emit", channel: "messages", retained: true, visibility: "observable" },
  "session:queues": { mode: "emit", channel: "queues", retained: true, visibility: "observable" },
  "session:usage": { mode: "emit", channel: "usage", retained: true, visibility: "observable" },
  "session:todos": { mode: "emit", channel: "todos", retained: true, visibility: "observable" },
  "session:plan": { mode: "emit", channel: "plan", retained: true, visibility: "observable" },
  "session:summary": { mode: "emit", channel: "summary", visibility: "observable" },
  "session:mode": { mode: "emit", channel: "mode", retained: true, visibility: "observable" },
  "session:extensions": { mode: "emit", channel: "extensions", retained: true, visibility: "observable" },
  "session:tool-presentation": { mode: "emit", channel: "tool-presentation", retained: true, visibility: "observable" },
  "session:interaction": { mode: "emit", channel: "interaction", retained: true, visibility: "observable" },
  "agent:iteration": { mode: "emit", channel: "iteration", retained: true, visibility: "observable" },
  // Turn/message boundaries: observable facts about a run, not session channels. Two to four per
  // turn, so they are deliberately not default-logged (see DEFAULT_EVENT_LOG_RULES).
  "turn:start": { mode: "emit", visibility: "observable" },
  "turn:end": { mode: "emit", visibility: "observable" },
  "message:start": { mode: "emit", visibility: "observable" },
  "message:end": { mode: "emit", visibility: "observable" },
  // Background command jobs. Retained so a late subscriber (the built-in jobs
  // extension at startup, or a reconnecting remote client) sees the current list
  // without waiting for the next transition. The per-job transitions are logged through
  // `job:changed`; this snapshot row itself stays out of the log table.
  "session:jobs": { mode: "emit", channel: "jobs", retained: true, visibility: "observable" },
  // Child-agent list. Retained for the same reason as `session:jobs`, and it is the
  // only channel that can add or drop a task row off-process — the `subagent:*`
  // lifecycle events carry one id each and are not a list.
  "session:subagents": { mode: "emit", channel: "subagents", retained: true, visibility: "observable" },
  "extension:ui": { mode: "emit", channel: "extension-ui", visibility: "internal" },
  "tool:chunk": { mode: "emit", channel: "tool", visibility: "internal" },
  "tool:clear": { mode: "emit", channel: "tool", visibility: "internal" },
} as const satisfies AgentEventMetaTable;
