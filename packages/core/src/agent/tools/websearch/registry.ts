/**
 * Provider registry — the single declaration of which search providers exist, in what
 * order they are preferred, and which config key enables each.
 *
 * The table is the only place "add a provider" touches: `initializeProviders` registers
 * `create` in listed order, and `ProviderManager` reads availability + keys by name.
 * Selection and fallback logic live in `provider.ts` and must not need edits to add a
 * provider.
 */

import { braveProvider } from "./providers/brave.js";
import { duckduckgoProvider } from "./providers/duckduckgo.js";
import { exaProvider } from "./providers/exa.js";
import { parallelProvider } from "./providers/parallel.js";
import { tavilyProvider } from "./providers/tavily.js";

import type { SearchProvider } from "./types.js";

export interface ProviderRegistration {
  /** Unique provider name (also the `toolConfig.websearch.provider` value). */
  name: string;
  /** Factory for the provider instance. */
  create: () => SearchProvider;
}

/**
 * Ordered provider table. Order is preference order for the fixed-priority path; free
 * providers are additionally spread by session id (see `ProviderManager.selectProvider`),
 * and the last entry is the unconditional fallback.
 *
 * Which config field holds a provider's API key is NOT here: it lives in
 * {@link PROVIDER_KEY_FIELDS} (`key-fields.ts`), the single source `ProviderManager.configure`
 * reads, so a keyed provider needs no third place to stay in sync.
 *
 * - `brave`      — keyed official API (fast path when a key is configured)
 * - `parallel`   — free public MCP (keyed tier with key)
 * - `exa`        — free public MCP (keyed tier with key)
 * - `tavily`     — keyed official API only (unavailable without a key)
 * - `duckduckgo` — free HTML scrape, last-resort
 */
export const PROVIDER_REGISTRY: readonly ProviderRegistration[] = [
  { name: "brave", create: () => braveProvider },
  { name: "parallel", create: () => parallelProvider },
  { name: "exa", create: () => exaProvider },
  { name: "tavily", create: () => tavilyProvider },
  { name: "duckduckgo", create: () => duckduckgoProvider },
];
