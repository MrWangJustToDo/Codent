import type { ReasoningLevel } from "@tanstack/ai";

// ============================================================================
// Model Configuration Types
// ============================================================================

/**
 * API protocol style — determines which TanStack text adapter to use.
 */
export type ModelStyle = "openai" | "anthropic";

/**
 * Internal model identifier used as registry key.
 * Format: vendor-scoped (e.g. "claude-4-sonnet", "gpt-4.1", "deepseek-chat")
 * or prefixed for gateways (e.g. "openrouter/claude-4-sonnet").
 */
export type ModelId = string;

/**
 * Every model capability, as a runtime value.
 *
 * The single source of truth for the capability list. `ModelCapability` is derived from it,
 * so the union and this array cannot drift apart — add a capability here and the union
 * follows.
 *
 * Order is the declaration order used for display/iteration; do not reorder casually, as
 * snapshots and generated tables follow it.
 *
 * **Every member must be evidenceable.** Each one maps to provider metadata this file's
 * consumer (`deriveCapabilities`) actually reads. Two former members were removed because
 * they were not:
 *
 * - `streaming` was granted to every model unconditionally. It described no model (every
 *   endpoint we ship adapters for streams) and nothing read it — it was really standing in for
 *   "metadata was parsed", a job now done by `ModelInfo.capabilities` being `undefined` vs `[]`.
 * - `computer_use` had no metadata source and no consumer.
 *
 * Neither removal changes a send-gate: the multimodal strip reads `vision` / `audio` / `video` /
 * `document` only.
 */
export const MODEL_CAPABILITIES = [
  "reasoning",
  "vision",
  "audio",
  "video",
  "document",
  "tool_calling",
  "prompt_caching",
  "json_output",
] as const;

/**
 * Model capability flags.
 * Using a string union for forward compatibility — new capabilities
 * can be added without breaking existing configs.
 *
 * Derived from {@link MODEL_CAPABILITIES} so there is exactly one list.
 */
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

/**
 * Reasoning effort levels a model may accept.
 *
 * A runtime list, with {@link ReasoningEffort} derived from it — the same shape as
 * {@link MODEL_CAPABILITIES}: the hosts that validate `/models` depth input and the adapters that forward it
 * both need the values, and a hand-written copy in a host is how a level added here goes missing there.
 */
export const REASONING_EFFORT_VALUES = ["none", "low", "medium", "high", "xhigh", "max", "minimal"] as const;

/** Reasoning effort values a model may accept. */
export type ReasoningEffort = (typeof REASONING_EFFORT_VALUES)[number];

/** Whether a string is one of {@link REASONING_EFFORT_VALUES}. */
export function isReasoningEffort(value: string): value is ReasoningEffort {
  return (REASONING_EFFORT_VALUES as readonly string[]).includes(value);
}

/**
 * Map our historical `"none"` spelling onto TanStack's unified reasoning option (`0.69+` uses
 * `"off"`). Keeping the project-facing type stable avoids a second level vocabulary in sessions,
 * commands, and the model picker.
 */
export function toTanStackReasoningLevel(effort: ReasoningEffort): ReasoningLevel {
  return effort === "none" ? "off" : effort;
}

/**
 * The effort values to offer for a model: what it advertises (`reasoning_options` via models.dev), or
 * the full known set when it advertises nothing.
 *
 * One definition: the TUI and the ACP host both validate a `/models` depth against this, and a
 * hand-rolled fallback in one host is how the two lists drift apart.
 */
export function supportedReasoningEfforts(
  modelInfo: Pick<ModelInfo, "reasoningConfig"> | undefined
): readonly ReasoningEffort[] {
  const values = modelInfo?.reasoningConfig?.effortValues;
  return values && values.length > 0 ? values : REASONING_EFFORT_VALUES;
}

/**
 * The effort levels a model should be OFFERED in a picker — `[]` when it has no thinking depth.
 *
 * Deliberately stricter than {@link supportedReasoningEfforts}, which is the *validation* rule: that one
 * falls back to every known level so a hand-typed level is not refused for a model whose metadata is
 * missing. A menu has the opposite obligation — an empty submenu means "this model has nothing to
 * choose", and offering seven levels for a plain text model would be a fake choice. So this requires
 * positive evidence, in metadata:
 *
 * - `capabilities` includes `reasoning` (models.dev `reasoning`), **and**
 * - `reasoningConfig.effortValues` is non-empty — a level it does not advertise would be accepted by
 *   validation and then rejected upstream.
 *
 * `capabilities === undefined` (unknown model, offline) is not evidence either, so it offers nothing:
 * guessing "all levels" here is what makes a menu whose selection fails at request time.
 */
export function offerableReasoningEfforts(
  modelInfo: Pick<ModelInfo, "capabilities" | "reasoningConfig"> | undefined
): readonly ReasoningEffort[] {
  if (!modelInfo?.capabilities?.includes("reasoning")) return [];
  return modelInfo.reasoningConfig?.effortValues ?? [];
}

/**
 * Wire field a model echoes its reasoning back on.
 *
 * `reasoning_content` is the DeepSeek-style scalar we implement; `reasoning_details` is
 * OpenRouter's structured block array (used for encrypted / summarized reasoning). See
 * {@link ModelInfo.reasoningEchoField}.
 */
export type ReasoningEchoField = "reasoning_content" | "reasoning_details";

/**
 * Reasoning-specific configuration for models that support thinking/CoT.
 */
export interface ReasoningConfig {
  /** Tag name used to extract reasoning (e.g. "think" for DeepSeek R1, Qwen3) */
  tagName?: string;
  /** Default reasoning effort level */
  defaultEffort?: ReasoningEffort;
  /**
   * All effort values the model accepts, from models.dev `reasoning_options`
   * (e.g. `["none","low","medium","high"]`). Used by the UI to offer only
   * valid choices. Empty/undefined means the model does not advertise effort
   * levels — effort configuration is unavailable.
   */
  effortValues?: ReasoningEffort[];
  /** Max thinking budget in tokens (if supported) */
  maxBudget?: number;
}

/**
 * Pricing in USD per 1M tokens.
 * All fields optional — local/free models have no pricing.
 */
export interface ModelPricing {
  inputPerM: number;
  outputPerM: number;
  cacheWritePerM?: number;
  cacheReadPerM?: number;
}

/**
 * Complete model metadata entry.
 */
export interface ModelInfo {
  /** Internal identifier (registry key) */
  id: ModelId;
  /** Human-readable display name */
  name: string;
  /** API style this model uses (openai-compatible vs anthropic) */
  style: ModelStyle;
  /** Actual model string sent to the API (may differ from id) */
  apiModel: string;
  /** Max input context window in tokens. May be undefined if not yet resolved from models.dev. */
  contextWindow?: number;
  /** Default max output tokens. May be undefined if not yet resolved from models.dev. */
  defaultMaxTokens?: number;
  /** Pricing in USD per 1M tokens */
  pricing?: ModelPricing;
  /**
   * Capability flags, or `undefined` when the model's capabilities are **unknown**.
   *
   * The two empty-ish states are deliberately different, and the distinction is what lets
   * `CapabilityProbe.hasCapability` stay permissive without silently over-sending:
   *
   * - `undefined` — nothing was declared (offline, unknown model, no metadata). Treated as
   *   "unknown", so gates allow everything. This is the safe default for a model we cannot
   *   describe.
   * - `[]` — capabilities were resolved and the model declares none of them. Gates are then
   *   strict: a text-only model really does have its images stripped before send.
   *
   * A successful metadata parse must therefore produce `[]` rather than `undefined` for a plain
   * text model — that is the difference between "strip the image" and "send it to an endpoint
   * that will reject it".
   */
  capabilities?: ModelCapability[];
  /**
   * Reasoning-specific config (only if "reasoning" capability is present).
   * Metadata only today — not yet applied to TanStack adapter request options.
   * Wire protocol quirks (e.g. DeepSeek `reasoning_content` echo) live in
   * `createTextAdapter` / `ReasoningChatCompletionsTextAdapter`, not in middleware.
   */
  reasoningConfig?: ReasoningConfig;
  /**
   * Whether models.dev marks reasoning as interleaving with tool calls (`interleaved` present).
   *
   * Separate from {@link reasoningEchoField}, and not derivable from it: `reasoningEchoField` is
   * only set for the non-default wire field, so an entry that interleaves on `reasoning_content`
   * has no field override but still needs the reasoning-echo adapter. Two catalog entries are
   * exactly that shape *and* declare `reasoning: false`
   * (`siliconflow-cn/…/MiniMax-M2.5`, `novita-ai/minimax/minimax-m2.1`), so honoring only the
   * `reasoning` capability left them with no echo at all.
   *
   * This is the signal the adapter routes on; `capabilities` alone is not sufficient.
   */
  reasoningInterleaved?: boolean;
  /**
   * Wire field this model echoes reasoning back on, when it is **not** the default.
   *
   * `undefined` means `reasoning_content`. Only 15 of 7842 entries name `reasoning_details`; the
   * other 1068 entries carrying `interleaved` either name `reasoning_content` or name nothing, and
   * both of those are the default — so only the override is worth storing.
   *
   * A string, deliberately **not** a numbered capability: it describes the wire protocol rather
   * than what the model can do, which is why it sits beside `reasoningConfig` (where the DeepSeek
   * `reasoning_content` quirk is documented) instead of in `capabilities`.
   *
   * Not consumed yet — the adapter still sends `reasoning_content`, so today this is observability
   * plus the decision input for a structural (`reasoning_details`) handoff. Structured blocks
   * cannot be carried yet regardless: TanStack's `extractReasoning` seam returns
   * `{ text: string }`, so an encrypted or summarized block has nowhere to live.
   */
  reasoningEchoField?: ReasoningEchoField;
  /** Whether this is a recommended/default model for its style */
  isDefault?: boolean;
  /** Optional API base URL override (merged into connection resolution) */
  baseURL?: string;
}

/**
 * Lightweight model reference for UI display and selection.
 */
export interface ModelOption {
  id: ModelId;
  name: string;
  style: ModelStyle;
  contextWindow?: number;
  /** See {@link ModelInfo.capabilities} for the `undefined` (unknown) vs `[]` (declared none) split. */
  capabilities?: ModelCapability[];
}
