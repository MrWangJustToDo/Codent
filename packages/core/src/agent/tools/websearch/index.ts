/**
 * WebSearch Module — Barrel export for the multi-provider search architecture.
 *
 * Registers providers from the {@link PROVIDER_REGISTRY} with the global
 * ProviderManager singleton. Call {@link initializeProviders} before first use.
 */

import { getProviderManager, resetProviderManager } from "./provider.js";
import { PROVIDER_REGISTRY } from "./registry.js";

import type { WebsearchToolConfig } from "../tool-config.js";
import type { SearchProvider, SearchResult, SearchOptions, SearchOutcome, ProviderInfo } from "./types.js";

export type { SearchProvider, SearchResult, SearchOptions, SearchOutcome, ProviderInfo };
export type { ProviderRegistration } from "./registry.js";

export { ProviderManager, getProviderManager, resetProviderManager, hashToIndex } from "./provider.js";
export { PROVIDER_REGISTRY } from "./registry.js";
export { PROVIDER_KEY_FIELDS } from "./key-fields.js";
export { filterResultsByDomain } from "./domain-filter.js";
export { createTimeoutAbort, withTimeoutAbort } from "../util/abort-timeout.js";
export { duckduckgoProvider } from "./providers/duckduckgo.js";
export { braveProvider } from "./providers/brave.js";
export { exaProvider, parseExaResults } from "./providers/exa.js";
export { parallelProvider, parseParallelResults } from "./providers/parallel.js";
export { tavilyProvider } from "./providers/tavily.js";

// ============================================================================
// Initialization
// ============================================================================

let initialized = false;

/**
 * Initialize the provider manager with all registered providers.
 *
 * Registration order comes from {@link PROVIDER_REGISTRY} (Brave → Parallel → Exa →
 * Tavily → DuckDuckGo): earlier entries are preferred, free providers are spread by
 * session id, and the last entry is the unconditional fallback.
 *
 * Pass {@link WebsearchToolConfig} so secrets come from the host, not CoreEnv.
 */
export function initializeProviders(config?: WebsearchToolConfig): void {
  if (!initialized) {
    initialized = true;
    const pm = getProviderManager();
    for (const registration of PROVIDER_REGISTRY) {
      pm.register(registration.create());
    }
  }
  getProviderManager().configure(config);
}

/**
 * Reset providers + initialization flag (for testing).
 */
export function resetWebsearchProviders(): void {
  initialized = false;
  resetProviderManager();
}
