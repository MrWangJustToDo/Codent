/**
 * Model provider plane — independent of CoreEnv (workspace fs/shell).
 *
 * Hosts register a {@link ModelProvider} before creating agents:
 * - {@link createDirectModelProvider} — local keys / baseURL
 * - {@link createRemoteProvider} — keys stay on a remote provider server
 */

import { resolveModelConnection, type ResolveModelConfigInput } from "../config/model-config.js";

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
}

/** LLM connection source — orthogonal to {@link import("../env").CoreEnv}. */
export interface ModelProvider {
  getConnection(): Promise<ModelProviderConnection>;
  destroy?(): Promise<void>;
}

// ============================================================================
// Registry
// ============================================================================

let _provider: ModelProvider | null = null;

/**
 * Register the model provider for `@codent/core`.
 *
 * Must be called before {@link getModelProvider} / agent creation that resolves models.
 */
export function registerModelProvider(provider: ModelProvider): void {
  _provider = provider;
}

/** Clear the registered model provider (e.g. on host disconnect). */
export function clearModelProvider(): void {
  const prev = _provider;
  _provider = null;
  void prev?.destroy?.();
}

/** Whether a model provider is registered. */
export function hasModelProvider(): boolean {
  return _provider !== null;
}

/**
 * Get the registered model provider.
 *
 * @throws if {@link registerModelProvider} has not been called.
 */
export function getModelProvider(): ModelProvider {
  if (!_provider) {
    throw new Error(
      "ModelProvider not registered. Call registerModelProvider() before resolving models. " +
        "Use createDirectModelProvider() or createRemoteProvider() from the host."
    );
  }
  return _provider;
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
