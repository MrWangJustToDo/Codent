/**
 * Model configuration — explicit connection + optional models.dev metadata.
 *
 * Hosts MUST pass model / style / baseURL / apiKey (and optional modelInfo).
 * Core does not read environment-variable bags for LLM credentials.
 */

import { lookupModelFromModelsDev } from "../../provider/models-dev.js";

import type { ModelInfo, ModelStyle } from "../types.js";

export type { ModelStyle } from "../types.js";

// ============================================================================
// Types & defaults
// ============================================================================

export const DEFAULT_BASE_URLS: Record<ModelStyle, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
};

/** Default OpenAI-compatible URL for local endpoints (e.g. Ollama). */
export const DEFAULT_LOCAL_OPENAI_BASE_URL = "http://localhost:11434/v1";

export interface ModelConnection {
  style: ModelStyle;
  model: string;
  baseURL: string;
  apiKey: string;
}

export interface ResolveModelConfigInput {
  model?: string;
  style?: ModelStyle;
  baseURL?: string;
  apiKey?: string;
  modelInfo?: ModelInfo;
}

export interface ResolvedModelConfig {
  connection: ModelConnection;
  modelInfo?: ModelInfo;
}

// ============================================================================
// Parsing
// ============================================================================

export function parseModelStyle(raw: string | undefined, fallback: ModelStyle = "openai"): ModelStyle {
  const value = raw?.trim().toLowerCase();
  if (value === "anthropic") return "anthropic";
  if (value === "openai") return "openai";
  return fallback;
}

export function trimBaseURL(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Resolve connection settings from explicit fields (no env bag, no network).
 */
export function resolveModelConnection(input: ResolveModelConfigInput = {}): ModelConnection {
  const style = input.style ?? "openai";
  const model = input.model?.trim() ?? "";
  const baseURL = trimBaseURL(input.baseURL?.trim() || input.modelInfo?.baseURL?.trim() || DEFAULT_BASE_URLS[style]);
  const apiKey = input.apiKey ?? "";

  return { style, model, baseURL, apiKey };
}

/** Explicit overrides for {@link resolveModelConnectionFromEnv} (flags win over the record). */
export interface ModelEnvOverrides {
  model?: string;
  style?: ModelStyle;
  baseURL?: string;
  apiKey?: string;
}

/**
 * Resolve the model connection from an EXPLICIT environment record.
 *
 * The one env→connection mapping. The CLI (flags override), the ACP bootstrap (`.env` fallback) and
 * the agent server all used to carry their own copy — they had already drifted on `||` vs `??` and
 * the ACP copy parsed the style case-sensitively, so `MODEL_STYLE=Anthropic` meant `anthropic` in
 * the TUI and the default `openai` over ACP.
 *
 * The caller supplies the record: core does not read the process environment here, so a runtime's
 * own env (remote workspace, embedder) can be passed instead of the ambient one.
 */
export function resolveModelConnectionFromEnv(
  env: Record<string, string | undefined>,
  overrides: ModelEnvOverrides = {}
): ModelConnection {
  return resolveModelConnection({
    model: overrides.model?.trim() || env.MODEL || env.model || "",
    style: overrides.style ?? parseModelStyle(env.MODEL_STYLE ?? env.STYLE, "openai"),
    baseURL: overrides.baseURL?.trim() || env.BASE_URL || env.MODEL_BASE_URL || undefined,
    apiKey: overrides.apiKey || env.API_KEY || "",
  });
}

function mergeModelInfo(base: ModelInfo | undefined, override: ModelInfo | undefined): ModelInfo | undefined {
  if (!base && !override) return undefined;
  if (!base) return override;
  if (!override) return base;
  return {
    ...base,
    ...override,
    // `undefined` on the override means "this side has no capability data", so the base wins.
    // It does NOT mean "no capabilities": an explicit `[]` is a real declaration (resolved, none
    // apply) and must be kept, or a caller deliberately describing a text-only model would be
    // silently upgraded to whatever models.dev says about the same id. The old `length > 0` test
    // could not tell those two apart.
    capabilities: override.capabilities !== undefined ? override.capabilities : base.capabilities,
    pricing: override.pricing ?? base.pricing,
    reasoningConfig: override.reasoningConfig ?? base.reasoningConfig,
    baseURL: override.baseURL ?? base.baseURL,
  };
}

/**
 * Resolve connection + model metadata (models.dev lookup + caller modelInfo).
 */
export async function resolveModelConfig(input: ResolveModelConfigInput = {}): Promise<ResolvedModelConfig> {
  const connection = resolveModelConnection(input);

  let lookedUp: ModelInfo | undefined;
  if (connection.model) {
    try {
      lookedUp = await lookupModelFromModelsDev(connection.model);
    } catch {
      lookedUp = undefined;
    }
  }

  const modelInfo = mergeModelInfo(lookedUp, input.modelInfo);

  // `resolveModelConnection` already applied the documented precedence
  // (`input.baseURL || modelInfo.baseURL || default`). Re-deriving it here with
  // `modelInfo.baseURL ?? …` silently overruled an explicit `--base-url` / provider override
  // whenever metadata carried a URL, which is why the remote path had to re-force it afterwards.
  return { connection, modelInfo };
}
