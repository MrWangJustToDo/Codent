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

/** Placeholder apiKey for remote provider adapters (the server injects the real key). */
export const REMOTE_PROVIDER_API_KEY = "remote-provider";

type ProviderInfoResponse = {
  mode: "remote";
  style: "openai" | "anthropic";
  model: string;
  basePath: string;
};

/**
 * Fetch `/api/provider/info` and return a remote-mode {@link ModelProvider}.
 *
 * @throws if the server does not expose provider info or returns an error.
 */
export async function createRemoteProvider(serverUrl: string): Promise<ModelProvider> {
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
  return {
    getConnection: async () => ({
      mode: "remote",
      style: info.style,
      model: info.model ?? "",
      baseURL: `${baseUrl}${info.basePath}`,
      apiKey: REMOTE_PROVIDER_API_KEY,
    }),
  };
}
