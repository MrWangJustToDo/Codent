/**
 * Resolve model connection using the registered {@link ModelProvider}.
 *
 * When the provider reports `mode: "remote"`, baseURL / apiKey / style are forced from the
 * provider so clients cannot bypass the key-holding remote provider. The MODEL is not: a remote
 * provider supplies a selectable catalog, and the client picks from it (see
 * {@link selectModel}). A pick the provider does not offer falls back to the model it serves
 * rather than being forwarded to be refused, and the fallback rides back on the result so the
 * caller can report it.
 */

import {
  resolveModelConfig,
  type ResolveModelConfigInput,
  type ResolvedModelConfig,
} from "../models/config/model-config.js";
import { selectModel, type ModelSelection } from "../models/config/model-selection.js";

import { getModelProvider } from "./model-provider-registry.js";
import { type ModelProvider, type ModelProviderMode } from "./model-provider.js";

import type { ModelStyle } from "../models/types.js";

function asStyle(value: string | undefined): ModelStyle | undefined {
  if (value === "openai" || value === "anthropic") return value;
  return undefined;
}

export interface ResolvedModelConfigFromProvider extends ResolvedModelConfig {
  /** Mode reported by the registered {@link ModelProvider}. */
  providerMode: ModelProviderMode;
  /**
   * Set when the client's model was dropped because the provider does not offer it (remote mode),
   * naming both sides so the caller can log the substitution instead of hiding it.
   */
  modelFallback?: ModelSelection["fallback"];
}

/**
 * Resolve connection + model metadata, merging AppConfig overrides with a
 * {@link ModelProvider}.
 *
 * @param provider - The runtime's provider. When omitted, the ambient registry
 *   (`getModelProvider()`) is used, preserving the legacy bootstrap.
 */
export async function resolveModelConfigFromProvider(
  input: ResolveModelConfigInput = {},
  provider?: ModelProvider
): Promise<ResolvedModelConfigFromProvider> {
  const providerConn = await (provider ?? getModelProvider()).getConnection();

  const merged: ResolveModelConfigInput = {
    ...input,
    model: input.model?.trim() ? input.model : providerConn.model,
    style: input.style ?? asStyle(providerConn.style),
    baseURL: input.baseURL ?? providerConn.baseURL,
    apiKey: input.apiKey ?? providerConn.apiKey,
  };

  if (providerConn.mode === "remote") {
    // Remote mode: never allow client baseURL/apiKey (or mismatched style) to bypass the server.
    // The MODEL is the client's: the provider advertises a catalog and the proxy validates
    // against it, so a selection from that catalog is what a request must carry ("silently
    // swapping the model in a client's request body is the worse failure" — the same rule the
    // proxy states on its own side). A selection the provider does NOT offer falls back to the
    // served model, and the substitution is reported rather than hidden.
    const selection = selectModel({
      requested: merged.model,
      fallback: providerConn.model,
      allowed: providerConn.models,
    });
    merged.baseURL = providerConn.baseURL;
    merged.apiKey = providerConn.apiKey;
    merged.style = providerConn.style;
    merged.model = selection.model;

    const resolved = await resolveModelConfig(merged);

    // resolveModelConfig may overwrite baseURL from models.dev metadata —
    // re-force the remote endpoint so LLM traffic stays on the provider server.
    return {
      connection: {
        ...resolved.connection,
        style: providerConn.style,
        baseURL: providerConn.baseURL,
        apiKey: providerConn.apiKey,
        model: selection.model,
      },
      modelInfo: resolved.modelInfo ? { ...resolved.modelInfo, baseURL: undefined } : undefined,
      providerMode: "remote",
      ...(selection.fallback ? { modelFallback: selection.fallback } : {}),
    };
  }

  const resolved = await resolveModelConfig(merged);
  return {
    ...resolved,
    providerMode: providerConn.mode,
  };
}
