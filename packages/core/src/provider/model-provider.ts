/**
 * Model provider plane — independent of CoreEnv (workspace fs/shell).
 *
 * Hosts register a {@link ModelProvider} before creating agents:
 * - {@link createDirectModelProvider} — local keys / baseURL
 * - {@link createRemoteProvider} — keys stay on a remote provider server
 */

import { resolveModelConnection, type ResolveModelConfigInput } from "../models/config/model-config.js";

// ============================================================================
// Types
// ============================================================================

/** How the host talks to the LLM. */
export type ModelProviderMode = "direct" | "remote";

/**
 * Connection info for TanStack text adapters.
 *
 * In `remote` mode, `apiKey` is a placeholder and `baseURL` points at a streaming
 * provider proxy (real credentials stay on that server).
 */
export interface ModelProviderConnection {
  mode: ModelProviderMode;
  style: "openai" | "anthropic";
  model: string;
  baseURL: string;
  apiKey: string;
  /**
   * Selectable model ids the plane advertises (`/api/provider/info`'s model list, remote mode).
   *
   * The MODEL a session runs is the client's choice from this list — the provider supplies the
   * connection and every id the server will accept, not the selection. `undefined` / empty means
   * the plane advertises no list, which makes a client request trusted rather than checked (see
   * `selectModel`); `model` remains the fallback for a request the list does not offer.
   */
  models?: readonly string[];
}

/** LLM connection source — orthogonal to {@link import("../env").CoreEnv}. */
export interface ModelProvider {
  getConnection(): Promise<ModelProviderConnection>;
  destroy?(): Promise<void>;
}

// ============================================================================
// Direct factory
// ============================================================================

/**
 * Create a direct-mode provider from explicit connection fields.
 *
 * Does not read CoreEnv or process.env — hosts parse env/flags and pass fields.
 */
export function createDirectModelProvider(input: ResolveModelConfigInput = {}): ModelProvider {
  return {
    getConnection: async () => {
      const connection = resolveModelConnection(input);
      return {
        mode: "direct",
        style: connection.style,
        model: connection.model,
        baseURL: connection.baseURL,
        apiKey: connection.apiKey,
      };
    },
  };
}
