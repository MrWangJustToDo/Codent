/**
 * WebSearch Module — barrel export for the multi-provider search architecture.
 *
 * Each agent's websearch tool creates its own ProviderManager via
 * {@link createConfiguredProviderManager}; there is no process-global provider instance.
 */

import { ProviderManager } from "./provider.js";
import { PROVIDER_REGISTRY } from "./registry.js";

import type { SearchProvider, SearchResult, SearchOptions, SearchOutcome, ProviderInfo } from "./types.js";

export type { SearchProvider, SearchResult, SearchOptions, SearchOutcome, ProviderInfo };
export type { ProviderRegistration } from "./registry.js";

export { ProviderManager, hashToIndex } from "./provider.js";
export { PROVIDER_REGISTRY } from "./registry.js";
export { PROVIDER_KEY_FIELDS } from "./key-fields.js";
export { filterResultsByDomain } from "./domain-filter.js";
export { createTimeoutAbort, withTimeoutAbort } from "../../../shared/abort-timeout.js";
export { duckduckgoProvider } from "./providers/duckduckgo.js";
export { braveProvider } from "./providers/brave.js";
export { exaProvider, parseExaResults } from "./providers/exa.js";
export { parallelProvider, parseParallelResults } from "./providers/parallel.js";
export { tavilyProvider } from "./providers/tavily.js";

/** Create a fresh, agent/runtime-scoped manager with the standard providers registered. */
export function createConfiguredProviderManager(): ProviderManager {
  const pm = new ProviderManager();
  for (const registration of PROVIDER_REGISTRY) {
    pm.register(registration.create());
  }
  return pm;
}
