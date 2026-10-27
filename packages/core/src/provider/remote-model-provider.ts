/**
 * Remote model provider — points TanStack adapters at a server that holds the
 * real API keys and exposes `/api/provider/*` (streaming upstream chat traffic).
 *
 * Orthogonal to CoreEnv — pass any server base URL that exposes `/api/provider/info`.
 *
 * Lives in `@codent/core` (not the server) so any host — CLI, extension, or the
 * browser playground — can register a remote-mode provider without depending on
 * `@codent/server`. Only uses `fetch` + core types, safe for Node and browsers.
 */

import type { ModelProvider } from "./model-provider.js";
import type { ModelsConfig } from "../models/config/models-config.js";

/** Placeholder apiKey for remote provider adapters (the server injects the real key). */
export const REMOTE_PROVIDER_API_KEY = "remote-provider";

export interface ProviderInfoResponse {
  mode: "remote";
  style: "openai" | "anthropic";
  model: string;
  basePath: string;
  /** The server's sanitized models.json — selectable ids live in the entries plus the active pick. */
  config?: ModelsConfig;
}

/**
 * Selectable model ids from a server's advertised config, plus the model it serves.
 *
 * The client chooses the model (see `selectModel`), so the provider has to hand it the same
 * allowlist the proxy validates against — otherwise every `/models` pick would be a guess about
 * what the server accepts. `active.model` is part of that allowlist (the server's own recorded
 * selection); leaving it out made `/models` list a current id that bootstrap then refused. The
 * served model is always included: it is what a request falls back to, so it must be legal.
 */
export function serverAdvertisedModels(info: ProviderInfoResponse): readonly string[] {
  const ids = new Set<string>();
  for (const entry of info.config?.models ?? []) {
    if (entry.type !== "direct") continue;
    for (const id of entry.models ?? []) if (id) ids.add(id);
  }
  const active = info.config?.active?.model?.trim();
  if (active) ids.add(active);
  const served = info.model?.trim();
  if (served) ids.add(served);
  return [...ids];
}

/**
 * Fetch `/api/provider/info` with the shared validation and error strings.
 *
 * @throws if the server does not expose provider info or returns a non-remote payload.
 */
export async function fetchProviderInfo(serverUrl: string): Promise<ProviderInfoResponse> {
  const baseUrl = serverUrl.replace(/\/+$/, "");
  const infoRes = await fetch(`${baseUrl}/api/provider/info`);
  if (!infoRes.ok) {
    throw new Error(
      `Remote provider unavailable at ${baseUrl}/api/provider/info (HTTP ${infoRes.status}). ` +
        `Start a server that exposes /api/provider or omit --remote-provider for local keys.`
    );
  }
  const info = (await infoRes.json()) as ProviderInfoResponse;
  if (info.mode !== "remote" || !info.basePath || !info.style) {
    throw new Error(`Invalid provider info from ${baseUrl}/api/provider/info`);
  }
  return info;
}

/**
 * Fetch `/api/provider/info` and return a remote-mode {@link ModelProvider}.
 *
 * @throws if the server does not expose provider info or returns an error.
 */
export async function createRemoteProvider(serverUrl: string): Promise<ModelProvider> {
  const baseUrl = serverUrl.replace(/\/+$/, "");
  const info = await fetchProviderInfo(serverUrl);
  return {
    getConnection: async () => ({
      mode: "remote",
      style: info.style,
      model: info.model ?? "",
      baseURL: `${baseUrl}${info.basePath}`,
      apiKey: REMOTE_PROVIDER_API_KEY,
      models: serverAdvertisedModels(info),
    }),
  };
}
