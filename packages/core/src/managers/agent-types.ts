import { z } from "zod";

import { DEFAULT_AGENT_MAX_ITERATIONS } from "../runtime-types/agent-limits.js";

import type { ReasoningEffort } from "../models/types.js";
import type { ModelMessage } from "@tanstack/ai";

// ============================================================================
// Agent Config
// ============================================================================

export const REASONING_EFFORT_VALUES: readonly ReasoningEffort[] = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "minimal",
];

/** Default maximum agentic-loop iterations for the main agent run loop (defined in runtime-types, re-exported for manager-side consumers). */
export { DEFAULT_AGENT_MAX_ITERATIONS } from "../runtime-types/agent-limits.js";

export const AgentConfigSchema = z.object({
  model: z.string().min(1).describe("Model name to use"),
  modelStyle: z.enum(["openai", "anthropic"]).optional().describe("API style (OpenAI-compatible or Anthropic)"),
  modelBaseURL: z.string().optional().describe("Base URL for the model API"),
  modelApiKey: z.string().optional().describe("API key for the model endpoint"),
  /**
   * Where the model connection comes from. `remote` means a provider server owns
   * the model (see `resolveModelConfigFromProvider`) — the agent must not override
   * it locally, e.g. when adopting a resumed session's persisted model.
   */
  providerMode: z.enum(["direct", "remote"]).optional().describe("Model provider mode"),
  systemPrompt: z.string().optional().describe("System prompt for the agent"),
  maxIterations: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(DEFAULT_AGENT_MAX_ITERATIONS)
    .describe("Maximum agentic loop iterations"),
  /**
   * Maximum number of `task` subagents running concurrently under this parent.
   * Defaults to 4. Values below 1 are treated as 1. Part of `AgentConfig` (not a
   * manager-only extra) so `ManagedAgent.updateConfig` can change it at runtime —
   * `AgentConfigSchema` strips anything it does not declare.
   */
  maxConcurrentTasks: z
    .number()
    .optional()
    .describe("Max concurrent `task` subagents per parent (default 4; values below 1 treated as 1)"),
  maxTokens: z.number().int().min(1).optional().describe("Maximum tokens per response"),
  temperature: z.number().min(0).max(2).optional().describe("Sampling temperature"),
  reasoningEffort: z
    .enum(REASONING_EFFORT_VALUES)
    .optional()
    .describe("Reasoning effort level for reasoning-capable models"),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

// ============================================================================
// Agent Status (compat re-exports)
// ============================================================================

export type { AgentStatus, RunFinalizeReason } from "../runtime-types/agent-status.js";

// ============================================================================
// Run options
// ============================================================================

export interface AgentRunOptions {
  prompt?: string;
  messages?: ModelMessage[];
  abortSignal?: AbortSignal;
}
