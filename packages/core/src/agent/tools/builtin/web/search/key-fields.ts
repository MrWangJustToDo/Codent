/**
 * Provider → API-key field wiring, in its own dependency-free module.
 *
 * This is the single source for "which config field holds provider X's key". It lives apart
 * from both `provider.ts` (which consumes it at selection time) and `registry.ts` (which
 * re-exports it as `keyField` metadata) because `registry.ts` imports the provider modules,
 * which import `provider.ts` — so a direct edge from `provider.ts` to `registry.ts` would
 * close a module cycle. Neither consumer duplicates the mapping.
 */

import type { WebsearchToolConfig } from "../../../tool-config.js";

/** Provider name → the `WebsearchToolConfig` field carrying its API key. */
export const PROVIDER_KEY_FIELDS: Record<string, keyof WebsearchToolConfig> = {
  brave: "braveApiKey",
  parallel: "parallelApiKey",
  exa: "exaApiKey",
  tavily: "tavilyApiKey",
};
