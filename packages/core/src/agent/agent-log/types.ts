// ============================================================================
// Log Types
// ============================================================================

import type { ResolvedCoreEnv } from "../../env";
import type { AgentProfileId } from "../../runtime-types/agent-profile.js";

/** Log levels */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Log categories for filtering */
export type LogCategory =
  | "agent"
  | "chat"
  | "llm"
  | "tool"
  | "approval"
  | "compaction"
  | "todo"
  | "skill"
  | "memory"
  | "hooks"
  | "system"
  /**
   * Internal one-shot LLM calls that are not conversational turns — memory
   * selection, session titles, session summaries. Filed under their own
   * category rather than a caller's, because the same port serves several
   * subsystems and none of them owns it.
   */
  | "side-query";

/** Non-derivable attribution carried by every persisted entry. */
export interface LogScope {
  profile: AgentProfileId;
  /** The parent `task` tool call that owns this child, when applicable. */
  taskCallId?: string;
}

/** Log entry */
export interface LogEntry {
  /** Profile/task attribution; root session and agent identity come from the sink path. */
  scope: LogScope;
  /** Unique log ID */
  id: string;
  /** Timestamp (ms since epoch) */
  timestamp: number;
  /** Log level */
  level: LogLevel;
  /** Log category */
  category: LogCategory;
  /** Log message */
  message: string;
  /** Optional structured data */
  data?: Record<string, unknown>;
  /** Optional error */
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
  /** Optional tags for filtering */
  tags?: string[];
  /** Optional short run id — entries written during an agent run share one id. */
  run?: string;
  /**
   * Originating bus event type (e.g. `llm:request`) when the entry was derived
   * from a typed telemetry event via the Event→Log bridge. Direct log calls
   * (bootstrap summaries, status transitions) leave this unset.
   */
  event?: string;
}

/** Options for persisting AgentLog entries to a JSONL file. */
export interface AgentLogFileSinkOptions {
  /** Target directory (e.g. `.agents/logs/{sessionId}`). Created on first write. */
  dir: string;
  /** Log file name inside `dir` (default `agent.log`). */
  filename?: string;
  /** Rotate the file when it exceeds this many bytes (default 5 MiB). */
  maxBytes?: number;
  /** Keep at most this many rotated segments (default 5; includes the active file). */
  maxFiles?: number;
  /** Batch-flush interval in ms (default 250). */
  flushIntervalMs?: number;
  /** Owning runtime's env, so the log lands under the runtime root. Ambient when omitted. */
  env?: ResolvedCoreEnv;
}
