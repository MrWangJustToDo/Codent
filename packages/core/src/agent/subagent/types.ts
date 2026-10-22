/**
 * Subagent types, interfaces, and constants.
 */

import type { SubagentStopReason } from "./subagent-stop-reason.js";
import type { AgentProfileId } from "../../runtime-types/agent-profile.js";
import type { AgentManager } from "../../runtime-types/hosts.js";
import type { ToolsRecord } from "../tools/catalog/tool-set.js";
import type { ModelMessage } from "@tanstack/ai";

// ============================================================================
// Constants
// ============================================================================

/**
 * Default maximum iterations for subagent loop.
 *
 * Acts as a safety cap only — the loop also stops as soon as the model
 * produces a final text answer (see `isNaturalEnd`). Set generously so
 * complex exploration tasks aren't truncated, while still bounding runaway
 * loops.
 */
export const SUBAGENT_DEFAULT_MAX_ITERATIONS = 50;

/** Default maximum characters for output (truncation limit) */
export const SUBAGENT_DEFAULT_MAX_OUTPUT_LENGTH = 5000;

/** Sentinel max output length meaning "do not truncate" (write the full summary to disk). */
export const SUBAGENT_NO_TRUNCATE = Infinity;

// ============================================================================
// Types
// ============================================================================

/**
 * Dependencies a subagent run needs from its caller.
 *
 * Declared here (the leaf types module) rather than in `run-subagent.ts` so the progress-summary
 * fallback can name a spawner's signature without importing the runner that calls it — that edge was
 * a real runtime cycle (`run-subagent → progress-summary → run-subagent`).
 */
export interface SubagentRunDeps {
  manager: AgentManager;
}

export type SubagentProfile = "explore" | "internal" | "general";

export interface SubagentConfig {
  /** Optional custom ID for the subagent (auto-generated if not provided) */
  subagentId?: string;
  /** Execution profile. Defaults to `explore`; internal one-shot callers pass `internal`. */
  profile?: SubagentProfile;
  /** The prompt/task for the subagent to complete */
  prompt: string;
  /** Short description for UI display (default: "subtask") */
  description?: string;
  /** Parent agent ID (to get agent instance from AgentManager) */
  parentAgentId: string;
  /** Parent task tool call ID for summary streaming in the task tool UI */
  parentTaskToolCallId?: string;
  /** Custom system prompt (default: SUBAGENT_EXPLORE_SYSTEM_PROMPT) */
  systemPrompt?: string;
  /** Custom tools (default: read-only exploration tools, pass {} for no tools) */
  tools?: ToolsRecord;
  /** Maximum iterations (default: 50) */
  maxIterations?: number;
  /** Maximum output length before truncation (default: 5000) */
  maxOutputLength?: number;
  /** Abort signal */
  abortSignal?: AbortSignal;
  /** Auto-destroy subagent after completion (default: true) */
  autoDestroy?: boolean;
  /** Whether to aggregate usage to parent agent (default: true) */
  aggregateUsageToParent?: boolean;
  /**
   * Initial messages to seed the subagent's context.
   * If provided, these are used instead of starting from empty.
   * Useful for compaction where you want to pass conversation history.
   */
  initialMessages?: ModelMessage[];
  /**
   * When set, stream assistant text into the parent's compact summary stream
   * (`source: "compact"`). Used by compaction summarizer subagents.
   */
  compactSummaryStream?: {
    compactId: string;
    /** Phase label surfaced on the compact banner (multi-pass compaction). */
    label?: string;
    /**
     * Compaction run identity. When the hub already holds a live snapshot for
     * the same epoch, the new pass APPENDS (with a `[label]` separator) instead
     * of resetting the banner — sequential passes of one compaction read as one
     * continuous stream.
     */
    epoch?: string;
  };
  /**
   * Observe assistant text deltas as the subagent streams (all phases).
   * Used by the progress-summary fallback to mirror the side-LLM report
   * into the task summary UI while it generates.
   */
  onTextDelta?: (delta: string) => void;
}

export interface SubagentResult {
  /** Subagent ID - use to get instance via agentManager.getAgent(subagentId) */
  subagentId: string;
  /** Execution profile, carried for UI-only task metadata. */
  profile?: AgentProfileId;
  /** Final output text (may be truncated; full output at cachedOutputPath) */
  output: string;
  /** Whether the output was truncated */
  truncated: boolean;
  /** Number of iterations used (model turns, the engine's own count) */
  iterations: number;
  /** Iteration budget those counts were measured against (`used/budget` for display) */
  maxIterations: number;
  /** Wall-clock duration of the subagent run itself (ms) — authoritative for
   * pre-forked tasks where the caller's join wait would undercount. */
  durationMs: number;
  /** Token usage */
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    /**
     * Billed prompt tokens (cache-aware). `inputTokens` is NOT the prompt under an
     * exclusive upstream (Anthropic/DeepSeek native), where it holds only the cache-miss
     * part — a fully cached subagent run reads as ~0. Surfacing it here keeps host
     * rendering on the tracker's single convention-aware reading
     * (`UsageTracker.getBilledInputTokens()`); see AGENTS.md "Context-window fill".
     */
    billedInputTokens: number;
    /**
     * Cache counters, carried so a persisted result stays self-describing: a reader that
     * meets an older output without `billedInputTokens` reconstructs the prompt from these
     * instead of showing 0 (`formatTaskOutput`).
     */
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  /** Whether iteration limit was reached */
  reachedLimit: boolean;
  /**
   * Whether the subagent finished without a natural end — e.g. step-budget cut
   * off (`finishReason: tool_calls`), output truncated (`length`), error, empty
   * summary, or explore tools used without `begin_summary`. Findings may be partial.
   */
  incomplete: boolean;
  /** Whether the subagent was cancelled (aborted) before completing */
  aborted: boolean;
  /**
   * Why an aborted run stopped — `user` (Esc), `parent-run` (the parent's run was
   * discarded, e.g. a stream restart), or `parent-stop` (the parent agent stopped or was
   * destroyed). Set only when `aborted`; read from the run's abort reason.
   */
  stopReason?: SubagentStopReason;
}
