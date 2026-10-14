/**
 * Shared session/agent payload types.
 *
 * These live under `runtime-types/` so domain modules (`src/agent/**`) can
 * reference them without importing `managers/**`. Manager modules re-export
 * them to preserve their existing public surface.
 */

import type { AgentRetryState } from "./agent-retry.js";
import type { AgentStatus } from "./agent-status.js";
import type { TokenUsage } from "./token-usage.js";
import type { ModelInfo, ReasoningEffort } from "../models/types.js";
import type { ContentPart } from "@tanstack/ai";

/** Active agent mode — mutually exclusive modes for the agent. */
export type AgentMode = "normal" | "auto" | "plan";

/** L1 runtime status surface projected to AgentSession `state` channel. */
export interface AgentL1State {
  status: AgentStatus;
  /** Agent display name (lets remote clients track renames via the state channel). */
  name: string;
  /**
   * Active on-disk session id, or null before one is allocated. Distinct from the
   * agent id: `session.resume` / `session.new` swap the disk session while the agent
   * keeps its identity, so this is the only way subscribers observe the switch.
   */
  sessionId: string | null;
  error: string;
  pendingApprovalCount: number;
  /** Present while a recoverable LLM failure is being retried (cleared once the stream recovers). */
  retry?: AgentRetryState | null;
  /** Active model id (informational; lets remote clients track model switches via the state channel). */
  model: string;
  /** Model metadata (incl. `reasoningConfig` / effort options) for UI display. */
  modelInfo: ModelInfo | null;
  /** Current reasoning-effort level (null = model default). */
  reasoningEffort: ReasoningEffort | null;
}

/**
 * Agent-loop progress for the current run. One iteration = one model turn
 * (TanStack middleware `onIteration`, 0-based on the wire → 1-based here).
 */
export interface AgentIterationState {
  /** 1-based model-iteration index within the current run; 0 when idle / not started. */
  current: number;
  /** Configured max iterations (agent-loop budget) for the run; 0 when unknown. */
  max: number;
}

/**
 * A tool call paused for the user's approval decision.
 * Part of {@link SessionInteractionsSnapshot}.
 */
export interface PendingApprovalInteraction {
  approvalId: string;
  toolName: string;
  toolCallId: string;
}

/** A `ask_user` call awaiting the user's answer. Part of {@link SessionInteractionsSnapshot}. */
export interface PendingAskUserInteraction {
  toolCallId: string;
  question: string;
  options?: string[];
  multiSelect?: boolean;
}

/**
 * Pending user interactions derived from the conversation, projected onto the
 * retained `interaction` channel so hosts no longer each re-scan messages to
 * discover approvals / `ask_user` requests.
 */
export interface SessionInteractionsSnapshot {
  approvals: PendingApprovalInteraction[];
  askUser: PendingAskUserInteraction[];
}

/**
 * A background command job, as seen by a status surface.
 *
 * Deliberately summary-only (no output): the snapshot is projected onto the retained
 * `jobs` channel, so it crosses process boundaries and is replayed to late subscribers.
 * Output stays reachable via `get_command_output` / the job's log file.
 */
export interface SessionJobSummary {
  jobId: string;
  command: string;
  status: "running" | "exited" | "killed" | "failed";
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
}

/** Background jobs started by this agent (mirrors the retained `jobs` channel). */
export interface SessionJobsSnapshot {
  jobs: SessionJobSummary[];
}

/** Content accepted by the steer / follow-up queues. */
export type QueuedMessageContent = string | ContentPart[];

export interface QueuedMessagesSnapshot {
  steer: QueuedMessageContent[];
  followUp: QueuedMessageContent[];
}

/** Payload-carrying usage view for Emitter / AgentSession `usage` channel. */
export interface UsageChangeSnapshot {
  total: TokenUsage;
  window: TokenUsage;
  percent: number;
  /**
   * True context-window fill in tokens (uncached + cached prompt).
   *
   * `window.inputTokens` alone is not the fill: an exclusive upstream (Anthropic/DeepSeek
   * native) reports only the cache-miss part there, while an inclusive one (OpenAI, gateways)
   * reports the whole prompt. Hosts that render "how full is the window" must use this,
   * never `window.inputTokens` — see `UsageTracker.getContextFillTokens()`.
   */
  contextFillTokens: number;
  /**
   * Billed prompt tokens across the session lifetime — the denominator for cache share.
   *
   * Not `total.inputTokens`, which under an exclusive upstream (Anthropic/DeepSeek native)
   * holds only the cache-miss part, so `cacheRead / inputTokens` reads as >100% (observed
   * at 428.5%). See `UsageTracker.getBilledInputTokens()`.
   */
  billedInputTokens: number;
  tokenLimit: number;
  cost: number;
  /** Cumulative wall-clock time of measured main-loop LLM calls (ms). */
  llmDurationMs: number;
  /** Output tokens generated by the measured main-loop LLM calls (basis for tok/s). */
  llmOutputTokens: number;
}
