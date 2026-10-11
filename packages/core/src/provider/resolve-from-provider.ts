/**
 * Resolve model connection using the registered {@link ModelProvider}.
 *
 * When the provider reports `mode: "remote"`, baseURL and apiKey are forced from
 * the provider so clients cannot bypass the key-holding remote provider.
 */

import {
  resolveModelConfig,
  type ResolveModelConfigInput,
  type ResolvedModelConfig,
} from "../models/config/model-config.js";

import { getModelProvider } from "./model-provider-registry.js";
import { type ModelProviderMode } from "./model-provider.js";

import type { ModelStyle } from "../models/types.js";

function asStyle(value: string | undefined): ModelStyle | undefined {
  if (value === "openai" || value === "anthropic") return value;
  return undefined;
}

export interface ResolvedModelConfigFromProvider extends ResolvedModelConfig {
  /** Mode reported by the registered {@link ModelProvider}. */
  providerMode: ModelProviderMode;
}

/**
 * Resolve connection + model metadata, merging AppConfig overrides with the
 * registered {@link ModelProvider}.
 */
export async function resolveModelConfigFromProvider(
  input: ResolveModelConfigInput = {}
): Promise<ResolvedModelConfigFromProvider> {
  const providerConn = await getModelProvider().getConnection();

  const merged: ResolveModelConfigInput = {
    ...input,
    model: input.model?.trim() ? input.model : providerConn.model,
    style: input.style ?? asStyle(providerConn.style),
    baseURL: input.baseURL ?? providerConn.baseURL,
    apiKey: input.apiKey ?? providerConn.apiKey,
  };

  if (providerConn.mode === "remote") {
    // Remote mode: never allow client baseURL/apiKey (or mismatched style/model) to bypass the
    // server. The server is the single source of truth for model too — otherwise a non-empty
    // local model (e.g. a default like "gpt-4o-mini") leaks into the forwarded request body.
    merged.baseURL = providerConn.baseURL;
    merged.apiKey = providerConn.apiKey;
    merged.style = providerConn.style;
    merged.model = providerConn.model;
  }

  const resolved = await resolveModelConfig(merged);

  if (providerConn.mode === "remote") {
    // resolveModelConfig may overwrite baseURL from models.dev metadata —
    // re-force the remote endpoint so LLM traffic stays on the provider server.
    return {
      connection: {
        ...resolved.connection,
        style: providerConn.style,
        baseURL: providerConn.baseURL,
        apiKey: providerConn.apiKey,
        // Server is the single source of truth for model in remote mode.
        model: providerConn.model,
      },
      modelInfo: resolved.modelInfo ? { ...resolved.modelInfo, baseURL: undefined } : undefined,
      providerMode: "remote",
    };
  }

  return {
    ...resolved,
    providerMode: providerConn.mode,
  };
}
