/**
 * Tavily Provider — Web search via the Tavily REST API (key required).
 *
 * Tavily has no free transport: without a configured Tavily key the provider reports unavailable
 * and is never selected. The REST `POST /search` endpoint is used rather than Tavily's MCP
 * endpoint because the MCP server requires a session handshake (it rejects a bare
 * `tools/call` with "Missing mcp-session-id header"), which a single-shot search does not need.
 *
 * @see https://docs.tavily.com/documentation/api-reference/endpoint/search
 */

import { getEnv } from "../../../../../../env";
import { createTimeoutAbort } from "../../../../shared/abort-timeout.js";
import { DEFAULT_MAX_BODY_BYTES, readBodyTextBounded } from "../../fetch/bounded-body.js";
import { filterResultsByDomain } from "../domain-filter.js";
import { getProviderManager } from "../provider.js";

import type { SearchProvider, SearchResult, SearchOptions } from "../types.js";

// ============================================================================
// Constants
// ============================================================================

const PROVIDER_NAME = "tavily";
const TAVILY_SEARCH_API = "https://api.tavily.com/search";

// ============================================================================
// Response Types
// ============================================================================

interface TavilySearchResponse {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
  }>;
}

// ============================================================================
// Tavily Provider
// ============================================================================

export const tavilyProvider: SearchProvider = {
  name: PROVIDER_NAME,

  isAvailable(options?: SearchOptions): boolean {
    return Boolean(options?.getApiKey?.(PROVIDER_NAME) ?? getProviderManager().getApiKey(PROVIDER_NAME));
  },

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const apiKey = options?.getApiKey?.(PROVIDER_NAME) ?? getProviderManager().getApiKey(PROVIDER_NAME);
    if (!apiKey) {
      throw new Error("Tavily API key not configured. Pass toolConfig.websearch.tavilyApiKey when creating the agent.");
    }

    const maxResults = options?.maxResults ?? 10;
    const timeoutMs = options?.timeoutMs ?? 30000;
    const { controller, cleanup } = createTimeoutAbort({ timeoutMs, signal: options?.signal });

    try {
      const response = await (options?.coreEnv ?? getEnv()).fetch(TAVILY_SEARCH_API, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          query,
          max_results: Math.min(maxResults, 20),
          search_depth: "basic",
        }),
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error("Tavily Search API: invalid or expired API key");
        }
        if (response.status === 429) {
          throw new Error("Tavily Search API: rate limit exceeded");
        }
        throw new Error(`Tavily Search API failed with status: ${response.status}`);
      }

      // `JSON.parse` over a BOUNDED body, not `response.json()` (see `readBodyBounded`).
      const data = JSON.parse(await readBodyTextBounded(response, DEFAULT_MAX_BODY_BYTES)) as TavilySearchResponse;
      let results: SearchResult[] = (data.results ?? [])
        .map((r) => ({
          title: r.title?.trim() || r.url || "",
          url: r.url?.trim() || "",
          snippet: r.content?.replace(/\s+/g, " ").trim() || "",
        }))
        .filter((r) => r.title && r.url);

      results = filterResultsByDomain(results, options?.allowedDomains, options?.blockedDomains);

      if (options?.maxResults && results.length > options.maxResults) {
        results = results.slice(0, options.maxResults);
      }
      return results;
    } finally {
      cleanup();
    }
  },
};
