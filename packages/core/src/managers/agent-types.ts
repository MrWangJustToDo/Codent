import { z } from "zod";

import { REASONING_EFFORT_VALUES } from "../models/types.js";
import { DEFAULT_AGENT_MAX_ITERATIONS, MAX_AGENT_ITERATIONS } from "../runtime-types/agent-limits.js";

import type { ModelMessage } from "@tanstack/ai";

// ============================================================================
// Agent Config
// ============================================================================

/** Agent-loop iteration limits (defined in runtime-types, re-exported for manager-side consumers). */
export { DEFAULT_AGENT_MAX_ITERATIONS, MAX_AGENT_ITERATIONS } from "../runtime-types/agent-limits.js";

export const AgentConfigSchema = z.object({
  // The schema is where a config key becomes REAL: `ManagedAgent` re-parses every config through
  // it, and a Zod object strips keys it does not declare. `ManagedAgentConfig`'s extras survive
  // because the constructor spreads the raw config first; `updateConfig(Partial<AgentConfig>)`
  // can only touch what is declared here.
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
    .max(MAX_AGENT_ITERATIONS)
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
  // Sampling knobs, forwarded from `AgentSessionCreateOptions` (no CLI flag). Consumed one layer
  // down (`run-agent.ts` → `AgentRunner`).
  temperature: z.number().min(0).max(2).optional().describe("Sampling temperature"),
  reasoningEffort: z
    .enum(REASONING_EFFORT_VALUES)
    .optional()
    // Settable at creation through `AgentSessionCreateOptions.reasoningEffort`; otherwise
    // `run-agent.ts` applies the model metadata's `reasoningConfig.defaultEffort`. Runtime changes
    // go through `effort.set` / `/models` (ACP's `thought_level`), and `setModel` drops a level the
    // new model does not advertise.
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
