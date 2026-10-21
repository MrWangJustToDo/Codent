import { createAnthropicChat } from "@tanstack/ai-anthropic";

import { createChatCompletions } from "./chat-completions-text-adapter.js";
import { createReasoningChatCompletions } from "./reasoning-chat-completions-adapter.js";
import { shouldEchoReasoningContent } from "./reasoning-echo.js";

import type { ModelInfo, ModelPricing, ModelStyle } from "../types.js";
import type { AnyTextAdapter } from "@tanstack/ai";

// ============================================================================
// Types
// ============================================================================

export interface TextAdapterConfig {
  adapter: AnyTextAdapter;
  /** Model id passed to `chat({ model })` */
  model: string;
  /** API protocol style — selects the provider-specific token-cap field. */
  modelStyle: ModelStyle;
  /** Whether the model advertises the `reasoning` capability. */
  reasoning?: boolean;
  /** Pricing from the resolved ModelInfo (models.dev) — lets side queries cost + record their own usage. */
  pricing?: ModelPricing;
  /**
   * Whether a structured (`outputSchema`) request may be attempted against this model.
   *
   * Resolved from `ModelInfo.capabilities` where metadata is read, and **defaults to
   * `"supported"`** so a hand-built config (validators construct one directly) keeps the
   * pre-existing behaviour of always attempting structured output.
   *
   * `"unsupported"` means the model's capabilities were resolved and positively exclude
   * `json_output` — 14.5% of the models.dev catalog declares exactly that. It is a decision, not
   * a hint: `runSideTextQuery` must not send a structured request at all, because the failure it
   * would produce is provider-specific and hard to tell from a model that merely returned
   * nothing. Unknown capabilities resolve to `"supported"`, consistent with
   * `CapabilityProbe.hasCapability` being permissive for `undefined` — assuming a capability is
   * *missing* would silently route every undescribable model through the weaker path.
   */
  structuredOutput?: StructuredOutputSupport;
}

/**
 * Resolved structured-output decision — see {@link TextAdapterConfig.structuredOutput}.
 *
 * Two states, not three: the `undefined` / `[]` distinction is the *input* to this decision and
 * is already collapsed the way `UsageTracker.setCapabilities` collapses it.
 */
export type StructuredOutputSupport = "supported" | "unsupported";

export interface ModelAdapterConfig {
  style: ModelStyle;
  model: string;
  baseURL: string;
  apiKey?: string;
  /**
   * Resolved model metadata (models.dev). The advertised `reasoning` capability
   * routes thinking-enabled models through the reasoning adapter without a
   * brand-name allow-list.
   */
  modelInfo?: ModelInfo | null;
}

// ============================================================================
// Adapter Factory
// ============================================================================

/**
 * Create a TanStack text adapter for OpenAI-compatible or Anthropic APIs.
 *
 * OpenAI-compatible providers (DeepSeek, Ollama, OpenRouter, gateways) use the
 * Chat Completions API (`/chat/completions`), not OpenAI's newer Responses API.
 */
export function createTextAdapter(config: ModelAdapterConfig): TextAdapterConfig {
  const { style, model, baseURL, apiKey } = config;

  const trimmedBaseURL = baseURL?.trim();
  if (!trimmedBaseURL) {
    throw new Error(
      `Model baseURL is required for style "${style}". Pass baseURL when registering the ModelProvider / creating the agent.`
    );
  }

  // A declared absence is the only thing that overrides the default. `undefined` (no metadata)
  // and a declared presence both leave it `"supported"` — see the field doc.
  const structuredOutput: StructuredOutputSupport = config.modelInfo?.capabilities?.includes("json_output")
    ? "supported"
    : config.modelInfo?.capabilities
      ? "unsupported"
      : "supported";

  if (style === "anthropic") {
    if (!apiKey) {
      throw new Error("Anthropic style requires an API key (pass apiKey when registering the ModelProvider).");
    }
    return {
      adapter: createAnthropicChat(model as Parameters<typeof createAnthropicChat>[0], apiKey, {
        baseURL: trimmedBaseURL,
        dangerouslyAllowBrowser: true,
      }),
      model,
      modelStyle: "anthropic",
      reasoning: true,
      pricing: config.modelInfo?.pricing,
      structuredOutput,
    };
  }

  const key = apiKey || "not-needed";
  const openaiConfig = { baseURL: trimmedBaseURL, maxRetries: 0 };

  if (shouldEchoReasoningContent(config.modelInfo)) {
    return {
      adapter: createReasoningChatCompletions(model, key, {
        ...openaiConfig,
      }) as AnyTextAdapter,
      model,
      modelStyle: "openai",
      reasoning: true,
      pricing: config.modelInfo?.pricing,
      structuredOutput,
    };
  }

  return {
    adapter: createChatCompletions(model, key, {
      ...openaiConfig,
      dangerouslyAllowBrowser: true,
    }) as AnyTextAdapter,
    model,
    modelStyle: "openai",
    reasoning: shouldEchoReasoningContent(config.modelInfo),
    pricing: config.modelInfo?.pricing,
    structuredOutput,
  };
}
